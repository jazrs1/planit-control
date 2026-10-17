import { timeZoneAbbr, timeZoneName } from "@/lib/time";

// Times on a page that names the site's zone once ("Times in Eastern (ET)"), so each time drops it.

function siteDay(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** "5:03 PM" today (site-local), "Oct 16, 5:03 PM" otherwise. With no "now" yet (server render), the date
 *  is always shown. null for a missing or invalid time. */
export function formatPageTime(iso: string | null | undefined, timeZone: string, nowMs: number | null): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const today = nowMs !== null && siteDay(ms, timeZone) === siteDay(nowMs, timeZone);
  return new Date(ms).toLocaleString("en-US", {
    timeZone,
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Eastern (ET)" / "Central (CT)": the zone every time on the page is in. */
export function zoneLabel(timeZone: string) {
  return `${timeZoneName(timeZone).replace(/ time$/, "")} (${timeZoneAbbr(timeZone)})`;
}
