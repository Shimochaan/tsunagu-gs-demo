import { demoLiveState, notifyDemoMeetings } from "./demo-meeting-line.ts";
import { processDemoSheetWrites } from "./demo-sheet-sync.ts";
import { processDemoWork } from "./self-demo.ts";
import { reconcileDemoBookings } from "./self-demo-booking.ts";
import { pollCalendars } from "./calendar.ts";
import { pollDrive } from "./drive.ts";
import { processMeetingUpdates } from "./meeting-automation.ts";
import type { Runtime } from "./runtime.ts";
import {
  claimAssistantOA,
  finishAssistantOA,
  processAssistantWork,
} from "./assistant-work.ts";
import { syncPropertySheet } from "./assistant-sync.ts";
import { runDailyResearch } from "./assistant-research.ts";
import { refreshAssistantSources } from "./assistant-discovery.ts";
import { notifyAssistant } from "./assistant-notifications.ts";
import { recordRun } from "./assistant-controls.ts";
import { one } from "./db.ts";
import { processAssistantDraftRepairs } from "./assistant-draft.ts";
// Detection/drafting/staff notice only. Customer delivery remains a separate human-approved path.
export async function runValueLoop(rt: Runtime, t: string, oa: string) {
  const lease = await claimAssistantOA(rt, t, oa);
  if (!lease) return { skipped: "leased" };
  const db = await rt.openDatabase(t, oa, "tsunagu");
  let failed = false, fast = false;
  const issues: string[] = [];
  try {
    if (
      !(
        await one(
          db,
          "SELECT enabled FROM assistant_settings WHERE id='default'",
        )
      )?.enabled
    )
      return { skipped: "disabled" };
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (e: any) {
        failed = true;
        issues.push(name);
        await recordRun(db, name, "failed", e.code || "FAILED");
        return null;
      }
    };
    const live=await step("demo_live",()=>demoLiveState(rt));
    fast=!!(rt.selfDemo && await one(rt.db,"SELECT user_id FROM gs_demo_participants WHERE state='active' AND tenant_id=? AND notifications_until>? LIMIT 1",[t,new Date().toISOString()]));
    await step("sheet_writes",()=>processDemoSheetWrites(rt));
    await step("self_demo",()=>processDemoWork(rt));
    await step("self_demo_bookings",()=>reconcileDemoBookings(rt));
    await step("calendar_sync",()=>pollCalendars(rt,t,oa));
    await step("meetings_sync",()=>pollDrive(rt,{tenant:t,oa,fast}));
    await step("demo_meeting_notice",()=>notifyDemoMeetings(rt));
    await step("meeting_analysis",()=>processMeetingUpdates(rt,t,oa));
    const sheet = await step("sheet", () => syncPropertySheet(rt, t, oa, fast));
    await step("sources", () => refreshAssistantSources(rt, t, oa));
    if (rt.assistantResearchEnabled)
      await step("research", () => runDailyResearch(rt, t, oa));
    await step("draft_repair", () => processAssistantDraftRepairs(rt, t, oa));
    // One bounded work batch per tick; the durable queue retains the rest.
    const work = await step("matching", () =>
      processAssistantWork(rt, t, oa, {
        shouldYield: (() => {
          const end = Date.now() + 35000;
          return () => Date.now() > end;
        })(),
      }),
    );
    await step("staff_notification", () => notifyAssistant(rt, t, oa));
    if(live) await rt.db.query("UPDATE gs_demo_live_state SET last_sync_at=?,error=? WHERE id=?",[new Date().toISOString(),issues.length?issues.join(','):null,t+':'+oa]);
    return { sheet, work, issues };
  } finally {
    await finishAssistantOA(rt, t, oa, lease, failed && !fast);
  }
}
