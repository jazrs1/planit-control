import type { Briefing, HazardCard, Site } from "@shared/types";

export const CREW_SITE_KEY = "planit-control.crew-site";

export function rememberedSite(): string {
  try { return window.localStorage.getItem(CREW_SITE_KEY) ?? ""; }
  catch { return ""; }
}

export function rememberSite(id: Site["id"]) {
  try { window.localStorage.setItem(CREW_SITE_KEY, id); }
  catch { /* The selected site still lives in React state when storage is blocked. */ }
}

export function chooseCrewSite(sites: Site[], preferred: string): Site | undefined {
  return sites.find((site) => site.id === preferred) ?? [...sites].sort((a, b) => a.name.localeCompare(b.name))[0];
}

export function hasReading(card: HazardCard | null | undefined): boolean {
  return !!card?.hazard_status && !!card.as_of;
}

/** Calendar arithmetic in the site's zone, including DST and month/year boundaries. */
export function tomorrowAtSite(now: number, timezone: Site["timezone"]) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(value("year"), value("month") - 1, value("day") + 1)).toISOString().slice(0, 10);
}

export function briefingHeadline(briefing: Briefing) {
  const headline = briefing.headline?.trim() || briefing.text.split(/\n|(?<=\.)\s/)[0].trim() || "Headline unavailable";
  // Template headlines follow "GO for <day>: " in the text, so they start lowercase on their own.
  return headline.charAt(0).toUpperCase() + headline.slice(1);
}
