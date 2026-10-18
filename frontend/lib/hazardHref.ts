import type { HazardType } from "@shared/types";

// The id of each hazard card on the site page (#hazard-<name>).
const HAZARD_ANCHOR: Record<HazardType, string> = {
  lightning: "lightning",
  heat: "heat",
  flood: "flooding",
  soil_saturation: "soil",
  wildfire: "wildfire",
  wildlife: "wildlife",
  storm: "storm",
};

/** "/sites/big-bend#hazard-flooding": a site's page, scrolled to one hazard's card. */
export function hazardHref(siteId: string, hazard: HazardType): string {
  return `/sites/${encodeURIComponent(siteId)}#hazard-${HAZARD_ANCHOR[hazard]}`;
}
