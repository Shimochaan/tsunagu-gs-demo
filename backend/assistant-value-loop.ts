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
// Detection/drafting/staff notice only. Customer delivery remains a separate human-approved path.
export async function runValueLoop(rt: Runtime, t: string, oa: string) {
  const lease = await claimAssistantOA(rt, t, oa);
  if (!lease) return { skipped: "leased" };
  const db = await rt.openDatabase(t, oa, "tsunagu");
  let failed = false;
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
    await step("self_demo",()=>processDemoWork(rt));
    await step("self_demo_bookings",()=>reconcileDemoBookings(rt));
    await step("calendar_sync",()=>pollCalendars(rt,t,oa));
    await step("meetings_sync",()=>pollDrive(rt,{tenant:t,oa}));
    await step("meeting_analysis",()=>processMeetingUpdates(rt,t,oa));
    const sheet = await step("sheet", () => syncPropertySheet(rt, t, oa));
    await step("sources", () => refreshAssistantSources(rt, t, oa));
    if (rt.assistantResearchEnabled)
      await step("research", () => runDailyResearch(rt, t, oa));
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
    return { sheet, work, issues };
  } finally {
    await finishAssistantOA(rt, t, oa, lease, failed);
  }
}
