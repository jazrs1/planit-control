// Times are always shown in the site's own timezone, not the viewer's.

export function formatSiteTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "Oct 16, 4:40 PM EDT": for times that may not be today. */
export function formatSiteDateTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "ET" / "CT". The panhandle sites run on Central time. */
export function timeZoneAbbr(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" }).formatToParts();
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "Eastern time" / "Central time", for people rather than code. */
export function timeZoneName(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" }).formatToParts();
  const name = parts.find((p) => p.type === "timeZoneName")?.value;
  return name ? name.replace(/ Time$/, " time") : timeZone;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAgo(ms: number) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}
