import type { Alert, FloodConditions, Site } from "@shared/types";

/** Always round down: an in-range strike must never appear to be 10 miles away. */
export function formatStrikeDistance(distance: Alert["last_strike_distance_mi"]): string | null {
  if (distance === null || !Number.isFinite(distance) || distance < 0) return null;
  return `${(Math.floor(distance * 10) / 10).toFixed(1)} mi`;
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
  return conditions.reading?.trim() || conditions.source?.trim() || "Reason unavailable";
}
