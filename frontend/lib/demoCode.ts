// The demo code: the backend's ADMIN_TOKEN, sent as X-Admin-Token on actions that change shared state
// or cost money (start/stop a replay, send all briefings now). Read-only requests never need it.
// Remembered in localStorage when the browser allows it, otherwise for this page load only.

const KEY = "planit-demo-code";
let memory: string | null = null;

export const DEMO_CODE_HEADER = "X-Admin-Token";

export function getDemoCode(): string | null {
  try {
    return window.localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setDemoCode(code: string) {
  memory = code;
  try {
    window.localStorage.setItem(KEY, code);
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
