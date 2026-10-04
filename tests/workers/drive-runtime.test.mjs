import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";

test("Drive OAuth and refresh complete in actual workerd + D1; redirects and replay stay blocked", async () => {
  const built = await build({entryPoints:["tests/workers/drive-fixture.ts"],bundle:true,write:false,format:"esm",platform:"neutral",target:"es2022",external:["node:*","cloudflare:*"],conditions:["workerd","worker","browser"]});
  const authDDL=(await readFile("backend/migrations/platform/0001_initial.sql","utf8")).match(/^CREATE TABLE "(?:account|user|session|verification|rateLimit)" .+;/gm);
  // The lockfile's workerd supports dates through 2026-09-28. Release checks
  // override this with the deployment date and a matching MINIFLARE_WORKERD_PATH.
  const compatibilityDate=process.env.WORKER_TEST_COMPATIBILITY_DATE || "2026-09-28";
  const mf = new Miniflare(convertV4MiniflareOptions({name:"drive-runtime-test",modules:true,script:built.outputFiles[0].text,compatibilityDate,compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],bindings:{AUTH_DDL:JSON.stringify(authDDL)},cf:false}));
  try {
    const response=await mf.dispatchFetch("https://fixture.example/test");
    const body=await response.text();
    assert.equal(response.status,200,body);
    const result=JSON.parse(body);
    assert.equal(result.ok,true);
    assert.equal(result.checks.length,8);
    console.log(JSON.stringify({...result,compatibilityDate}));
  } finally { await mf.dispose(); }
});
