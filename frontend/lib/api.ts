import type { Alert, ReplayStatus, Site } from "@shared/types";
import mockAlerts from "@shared/mocks/alerts.json";
import mockSites from "@shared/mocks/sites.json";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type GetOptions = {
  /** Default true. Pass false when refreshing live data, so a backend blip can't swap real data for mocks. */
  fallbackToMocks?: boolean;
};

/** GET from the backend; if it's unreachable, fall back to shared/mocks so UI work never blocks on the API. */
async function get<T>(path: string, fallback: unknown, { fallbackToMocks = true }: GetOptions = {}): Promise<T> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (err) {
    if (!fallbackToMocks) throw err;
    console.warn(`[api] ${path} failed (${(err as Error).message}); using shared/mocks`);
    return fallback as T;
  }
}

export const getSites = (options?: GetOptions) => get<Site[]>("/sites", mockSites, options);
export const getAlerts = (options?: GetOptions) => get<Alert[]>("/alerts", mockAlerts, options);
/** Never falls back to mocks: the mock describes a running replay. */
export const getReplayStatus = () => get<ReplayStatus>("/replay/status", null, { fallbackToMocks: false });
