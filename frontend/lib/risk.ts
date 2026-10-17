import type { HazardIndex, HazardType, RiskLevel } from "@shared/types";

/** green 0-3, amber 4-6, red 7-10. The only place the thresholds live in the frontend. */
export function riskLevel(index: HazardIndex): RiskLevel {
  if (index >= 7) return "red";
  if (index >= 4) return "amber";
  return "green";
}

export const HAZARD_LABEL: Record<HazardType, string> = {
  heat: "Heat",
  lightning: "Lightning",
  flood: "Flooding",
  soil_saturation: "Soil saturation",
  wildfire: "Wildfire",
  wildlife: "Wildlife",
};

/** A contributing factor's hazard label. null is a factor that isn't one hazard: a downed-line crew report. */
export function factorHazardLabel(hazard: HazardType | null): string {
  return hazard ? HAZARD_LABEL[hazard] : "Crew hazard";
}
