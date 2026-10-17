import type { Alert, Site } from "@shared/types";
import mockAlerts from "@shared/mocks/alerts.json";
import mockSites from "@shared/mocks/sites.json";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** GET from the backend; if it's unreachable, fall back to shared/mocks so UI work never blocks on the API. */
async function get<T>(path: string, fallback: unknown): Promise<T> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[api] ${path} failed (${(err as Error).message}); using shared/mocks`);
    return fallback as T;
  }
}

export const getSites = () => get<Site[]>("/sites", mockSites);
export const getAlerts = () => get<Alert[]>("/alerts", mockAlerts);
