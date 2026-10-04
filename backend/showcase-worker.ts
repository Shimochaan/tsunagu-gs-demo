import { D1Store } from "./db.ts";
import { makeAuth } from "./auth.ts";
import type { Runtime } from "./runtime.ts";
import { AppError } from "./security.ts";
import {
  showcaseFetch,
  SHOWCASE_TENANT,
  SHOWCASE_OA,
  SHOWCASE_MESSAGE,
} from "./showcase.ts";

type Env = ShowcaseBindings & { AUTH_SECRET: string; CREDENTIAL_KEY: string };
export function showcaseRuntime(env: Env): Runtime {
  const db = new D1Store(env.PLATFORM_DB);
  const disabled = async (): Promise<never> => {
    throw new AppError(403, "SHOWCASE_READ_ONLY", SHOWCASE_MESSAGE);
  };
  return {
    showcase: true,
    db,
    origin: env.APP_ORIGIN,
    auth: makeAuth({
      database: env.PLATFORM_DB,
      db,
      origin: env.APP_ORIGIN,
      secret: env.AUTH_SECRET,
      publicShowcase: true,
      sendMail: disabled,
    }),
    key: env.CREDENTIAL_KEY,
    keyVersion: "v1",
    local: false,
    googleEnabled: false,
    mailMode: "unconfigured",
    deliveryEnabled: false,
    provisioningEnabled: false,
    assistantSimulation: true,
    assistantManualOnly: true,
    assistantResearchEnabled: false,
    assistantResearchManualOnly: true,
    driveManualOnly: true,
    sendMail: disabled,
    externalFetch: disabled,
    provisionDatabase: disabled,
    deployTenant: disabled,
    assets: env.ASSETS,
    async openDatabase(tenant, oa, purpose) {
      if (
        tenant !== SHOWCASE_TENANT ||
        (purpose === "common"
          ? oa !== "" && oa !== SHOWCASE_OA
          : oa !== SHOWCASE_OA)
      )
        throw new AppError(404, "NOT_FOUND", "見学用企業が見つかりません。");
      return new D1Store(
        purpose === "common"
          ? env.SHOWCASE_COMMON_DB
          : purpose === "harness"
            ? env.SHOWCASE_HARNESS_DB
            : env.SHOWCASE_STUDIO_DB,
      );
    },
  };
}
export default {
  fetch(request: Request, env: Env) {
    return showcaseFetch(request, showcaseRuntime(env));
  },
};
