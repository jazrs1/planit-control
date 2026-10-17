import type { Site } from "@shared/types";
import { liveHazardIndex, riskLevel } from "@/lib/risk";

// Finding a site: search by name or county, risk groups for the dashboard list, and the nearest plant
// for the crew view. Groups are real only: a replay never makes a site "Stop work" or "High" here (its
// index is hazard_index_live, without replay overrides), so the list's counts match the dashboard's.

export type SiteFilter = "all" | "stop" | "high" | "elevated" | "low";
export const SITE_FILTERS: SiteFilter[] = ["all", "stop", "high", "elevated", "low"];
export const SITE_FILTER_LABEL: Record<SiteFilter, string> = { all: "All", stop: "Stop work", high: "High", elevated: "Elevated", low: "Low" };

/** Lowercase, accents and punctuation folded to spaces: "Crist " / "crist", "St. Lucie" / "st lucie". */
function fold(text: string) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Every typed word must start a word of the plant name or county ("big b", "hills", "gulf clean"). */
export function siteMatches(site: Pick<Site, "name" | "county">, query: string): boolean {
  const words = fold(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = ` ${fold(site.name)} ${fold(site.county)} ${fold(`${site.county} County`)}`;
  return words.every((word) => haystack.includes(` ${word}`));
}

/** The site's band in the list: its live risk band. A real stop-work site is "stop" as well (it is also high:
 *  a real stop-work raises today's index to at least 9). */
export function siteBand(site: Site): Exclude<SiteFilter, "all" | "stop"> {
  const level = riskLevel(liveHazardIndex(site));
  return level === "red" ? "high" : level === "amber" ? "elevated" : "low";
}

export function inFilter(site: Site, filter: SiteFilter, realStops: ReadonlySet<string>): boolean {
  if (filter === "all") return true;
  if (filter === "stop") return realStops.has(site.id);
  return siteBand(site) === filter;
}

export function filterCounts(sites: Site[], realStops: ReadonlySet<string>): Record<SiteFilter, number> {
  const counts: Record<SiteFilter, number> = { all: sites.length, stop: 0, high: 0, elevated: 0, low: 0 };
  for (const site of sites) {
    if (realStops.has(site.id)) counts.stop++;
    counts[siteBand(site)]++;
  }
  return counts;
}

/** What the list shows. `shown` keeps the incoming order (the dashboard's ranking). By default (All, no
 *  search) low-risk sites without a real stop-work collapse into `low`; a search or another filter shows
 *  every match. */
export function siteListView(sites: Site[], options: { query: string; filter: SiteFilter; realStops: ReadonlySet<string> }) {
  const searching = fold(options.query) !== "";
  const matches = sites.filter((site) => inFilter(site, options.filter, options.realStops) && siteMatches(site, options.query));
  if (searching || options.filter !== "all") return { shown: matches, low: [] as Site[] };
  const isLow = (site: Site) => siteBand(site) === "low" && !options.realStops.has(site.id);
  return { shown: matches.filter((site) => !isLow(site)), low: matches.filter(isLow) };
}

const EARTH_RADIUS_MI = 3958.8;

/** Great-circle distance in miles. */
export function distanceMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The plant nearest to a position, computed on the device; null when there are no sites. */
export function nearestSite<T extends Pick<Site, "lat" | "lon">>(sites: T[], lat: number, lon: number): { site: T; distanceMi: number } | null {
  let best: { site: T; distanceMi: number } | null = null;
  for (const site of sites) {
    if (!Number.isFinite(site.lat) || !Number.isFinite(site.lon)) continue;
    const d = distanceMi(lat, lon, site.lat, site.lon);
    if (!best || d < best.distanceMi) best = { site, distanceMi: d };
  }
  return best;
}
