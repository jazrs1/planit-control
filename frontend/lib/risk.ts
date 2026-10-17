import type { Alert, HazardIndex, HazardType, RiskLevel, Site } from "@shared/types";

/** green 0-3, amber 4-6, red 7-10. The only place the thresholds live in the frontend. */
export function riskLevel(index: HazardIndex): RiskLevel {
  if (index >= 7) return "red";
  if (index >= 4) return "amber";
  return "green";
}

export const HAZARD_LABEL: Record<HazardType, string> = {
  heat: "Heat",
  lightning: "Lightning",
  storm: "Storms & wind",
  flood: "Flooding",
  soil_saturation: "Soil saturation",
  wildfire: "Wildfire",
  wildlife: "Wildlife",
};

/** A contributing factor's hazard label. null is a factor that isn't one hazard: a downed-line crew report. */
export function factorHazardLabel(hazard: HazardType | null): string {
  return hazard ? HAZARD_LABEL[hazard] : "Crew hazard";
}

/** The index without replay overrides: what real counts and real risk colors use. Falls back to
 *  hazard_index for a server that predates the field. */
export function liveHazardIndex(site: Site): HazardIndex {
  const live: number | undefined = site.hazard_index_live;
  return typeof live === "number" && Number.isFinite(live) ? live : site.hazard_index;
}

/** The site's index was raised by a replay and it has no real stop-work. A server that predates
 *  replay_override: a site whose only stop-work is a replay alert counts as raised. */
export function replayRaised(site: Site, siteAlerts: Alert[]): boolean {
  const flag: boolean | undefined = site.replay_override;
  if (typeof flag === "boolean") return flag && !siteAlerts.some((a) => a.type === "lightning" && !a.replay);
  const stops = siteAlerts.filter((a) => a.type === "lightning");
  return stops.length > 0 && stops.every((a) => a.replay);
}
