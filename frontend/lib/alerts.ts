import type { Alert, FloodConditions, Site } from "@shared/types";

/** Always round down: an in-range strike must never appear to be 10 miles away. Whole miles from 10 up. */
export function formatStrikeDistance(distance: Alert["last_strike_distance_mi"]): string | null {
  if (distance === null || !Number.isFinite(distance) || distance < 0) return null;
  return distance >= 10 ? `${Math.floor(distance)} mi` : `${(Math.floor(distance * 10) / 10).toFixed(1)} mi`;
}

/** One decimal under 10 mi, whole miles from 10 up: "9.6 mi", "100 mi". null when there's no distance. */
export function formatMiles(distance: number | null | undefined): string | null {
  if (distance === null || distance === undefined || !Number.isFinite(distance) || distance < 0) return null;
  const tenths = Math.round(distance * 10) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)} mi` : `${Math.round(distance)} mi`;
}

/** Real alerts only. Counts never mix real and replay: replay counts belong on the replay timeline. */
export function realAlerts(alerts: Alert[]) {
  return alerts.filter((alert) => !alert.replay);
}

/** A site's alert of one type, preferring the real one: when a site has a real and a replay stop-work,
 *  the real one wins (real look, red, real countdown). /alerts lists replay alerts first. */
export function siteAlert(alerts: Alert[] | null | undefined, siteId: string, type: Alert["type"]): Alert | undefined {
  const mine = (alerts ?? []).filter((alert) => alert.site_id === siteId && alert.type === type);
  return mine.find((alert) => !alert.replay) ?? mine[0];
}

export function countAlerts(alerts: Alert[]) {
  const lightning = alerts.filter((alert) => alert.type === "lightning").length;
  const flood = alerts.filter((alert) => alert.type === "flood").length;
  return { lightning, flood, other: alerts.length - lightning - flood };
}

export function formatAlertTime(started_at: Alert["started_at"], timezone?: Site["timezone"]) {
  if (!Number.isFinite(Date.parse(started_at))) return "Time unavailable";
  return new Date(started_at).toLocaleString("en-US", {
    timeZone: timezone ?? "UTC", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

export function floodReason(conditions?: FloodConditions): string {
  if (!conditions?.hazard_status || !conditions.as_of) return "Reason unavailable";
  const reason = conditions.reading?.trim() || conditions.source?.trim() || "Reason unavailable";
  // The banner already says FLOOD RISK; the card reading may start with "Flood risk: ".
  return reason.replace(/^flood risk:\s*/i, "").replace(/^./, (c) => c.toUpperCase());
}
