import { D1Store, one, now, json } from "./db.ts";
import { makeAuth } from "./auth.ts";
import type { Runtime } from "./runtime.ts";
import { AppError } from "./security.ts";
import {
  showcaseFetch,
  SHOWCASE_TENANT,
  SHOWCASE_OA,
  SHOWCASE_MESSAGE,
} from "./showcase.ts";
import { ShowcaseStore } from "./showcase-database.ts";
import { prepareShowcaseSample } from "./showcase-prepare.ts";
export { ShowcaseDatabase } from "./showcase-database.ts";
type Env = ShowcaseBindings & { AUTH_SECRET: string; CREDENTIAL_KEY: string };
export async function showcaseRuntime(
  env: Env,
  request: Request,
): Promise<Runtime> {
  const authDB = new D1Store(env.PLATFORM_DB);
  const externalDisabled = async (): Promise<never> => {
    throw new AppError(403, "SHOWCASE_EXTERNAL", SHOWCASE_MESSAGE);
  };
  const auth = makeAuth({
    database: env.PLATFORM_DB,
    db: authDB,
    origin: env.APP_ORIGIN,
    secret: env.AUTH_SECRET,
    publicShowcase: true,
    sendMail: externalDisabled,
  });
  const session = await auth.api.getSession({ headers: request.headers });
  const visitor = session?.session.id;
  const makeStore = (
    kind: "platform" | "common" | "harness" | "studio",
    tenant = SHOWCASE_TENANT,
    oa = "",
  ) => {
    if (!visitor)
      throw new AppError(401, "AUTH_REQUIRED", "ログインしてください。");
    const namespace = env.SHOWCASE_DATABASES as unknown as {
      getByName(name: string): ConstructorParameters<typeof ShowcaseStore>[0];
    };
    return new ShowcaseStore(
      namespace.getByName(json([visitor, tenant, oa, kind])),
      kind,
      tenant === SHOWCASE_TENANT &&
        (kind === "platform" || kind === "common" || oa === SHOWCASE_OA),
    );
  };
  const db = visitor ? makeStore("platform") : authDB;
  if (visitor)
    await db.query(
      "INSERT OR IGNORE INTO session_context(session_id,tenant_id,mfa_at) VALUES (?,?,?)",
      [visitor, SHOWCASE_TENANT, now()],
    );
  const rt: Runtime = {
    showcase: true,
    db,
    auth,
    origin: env.APP_ORIGIN,
    key: env.CREDENTIAL_KEY,
    keyVersion: "v1",
    local: false,
    googleEnabled: false,
    mailMode: "unconfigured",
    deliveryEnabled: false,
    provisioningEnabled: true,
    assistantSimulation: true,
    assistantManualOnly: true,
    assistantResearchEnabled: false,
    assistantResearchManualOnly: true,
    driveManualOnly: true,
    assets: env.ASSETS,
    externalFetch: externalDisabled,
    async sendMail(mail) {
      await db.query(
        "CREATE TABLE IF NOT EXISTS showcase_mail (id TEXT PRIMARY KEY,recipient TEXT,subject TEXT,body TEXT,created_at TEXT)",
      );
      await db.query("INSERT INTO showcase_mail VALUES (?,?,?,?,?)", [
        crypto.randomUUID(),
        mail.to,
        mail.subject,
        mail.text,
        now(),
      ]);
    },
    async openDatabase(tenant, oa, purpose) {
      const row = await one(
        db,
        "SELECT id FROM databases WHERE tenant_id=? AND oa_id=? AND purpose=? AND state='ready'",
        [tenant, purpose === "common" ? "" : oa, purpose],
      );
      if (!row)
        throw new AppError(
          409,
          "DATABASE_NOT_READY",
          "データベースの準備中です。",
        );
      return makeStore(
        purpose === "tsunagu" ? "studio" : purpose,
        tenant,
        purpose === "common" ? "" : oa,
      );
    },
    async provisionDatabase(record) {
      const store = makeStore(
        record.purpose === "tsunagu" ? "studio" : record.purpose,
        record.tenant_id,
        record.oa_id,
      );
      await store.query("SELECT 1");
      return "showcase-" + record.id;
    },
    async deployTenant(tenant) {
      await db.query(
        "INSERT INTO tenant_runtimes(tenant_id,url,version,state) VALUES (?,?,1,'ready') ON CONFLICT(tenant_id) DO UPDATE SET version=version+1,state='ready'",
        [tenant, env.APP_ORIGIN],
      );
    },
  };
  if (visitor) await prepareShowcaseSample(rt);
  return rt;
}
export default {
  async fetch(request: Request, env: Env) {
    return showcaseFetch(request, await showcaseRuntime(env, request));
  },
};
