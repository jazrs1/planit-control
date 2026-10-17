// Browser-wide record of whether the backend is answering. Every GET through lib/api.ts reports here,
// so every page agrees on "offline" no matter which request noticed first.
// A response of any status below 500 counts as contact (a 404 still proves the backend is up);
// network errors and 5xx count as failures.

export type ConnectionSnapshot = {
  /** Last time any request got a response from the backend; null if none since the page loaded. */
  lastSuccessAt: number | null;
  /** Set while the most recent result was a failure: when this run of failures started. */
  failingSince: number | null;
};

/** No successful response for this long escalates from "last known" to "status unknown". */
export const OUTAGE_AFTER_MS = 2 * 60_000;

const SERVER_SNAPSHOT: ConnectionSnapshot = { lastSuccessAt: null, failingSince: null };
let snapshot: ConnectionSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

function set(next: ConnectionSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function markSuccess() {
  if (typeof window === "undefined") return; // server renders don't share the browser's connection
  const wasFailing = snapshot.failingSince !== null;
  set({ lastSuccessAt: Date.now(), failingSince: null });
  if (wasFailing) reconnectListeners.forEach((l) => l());
}

export function markFailure() {
  if (typeof window === "undefined") return;
  if (snapshot.failingSince === null) set({ ...snapshot, failingSince: Date.now() });
}

export const subscribeConnection = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getConnectionSnapshot = () => snapshot;
export const getServerConnectionSnapshot = () => SERVER_SNAPSHOT;

/** Called once when requests start succeeding again after failures, so pollers refresh at once. */
export function onReconnect(listener: () => void) {
  reconnectListeners.add(listener);
  return () => { reconnectListeners.delete(listener); };
}

/** When the outage threshold is (or was) crossed for this run of failures; null while connected. */
export function outageStartsAt(s: ConnectionSnapshot, pageLoadedAt: number): number | null {
  if (s.failingSince === null) return null;
  return (s.lastSuccessAt ?? pageLoadedAt) + OUTAGE_AFTER_MS;
}
