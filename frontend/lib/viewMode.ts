import type { Alert, LightningApproach, Site } from "@shared/types";

/** What this device is looking at: today's live picture (the default) or a storm replay. Per device
 *  (localStorage), never global: starting a replay switches only the device that started it. */
export type ViewMode = "live" | "replay";

export const VIEW_MODE_KEY = "planit-control.view-mode";

export function readViewMode(): ViewMode {
  try { return window.localStorage.getItem(VIEW_MODE_KEY) === "replay" ? "replay" : "live"; }
  catch { return "live"; }
}

export function writeViewMode(mode: ViewMode) {
  try { window.localStorage.setItem(VIEW_MODE_KEY, mode); }
  catch { /* The mode still lives in React state when storage is blocked. */ }
}

/** Alerts for a view. Live: real alerts only (replay ones never show). Replay: the replay's alerts drive
 *  the map and site list, and every real alert is pinned on top so live safety is never hidden. */
export function alertsForView(alerts: Alert[], mode: ViewMode): { shown: Alert[]; pinned: Alert[] } {
  const real = alerts.filter((alert) => !alert.replay);
  return mode === "live" ? { shown: real, pinned: [] } : { shown: alerts.filter((alert) => alert.replay), pinned: real };
}

/** One layer per view: Live draws real points only, Replay draws the replay's only. */
export function layerForView<T>(items: T[], mode: ViewMode, isReplay: (item: T) => boolean): T[] {
  return items.filter((item) => isReplay(item) === (mode === "replay"));
}

/** A site as a view sees it. Live: no replay advisory, the live index. Replay: the replay advisory only
 *  (a real one is pinned instead) and the index with the replay's overrides. */
export function siteForView(site: Site, mode: ViewMode): Site {
  const approach: LightningApproach | null = site.lightning_approach && (site.lightning_approach.replay === (mode === "replay")) ? site.lightning_approach : null;
  return mode === "live"
    ? { ...site, lightning_approach: approach }
    : { ...site, lightning_approach: approach, hazard_index_live: site.hazard_index, replay_override: false };
}

/** Real advisories to pin in Replay view (a real stop-work at the site makes its advisory moot). */
export function pinnedApproaches(sites: Site[], realAlerts: Alert[]): Site[] {
  const stopped = new Set(realAlerts.filter((alert) => alert.type === "lightning").map((alert) => alert.site_id));
  return sites.filter((site) => site.lightning_approach && !site.lightning_approach.replay && !stopped.has(site.id));
}
