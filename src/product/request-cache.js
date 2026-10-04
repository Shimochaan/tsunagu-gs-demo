// Per-tab GET sharing. No persisted data, and no cross-URL fallback while changing tenants.
const listeners = new Map();
export function subscribeData(url, listener) {
  if (!listeners.has(url)) listeners.set(url, new Set());
  listeners.get(url).add(listener);
  return () => { const group=listeners.get(url); group?.delete(listener); if (!group?.size) listeners.delete(url); };
}
function broadcast(url) { for (const listener of listeners.get(url) || []) listener(); }
const cached = new Map(),
  pending = new Map();
export function peekData(url) {
  return cached.get(url);
}
export function invalidateData(prefix) {
  for (const key of new Set([...cached.keys(), ...pending.keys(), ...listeners.keys()])) {
    if (!prefix || key.includes(prefix)) {
      cached.delete(key);
      const request = pending.get(key);
      pending.delete(key);
      request?.controller.abort();
      broadcast(key);
    }
  }
}
export function acquireData(url, load) {
  let entry = pending.get(url);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, promise: null };
    const own = entry;
    entry.promise = Promise.resolve()
      .then(() => load(controller.signal))
      .then((data) => {
        if (controller.signal.aborted || pending.get(url) !== own)
          throw new DOMException("Discarded response", "AbortError");
        cached.set(url, data);
        return data;
      })
      .finally(() => {
        if (pending.get(url) === own) pending.delete(url);
      });
    pending.set(url, entry);
  }
  entry.users++;
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      if (--entry.users === 0 && pending.get(url) === entry) {
        pending.delete(url);
        entry.controller.abort();
      }
    },
  };
}
