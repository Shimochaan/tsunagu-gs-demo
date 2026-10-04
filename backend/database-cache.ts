import type { Runtime } from "./runtime.ts";
/** Lifetime is one request / cron unit, never a process-wide authorization cache. */
export function cachedDatabaseOpener(
  open: Runtime["openDatabase"],
): Runtime["openDatabase"] {
  const entries = new Map<string, ReturnType<Runtime["openDatabase"]>>();
  return (tenant, oa, purpose) => {
    const key = JSON.stringify([tenant, oa, purpose]);
    let pending = entries.get(key);
    if (!pending) {
      pending = open(tenant, oa, purpose);
      entries.set(key, pending);
      pending.catch(() => {
        if (entries.get(key) === pending) entries.delete(key);
      });
    }
    return pending;
  };
}
export function databaseScope(rt: Runtime): Runtime {
  return {
    ...rt,
    openDatabase: cachedDatabaseOpener(rt.openDatabase.bind(rt)),
  };
}
