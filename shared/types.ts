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

/** Card status, aligned with the risk bands: ok < 4, watch 4 to < 7, danger >= 7. */
export type HazardStatus = "ok" | "watch" | "danger";

/** Optional on every hazard card (added for live data; absent in older mocks). */
export interface HazardCard {
  /** Missing when the card's source has no data yet. */
  hazard_status?: HazardStatus | null;
  /** One plain-language line for crews, e.g. "Saturated ground: vehicles may get stuck off pavement". */
  reading?: string | null;
  /** When the source last produced this reading; null when there is no live data yet. */
  as_of?: string | null;
}

/** OSHA heat index risk level: < 91 lower, 91–103 moderate, 103–115 high, > 115 very high. */
export type OshaHeatRisk = "lower" | "moderate" | "high" | "very_high";

export interface HeatConditions extends HazardCard {
  heat_index_f: number;
  air_temp_f: number;
  humidity_pct: number;
  /** OSHA band for today's peak heat index. */
  risk_band?: OshaHeatRisk | null;
  /** Today's (site-local) peak NWS heat index and when it occurs. */
  peak_heat_index_f?: number | null;
  peak_at?: string | null;
}

export interface LightningConditions extends HazardCard {
  /** null when no strikes in the lookback window. */
  nearest_strike_mi: number | null;
  nearest_strike_at: string | null;
  strikes_last_30_min: number;
}

export type FloodStatus = "none" | "advisory" | "watch" | "warning";

export interface FloodConditions extends HazardCard {
  /** NWS-style level ("warning" also when a flood-risk alert is active). Card color: hazard_status. */
  status: FloodStatus;
  /** Human-readable source, e.g. "NWS Flood Watch" or "USGS gauge 02323500". */
  source: string | null;
  rain_past_12h_in?: number | null;
  rain_past_24h_in?: number | null;
  rain_past_72h_in?: number | null;
  rain_next_24h_in?: number | null;
  /** FEMA NFHL zone, e.g. "AE", "VE", "X"; "unmapped" where FEMA has no map. */
  fema_flood_zone?: string | null;
  /** In FEMA's Special Flood Hazard Area (1%-annual-chance floodplain). */
  in_special_flood_hazard_area?: boolean | null;
  /** A named river within 1 mile (USGS NHD). */
  near_river?: boolean | null;
}

export type SoilLevel = "dry" | "moist" | "saturated";

export interface SoilConditions extends HazardCard {
  /** Volumetric soil moisture, 0–100. */
  moisture_pct: number;
  saturated: boolean;
  level?: SoilLevel | null;
}

export interface WildfireConditions extends HazardCard {
  /** Nearest NASA FIRMS detection; null when none in range. */
  nearest_detection_mi: number | null;
  detected_at: string | null;
  confidence: "low" | "nominal" | "high" | null;
  /** VIIRS detections within 25 mi in the last 24 h. */
  detections_25mi?: number | null;
  red_flag_warning?: boolean | null;
}

export interface WildlifeSighting {
  species: string;
  distance_mi: number;
  seen_at: string;
  source: string;
}

/** The wildlife card (wildlife itself is a list of sightings, so the card lives here). */
export interface WildlifeSummary extends HazardCard {
  /** iNaturalist alligator + venomous snake sightings within 5 km, last 30 days. */
  observations_30d: number;
  venomous_30d: number;
  /** Crew reports with category "wildlife" within 2 miles, last 30 days. */
  crew_reports_2mi: number;
}

export interface SiteConditions {
  heat: HeatConditions;
  lightning: LightningConditions;
  flood: FloodConditions;
  soil: SoilConditions;
  wildfire: WildfireConditions;
  wildlife: WildlifeSighting[];
  wildlife_summary?: WildlifeSummary | null;
}

/** An active National Weather Service alert covering the site. */
export interface NwsAlert {
  event: string;
  severity: string | null;
  headline: string | null;
  ends_at: string | null;
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
  nws_alerts?: NwsAlert[] | null;
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
  /** From POST /uploads. */
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

// ---------- POST /uploads ----------
// Request body: the raw image bytes with Content-Type image/jpeg, image/png, image/webp, or image/heic (max 10 MB).

export interface UploadResponse {
  /** Absolute URL of the stored photo; pass it as photo_url in POST /reports. */
  photo_url: string;
}

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

// ---------- GET /lightning/recent?minutes=15 ----------

/** One GOES-19 GLM flash over Florida (+30 mi). */
export interface LightningFlash {
  ts: string;
  lat: number;
  lon: number;
}

export type LightningRecentResponse = LightningFlash[];

// ---------- POST /replay/start, POST /replay/stop, GET /replay/status ----------

export interface StartReplayRequest {
  /** Folder name under backend/data/replay/; defaults to the newest one. */
  window?: string | null;
  /** Simulated seconds per real second. Default 30. */
  speed?: number;
}

export interface ReplayStatus {
  running: boolean;
  window: string | null;
  speed: number | null;
  /** The app's simulated "now" while running; null otherwise. */
  simulated_now: string | null;
  files_total: number;
  files_done: number;
  flashes_ingested: number;
}

// ---------- Errors ----------

export interface ApiError {
  detail: string;
}
