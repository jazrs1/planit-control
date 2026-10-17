// PlanIT Control — API contract.
// Every shape the backend returns and the frontend consumes lives here.
// backend/app/schemas.py mirrors these; change both in the same PR.
// Timestamps are ISO 8601 strings with UTC offset. Distances are miles, temps are °F.

/** 0–10. Bands: green < 4, amber 4 to < 7, red >= 7 (i.e. 0–3 / 4–6 / 7–10). */
export type HazardIndex = number;

export type RiskLevel = "green" | "amber" | "red";

export type HazardType =
  | "heat"
  | "lightning"
  | "flood"
  | "soil_saturation"
  | "wildfire"
  | "wildlife";

// ---------- GET /sites ----------

export interface Site {
  id: string;
  name: string;
  lat: number;
  lon: number;
  county: string;
  /** IANA zone, e.g. "America/New_York" or "America/Chicago" (panhandle). */
  timezone: string;
  hazard_index: HazardIndex;
  top_hazard: HazardType;
}

export type SitesResponse = Site[];

// ---------- GET /sites/{id} ----------

export interface HeatConditions {
  heat_index_f: number;
  air_temp_f: number;
  humidity_pct: number;
}

export interface LightningConditions {
  /** null when no strikes in the lookback window. */
  nearest_strike_mi: number | null;
  nearest_strike_at: string | null;
  strikes_last_30_min: number;
}

export type FloodStatus = "none" | "advisory" | "watch" | "warning";

export interface FloodConditions {
  status: FloodStatus;
  /** Human-readable source, e.g. "NWS Flood Watch" or "USGS gauge 02323500". */
  source: string | null;
}

export interface SoilConditions {
  /** Volumetric soil moisture, 0–100. */
  moisture_pct: number;
  saturated: boolean;
}

export interface WildfireConditions {
  /** Nearest NASA FIRMS detection; null when none in range. */
  nearest_detection_mi: number | null;
  detected_at: string | null;
  confidence: "low" | "nominal" | "high" | null;
}

export interface WildlifeSighting {
  species: string;
  distance_mi: number;
  seen_at: string;
  source: string;
}

export interface SiteConditions {
  heat: HeatConditions;
  lightning: LightningConditions;
  flood: FloodConditions;
  soil: SoilConditions;
  wildfire: WildfireConditions;
  wildlife: WildlifeSighting[];
}

export interface ContributingFactor {
  hazard: HazardType;
  label: string;
  /** Share of the hazard index, 0–1. Factors for a site sum to <= 1. */
  weight: number;
}

export interface SiteDetail extends Site {
  conditions: SiteConditions;
  hazard_index_today: HazardIndex;
  hazard_index_tomorrow: HazardIndex;
  top_factors: ContributingFactor[];
  updated_at: string;
}

// ---------- GET /alerts ----------

export type AlertType = "lightning" | "heat" | "flood" | "wildfire";

export interface Alert {
  id: string;
  site_id: string;
  type: AlertType;
  started_at: string;
  /** Countdown end. Lightning: last strike + 30 min, pushed back on every new strike. null = no countdown. */
  all_clear_at: string | null;
  /** Lightning only; null for other types. */
  last_strike_distance_mi: number | null;
}

export type AlertsResponse = Alert[];

// ---------- POST /reports, GET /reports ----------

export type ReportCategory =
  | "downed_line"
  | "flooding"
  | "wildlife"
  | "fire_smoke"
  | "heat_illness"
  | "unsafe_ground"
  | "other";

export type ReporterRole = "crew_member" | "foreman" | "safety_officer";

export interface CreateReportRequest {
  /** Nearest site if known; null for reports away from a tracked site. */
  site_id: string | null;
  photo_url: string;
  lat: number;
  lon: number;
  category: ReportCategory;
  note: string;
  reporter_role: ReporterRole;
}

export interface HazardReport extends CreateReportRequest {
  id: string;
  created_at: string;
}

export type ReportsResponse = HazardReport[];

// ---------- GET /briefing/{site_id} ----------

export interface BriefingKeyNumbers {
  hazard_index: HazardIndex;
  max_heat_index_f: number;
  lightning_probability_pct: number;
  rain_in: number;
  soil_moisture_pct: number;
  wildfire_detections_25mi: number;
}

export interface Briefing {
  site_id: string;
  site_name: string;
  /** Local date the briefing covers (tomorrow), YYYY-MM-DD. */
  for_date: string;
  /** Sent at 18:00 site-local time the evening before. */
  generated_at: string;
  top_hazard: HazardType;
  text: string;
  key_numbers: BriefingKeyNumbers;
}

// ---------- Errors ----------

export interface ApiError {
  detail: string;
}
