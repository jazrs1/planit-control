import type { BriefingKeyNumbers, GoStatus } from "@shared/types";

export const GO_LABEL: Record<GoStatus, string> = { go: "Go", caution: "Caution", no_go: "No-go" };

export const GO_STYLE: Record<GoStatus, string> = {
  go: "bg-risk-green-bg text-risk-green",
  caution: "bg-risk-amber-bg text-risk-amber",
  no_go: "bg-risk-red-bg text-risk-red",
};

export const KEY_NUMBER_LABEL: Record<keyof BriefingKeyNumbers, string> = {
  hazard_index: "Hazard index",
  max_heat_index_f: "Max heat index",
  lightning_probability_pct: "Lightning chance",
  rain_in: "Rain",
  soil_moisture_pct: "Soil moisture",
  wildfire_detections_25mi: "Fires within 25 mi",
};

/** YYYY-MM-DD of `ms` in the site's timezone. */
export function siteDate(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Which day a briefing covers, relative to the site's own calendar.
 *  "today": last night's briefing, still current until tonight's 6 PM run. "old": older than that. */
export function briefingDay(forDate: string, timeZone: string, nowMs: number): "tomorrow" | "today" | "old" | "later" {
  const today = siteDate(nowMs, timeZone);
  if (forDate === addDays(today, 1)) return "tomorrow";
  if (forDate === today) return "today";
  return forDate < today ? "old" : "later";
}

/** "Sat, Oct 17" for a YYYY-MM-DD date (a calendar date, so no timezone shift). */
export function formatForDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
