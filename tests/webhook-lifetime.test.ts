import test from "node:test";
import assert from "node:assert/strict";
import { retainStaffWebhook } from "../backend/webhook-lifetime.ts";

test("staff webhook retains one in-flight operation after the caller disconnects", async () => {
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const held: Promise<unknown>[] = [];
  const returned = retainStaffWebhook(new Request("https://example.test/webhooks/staff-line"), work, {waitUntil: p => { held.push(p); }});
  assert.equal(returned, work, "no replacement or replay of the original send");
  assert.equal(held.length, 1);
  // Simulate the HTTP consumer disappearing; only the execution context awaits.
  finish();
  await held[0];
});

test("ordinary requests and local runtimes retain their existing lifetime", async () => {
  const held: Promise<unknown>[] = [];
  const work = Promise.resolve("ok");
  assert.equal(await retainStaffWebhook(new Request("https://example.test/api/read"), work, {waitUntil: p => { held.push(p); }}), "ok");
  assert.equal(await retainStaffWebhook(new Request("https://example.test/webhooks/staff-line"), work), "ok");
  assert.equal(held.length, 0);
});

test("TimeRex webhook retains the same booking operation without replaying it", async () => {
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  const held: Promise<unknown>[] = [];
  assert.equal(retainStaffWebhook(new Request("https://example.test/webhooks/timerex/demo"), work, {waitUntil: p => {held.push(p);}}),work);
  assert.equal(held.length,1);
  finish();
  await held[0];
});
