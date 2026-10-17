// The demo code: the backend's ADMIN_TOKEN, sent as X-Admin-Token on actions that change shared state
// or cost money (start/stop a replay, send all briefings now). Read-only requests never need it.
// Remembered on this device for 24 hours (localStorage when the browser allows it, otherwise for this
// page load only). A wrong code is cleared by the next 401, so only an accepted code is kept. It's sent
// only as the X-Admin-Token header on the existing protected requests (lib/api.ts), never elsewhere.

const KEY = "planit-demo-code";
/** How long an entered code is remembered on the device. */
export const DEMO_CODE_TTL_MS = 24 * 60 * 60_000;
type Stored = { code: string; savedAt: number };
let memory: Stored | null = null;

export const DEMO_CODE_HEADER = "X-Admin-Token";

function fresh(stored: Stored | null, now = Date.now()): string | null {
  return stored && now - stored.savedAt < DEMO_CODE_TTL_MS ? stored.code : null;
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    return typeof value.code === "string" && typeof value.savedAt === "number" ? { code: value.code, savedAt: value.savedAt } : null;
  } catch {
    return null; // An older plain-text entry has no time: it's treated as expired.
  }
}

export function getDemoCode(now = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const code = fresh(raw === null ? memory : parse(raw), now);
    if (raw !== null && code === null) window.localStorage.removeItem(KEY);
    return code;
  } catch {
    return fresh(memory, now);
  }
}

export function setDemoCode(code: string, now = Date.now()) {
  memory = { code, savedAt: now };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Private window or blocked storage: keep it in memory for this page load.
  }
}

export function clearDemoCode() {
  memory = null;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

/** Headers for a protected request: the demo code if one has been entered. */
export function demoCodeHeaders(): Record<string, string> {
  const code = getDemoCode();
  return code ? { [DEMO_CODE_HEADER]: code } : {};
}
