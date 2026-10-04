import { test } from "node:test";
import assert from "node:assert/strict";
import { activationReadiness, setupEnvironment } from "../backend/setup-readiness.ts";
import type { Runtime } from "../backend/runtime.ts";
import { assistantFixture } from "./helpers/assistant-fixture.ts";

const rt = {local:false,deliveryEnabled:true} as Runtime;
const tenant = {id:"tenant",settings:JSON.stringify({retentionDays:365})};
const account = {id:"oa",owner_user_id:"owner",webhook_verified_at:"2026-10-04",calibration_ready:1,preview_ready:1};
const dbs = [
  {tenant_id:"tenant",oa_id:"",purpose:"common",state:"ready",physical_id:"common"},
  {tenant_id:"tenant",oa_id:"oa",purpose:"harness",state:"ready",physical_id:"harness"},
  {tenant_id:"tenant",oa_id:"oa",purpose:"tsunagu",state:"ready",physical_id:"tsunagu"},
];
const connections = [{tenant_id:"tenant",oa_id:"oa",service:"harness",state:"connected"}];
test("activation needs the exact three databases in this tenant/account, not any three ready rows",()=>{
  assert.equal(activationReadiness(rt,tenant,account,dbs,connections).canActivate,true);
  for(const invalid of [
    [dbs[0],dbs[1],{...dbs[2],tenant_id:"other"}],
    [dbs[0],dbs[1],{...dbs[2],oa_id:"other"}],
    [dbs[0],dbs[1],{...dbs[2],physical_id:null}],
    [dbs[0],dbs[1],dbs[1]],
  ]) assert.ok(activationReadiness(rt,tenant,account,invalid,connections).missing.includes("databases"));
});
test("setup shows every unmet activation condition and identifies who can fix it",()=>{
  const result=activationReadiness(rt,{...tenant,settings:"{}"},{id:"oa"},[],[]);
  assert.equal(result.canActivate,false);
  assert.deepEqual(result.missing,["retention","owner","databases","webhook","harness","preview","style"]);
  assert.ok(result.checks.filter(c=>!c.ready).every(c=>c.owner && c.detail && Number.isInteger(c.step)));
  assert.equal(activationReadiness(rt,tenant,account,dbs,[{...connections[0],oa_id:"other"}]).canActivate,false);
});
test("explicit unlimited retention is configured while absent or invalid retention remains incomplete",()=>{
  for(const retentionDays of [null,1,3650]) {
    assert.ok(!activationReadiness(rt,{...tenant,settings:JSON.stringify({retentionDays})},account,dbs,connections).missing.includes("retention"));
  }
  for(const retentionDays of [undefined,0,-1,3651,"365",1.5]) {
    assert.ok(activationReadiness(rt,{...tenant,settings:JSON.stringify({retentionDays})},account,dbs,connections).missing.includes("retention"));
  }
});
test("test-only delivery and globally stopped delivery cannot masquerade as normal activation",()=>{
  for(const runtime of [{...rt,harnessReadOnly:true},{...rt,deliveryEnabled:false}]) {
    const result=activationReadiness(runtime,tenant,account,dbs,connections);
    assert.deepEqual(result.missing,["delivery"]);
    assert.equal(result.canActivate,false);
  }
  assert.equal(setupEnvironment({...rt,harnessReadOnly:true,assistantManualOnly:true}).detection,"manual");
  assert.equal(setupEnvironment({...rt,harnessReadOnly:true}).delivery,"test_only");
  assert.equal(setupEnvironment({...rt,local:true}).mail,"local");
  assert.equal(setupEnvironment(rt).mail,"unconfigured");
});
test("assistant settings identifies manual detection without running AI or notifications",async()=>{
  const f=await assistantFixture();
  try {
    f.rt.assistantManualOnly=true;
    const r=await f.request("/api/tenants/t/accounts/oa/assistant?scope=settings");
    assert.equal(r.status,200);
    assert.equal(r.data.detectionMode,"manual");
    assert.equal(f.calls.length,0);
  } finally {await f.dispose();}
});
