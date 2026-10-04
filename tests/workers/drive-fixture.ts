// Local workerd test entrypoint only. Never imported by a deployed Worker.
import { Hono } from "hono";
import { D1Store } from "../../backend/db.ts";
import { platformSchema } from "../../backend/schema.ts";
import { registerDrive, driveScope } from "../../backend/drive.ts";
import { isolatedIntegrationRuntime } from "../../backend/gs-integration.ts";
import { makeWorkerRuntime } from "../../backend/worker.ts";
import { workerFetch } from "../../backend/worker-fetch.ts";
import type { AppEnv } from "../../backend/runtime.ts";
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
export default {
  async fetch(_request: Request, env: any) {
    let legacyError = "";
    try { new Request("https://oauth2.googleapis.com/token", { redirect: "error" }); }
    catch (e) { legacyError = (e as Error).name; }
    const db = new D1Store(env.DB);
    for (const sql of JSON.parse(env.AUTH_DDL)) await db.query(sql);
    for (const sql of platformSchema) await db.query(sql);
    await db.query("INSERT INTO tenants(id,name,created_at,state) VALUES ('tenant','Fixture',datetime('now'),'active')");
    await db.query("INSERT INTO memberships(tenant_id,user_id,roles) VALUES ('tenant','owner','[\"org_owner\"]')");
    await db.query("INSERT INTO accounts(id,tenant_id,name,kind,origin,state,created_at) VALUES ('oa','tenant','Fixture','sales','https://fixture.example','ready',datetime('now'))");
    const calls: string[] = [];
    const provider: typeof fetch = async (input, init) => {
      const r = new Request(input, init), u = new URL(r.url);
      check(r.redirect === "manual", "Provider must not follow redirects");
      calls.push(u.pathname);
      if (u.hostname === "oauth2.googleapis.com") {
        const form = new URLSearchParams(await r.text());
        check(form.get("client_secret") === "fixture-secret", "Form survives normalization");
        check(r.headers.get("content-type")?.includes("application/x-www-form-urlencoded"), "Form content type survives");
        return Response.json({access_token:"fixture-access",refresh_token:"fixture-refresh",scope:driveScope});
      }
      if (u.hostname === "openidconnect.googleapis.com") return Response.json({email:"fixture@example.com",email_verified:true});
      if (u.hostname === "www.googleapis.com") return Response.json({files:[{id:"folder",name:"Fixture folder"}]});
      return new Response(null, {status:302,headers:{location:"https://never-follow.example"}});
    };
    const base = makeWorkerRuntime({ ...env, PLATFORM_DB:env.DB, APP_ORIGIN:"https://fixture.example", AUTH_SECRET:"fixture-auth-secret-that-is-at-least-32-chars", CREDENTIAL_KEY:btoa("12345678901234567890123456789012"), GOOGLE_CLIENT_ID:"fixture-client", GOOGLE_CLIENT_SECRET:"fixture-secret" });
    base.externalFetch = workerFetch(provider);
    const rt = isolatedIntegrationRuntime(base, {tenant:"tenant",oa:"oa",common:db,harness:db,tsunagu:db,allowGoogle:true,allowOpenAI:true});
    const app = new Hono<AppEnv>();
    app.use("*", async(c,next) => { c.set("principal",{user:{id:"owner"},sessionId:c.req.header("x-session") || "fixture-session"} as any); c.set("membership",{user_id:"owner",roles:'["org_owner"]'}); await next(); });
    registerDrive(app);
    const request = (path:string, init?:RequestInit) => app.request(path,init,{runtime:rt});
    const root="/api/tenants/tenant/accounts/oa/connectors/drive";
    const authorized = await request(root+"/authorize",{method:"POST"});
    check(authorized.ok,"Authorize succeeded");
    const auth:any = await authorized.json();
    const state = new URL(auth.url).searchParams.get("state");
    const callback=`/api/drive/callback?state=${state}&code=fixture-code`;
    const wrong = await request(callback,{headers:{"x-session":"different"}});
    check(wrong.headers.get("location")?.includes("OAUTH_STATE"),"Wrong session rejected");
    const connected = await request(callback);
    check(connected.headers.get("location") === "/sales/connections?tenant=tenant&oa=oa&drive=connected", "Callback succeeded: "+connected.headers.get("location"));
    const replay = await request(callback);
    check(replay.headers.get("location")?.includes("OAUTH_STATE"),"Replay rejected");
    const folders=await request(root+"/folders");
    check(folders.ok && (await folders.json() as any).files[0].id === "folder","Refresh and Drive read succeeded");
    const saved=await db.query("SELECT ciphertext FROM credentials");
    check(saved.rows.length===1 && !saved.rows[0].ciphertext.includes("fixture-refresh"),"Credential encrypted in D1");
    const status=await request(root);
    check(!(await status.text()).includes("fixture-refresh"),"Secret absent from status");
    let redirectsBlocked=0;
    for(const transport of [base.externalFetch,rt.externalFetch]) {
      try { await transport("https://api.openai.com/v1/responses",{method:"POST",redirect:"error"}); }
      catch { redirectsBlocked++; }
    }
    check(redirectsBlocked===2,"Both worker adapters block redirects");
    return Response.json({ok:true,legacyError,checks:["callback","session","replay","D1 encryption","refresh","Drive read","secret redaction","redirect rejection"],providerCalls:calls.length});
  }
};
