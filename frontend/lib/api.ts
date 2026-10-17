import type { Alert, ApiError, LightningFlash, ReplayStatus, Site, StartReplayRequest } from "@shared/types";
import mockAlerts from "@shared/mocks/alerts.json";
import mockLightning from "@shared/mocks/lightning_recent.json";
import mockSites from "@shared/mocks/sites.json";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Request the backend and throw if it's unreachable or returns an error. Never falls back to mocks:
 *  safety data the UI can't verify must show as unknown, not as sample values. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** For server components: null when the backend can't be reached, so the page renders an unknown state. */
export async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[api] ${(err as Error).message}`);
    return null;
  }
}

export const getSites = () => request<Site[]>("/sites");
export const getAlerts = () => request<Alert[]>("/alerts");
export const getLightningRecent = (minutes = 15) => request<LightningFlash[]>(`/lightning/recent?minutes=${minutes}`);
export const getReplayStatus = () => request<ReplayStatus>("/replay/status");
export const startReplay = (body: StartReplayRequest = {}) =>
  request<ReplayStatus>("/replay/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const stopReplay = () => request<ReplayStatus>("/replay/stop", { method: "POST" });

/** shared/mocks, for the explicit "Demo data" mode only. Anything showing these must say so. */
export const DEMO_DATA = {
  sites: mockSites as Site[],
  alerts: mockAlerts as Alert[],
  lightning: mockLightning as LightningFlash[],
};
