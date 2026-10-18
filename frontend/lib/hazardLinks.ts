import type { HazardType, Site } from "@shared/types";

// Deep links to a hazard card on the site detail page: /sites/<id>#hazard-<name>. One format for every
// page that links to a card. "storm" (Storms & wind) has no card of its own: it points at the
// "What drives today's index" section.

export const HAZARD_ANCHOR: Record<HazardType, string> = {
  lightning: "hazard-lightning",
  heat: "hazard-heat",
  flood: "hazard-flooding",
  soil_saturation: "hazard-soil",
  wildfire: "hazard-wildfire",
  wildlife: "hazard-wildlife",
  storm: "hazard-storm",
};

/** "/sites/big-bend#hazard-wildlife" */
export function hazardHref(siteId: Site["id"], hazard: HazardType): string {
  return `/sites/${encodeURIComponent(siteId)}#${HAZARD_ANCHOR[hazard]}`;
}

/** What a page load with this hash should do: scroll to `elementId` and, for a card, open its details.
 *  null for a missing or unknown hash: a normal page load. */
export function hazardTarget(hash: string): { hazard: HazardType; elementId: string; expand: boolean } | null {
  let id = hash.replace(/^#/, "");
  try { id = decodeURIComponent(id); } catch { return null; }
  const entry = (Object.entries(HAZARD_ANCHOR) as [HazardType, string][]).find(([, anchor]) => anchor === id);
  if (!entry) return null;
  // The storm section has no "Show details" to open.
  return { hazard: entry[0], elementId: entry[1], expand: entry[0] !== "storm" };
}
