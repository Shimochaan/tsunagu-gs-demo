import type { Runtime } from "./runtime.ts";
import { editAssistant } from "./assistant.ts";
import { generateAssistantDraft } from "./assistant-draft.ts";
export async function rewriteAssistant(
  rt: Runtime,
  tenant: string,
  oa: string,
  actor: string,
  pid: string,
  version: number,
  instruction: string,
  _eventId: string,
) {
  if (instruction.startsWith("本文\n")) {
    await editAssistant(
      rt,
      tenant,
      oa,
      actor,
      pid,
      version,
      instruction.slice(3).trim(),
    );
    return;
  }
  await generateAssistantDraft(
    rt,
    tenant,
    oa,
    actor,
    pid,
    version,
    instruction,
  );
}
