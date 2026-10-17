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

/** "Lightning approaching": a tracked storm cell's leading edge is expected to reach the site's
 * 10-mile stop-work ring within 60 minutes. An advisory, never a stop-work order. */
export interface LightningApproach {
  /** Estimated time the leading edge reaches the 10-mile ring. */
  arrival_at: string;
  /** Whole minutes from the server's now (simulated during replay); 0 = arriving now. An optimistic
   * estimate (on the replay, lightning usually came sooner): show as "lightning possible within N min",
   * never as a countdown. See docs/lightning-forecast.md. */
  minutes_to_arrival: number;
  /** Where the storm is, seen from the site: 16-point compass, e.g. "WSW". */
  from_direction: string;
  from_bearing_deg: number;
  /** Direction the storm is moving, degrees clockwise from north. */
  heading_deg: number;
  speed_mph: number;
  /** Leading edge to the site, now. */
  distance_mi: number;
  issued_at: string;
  updated_at: string;
}

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
  /** Sent by the live backend (null when no storm is approaching or the site is in stop-work);
   * absent in older mocks. */
  lightning_approach?: LightningApproach | null;
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

/** One crew report within 2 miles of the site in the last 48 hours. */
export interface CrewReportNote {
  id: string;
  category: ReportCategory;
  species?: string | null;
  reported_at: string;
  distance_mi: number;
}

/** Crew-reported hazards near the site (last 48 h, within 2 mi). Danger for a downed line,
 *  watch for "other"; flooding, heat illness, unsafe ground, fire and wildlife reports also raise
 *  their own hazard card to at least watch and lead its reading with "Crew report: …". */
export interface CrewHazards extends HazardCard {
  reports: CrewReportNote[];
}

export interface SiteConditions {
  heat: HeatConditions;
  lightning: LightningConditions;
  flood: FloodConditions;
  soil: SoilConditions;
  wildfire: WildfireConditions;
  wildlife: WildlifeSighting[];
  wildlife_summary?: WildlifeSummary | null;
  crew_hazards?: CrewHazards | null;
}

/** An active National Weather Service alert covering the site. */
export interface NwsAlert {
  event: string;
  severity: string | null;
  headline: string | null;
  ends_at: string | null;
}

/** Where a hazard-index factor came from: the ML weather model, or a safety rule
 * (OSHA heat band, wildfire, wildlife, crew report, lightning stop-work). */
export type FactorSource = "model" | "rule";

export interface ContributingFactor {
  /** null for a factor that isn't one hazard: a downed-line crew report (see conditions.crew_hazards). */
  hazard: HazardType | null;
  label: string;
  /** Share of the hazard index, 0–1. Factors for a site sum to <= 1. */
  weight: number;
  /** Always sent by the live backend; absent in older mocks. */
  source?: FactorSource | null;
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
  /**
   * true: from a lightning replay. Its times are simulated (count down on the replay clock) and it
   * isn't real; label it REPLAY. false: a real alert, on real time. During a replay GET /alerts
   * returns both, so real alerts never disappear.
   */
  replay: boolean;
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
  /** Wildlife reports only, e.g. "Snake" or "Alligator"; omit or null otherwise. */
  species?: string | null;
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

/** Headline decision for tomorrow, made by the backend (never by the text writer). */
export type GoStatus = "go" | "caution" | "no_go";

export interface Briefing {
  site_id: string;
  site_name: string;
  /** Local date the briefing covers (tomorrow), YYYY-MM-DD. */
  for_date: string;
  /** Sent at 18:00 site-local time the evening before (or when POST /briefing/send-now ran). */
  generated_at: string;
  top_hazard: HazardType;
  /** The full briefing, under 150 words: headline line, "Top risks:", "Actions:". */
  text: string;
  key_numbers: BriefingKeyNumbers;
  go_status?: GoStatus | null;
  headline?: string | null;
  /** Top 3 risks, most important first, each with when it happens. */
  risks?: string[] | null;
  actions?: string[] | null;
  /** Tomorrow's top contributing factors behind key_numbers.hazard_index. */
  top_factors?: ContributingFactor[] | null;
  /** Which writer produced it: "claude" or "gemini" when that model wrote it and it passed the
   *  grounding check (tried in that order), else "template". */
  generator?: "claude" | "gemini" | "template" | null;
  /** The model that answered, e.g. "claude-sonnet-5-5"; null for the template. */
  model?: string | null;
  /** key_numbers fields with no live data behind them (their value is 0), e.g. wildfire without a FIRMS key. */
  unavailable?: (keyof BriefingKeyNumbers)[] | null;
}

// ---------- GET /briefings ----------

/** The latest briefing for every site that has one, largest plant first. */
export type BriefingsResponse = Briefing[];

// ---------- POST /briefing/send-now ----------

export interface SendBriefingRequest {
  /** One site, or omit/null for all sites. */
  site_id?: string | null;
}

export interface SendBriefingResponse {
  /** One site: generated right away. */
  generated: Briefing[];
  /** All sites: number queued to generate in the background (check GET /briefing/{site_id}). */
  queued: number;
}

// ---------- GET /lightning/recent?minutes=15 ----------

/** One GOES-19 GLM flash over Florida (+30 mi). */
export interface LightningFlash {
  ts: string;
  lat: number;
  lon: number;
}

export type LightningRecentResponse = LightningFlash[];

// ---------- GET /lightning/cells ----------

/** A storm cell: a cluster of flashes from the last 20 minutes. Ids are per response (not stable). */
export interface LightningCell {
  id: string;
  lat: number;
  lon: number;
  /** Flashes in the last 20 minutes. */
  flash_count: number;
  /** Flashes in the last 5 minutes. */
  recent_flashes: number;
  /** 90th-percentile distance of the last 5 minutes' flashes from the center. */
  radius_mi: number;
  /** true when the motion is reliable enough to forecast with. */
  tracked: boolean;
  /** null when not tracked; 0 when tracked but nearly stationary. */
  speed_mph: number | null;
  /** Direction of motion, degrees clockwise from north; null when not tracked or stationary. */
  heading_deg: number | null;
  /** 16-point compass of heading_deg, e.g. "NE". */
  moving_toward: string | null;
  last_flash_at: string;
}

export type LightningCellsResponse = LightningCell[];

// ---------- GET /sites/{id}/beacon ----------

/**
 * Tiny state for a hardware alarm. Priority: stop > unknown > approaching > flood > clear.
 * "unknown": lightning ingestion hasn't succeeded in the last 2 minutes (replay: on the replay clock),
 * so the site must not be shown as clear.
 */
export type BeaconState = "stop" | "approaching" | "flood" | "clear" | "unknown";

export interface Beacon {
  site_id: string;
  state: BeaconState;
  /** Only when state is "stop": seconds until the lightning all-clear (if no new strikes). */
  seconds_to_all_clear: number | null;
  /** Only when state is "approaching": whole minutes until the storm reaches the 10-mile ring
   * (optimistic: lightning can come sooner; not a countdown). */
  minutes_to_arrival: number | null;
  as_of: string;
}

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

// ---------- GET /sites/{id}/score-history ----------

export type ScoreHorizon = "today" | "tomorrow";

/** One stored scoring run (hourly, after the weather poll) for one day. */
export interface ScorePoint {
  scored_at: string;
  /** Site-local date the score is for (YYYY-MM-DD). */
  for_date: string;
  /** "today" when for_date was the site's own date at scored_at; "tomorrow" the day after. */
  horizon: ScoreHorizon;
  hazard_index: HazardIndex;
  top_hazard: HazardType | null;
  /** The ML weather score alone, 0–10; null when the model hadn't scored that day yet. */
  model_score: HazardIndex | null;
}

export interface ScoreHistory {
  site_id: string;
  /** Last 7 days, oldest first. Empty without a database or before the first scoring run. */
  points: ScorePoint[];
}

// ---------- GET /model/info ----------

export interface ModelMetrics {
  /** Precision-recall AUC: how well risky days rank at the top (higher is better). */
  pr_auc: number;
  roc_auc: number;
  /** Mean squared error of the probability (lower is better). */
  brier: number;
}

export interface ModelComparison {
  name: string;
  description: string;
  /** Scored from same-day forecasts ("today"). */
  same_day: ModelMetrics;
  /** Scored from forecasts issued ~24 h earlier ("tomorrow"); null if not evaluated. */
  day_ahead: ModelMetrics | null;
}

export interface ModelBand {
  band: RiskLevel;
  share_of_days: number;
  /** Share of that band's site-days with a logged hazardous event. */
  event_rate: number;
  share_of_events: number;
}

export interface IndexAnchor {
  index: HazardIndex;
  /** Percentile of the validation year's site-days, 0–1. */
  percentile: number;
  /** Calibrated probability at that index. */
  probability: number;
}

export interface CalibrationBin {
  mean_predicted: number;
  observed: number;
  site_days: number;
}

export interface ModelInfo {
  /** Training timestamp; stored with every score. */
  version: string;
  trained_at: string;
  /** What the model predicts (the label). */
  label: string;
  weather_source: string;
  /** How the ML score and the safety rules combine into the hazard index. */
  hybrid: string;
  training: {
    train_years: number[];
    validation_year: number;
    test_year: number;
    sites: number;
    train_site_days: number;
    train_events: number;
  };
  test: { site_days: number; events: number; base_rate: number };
  /** On the test year: the model first, then the baselines. */
  results: ModelComparison[];
  /** Test year, same-day forecasts. */
  bands: ModelBand[];
  index_anchors: IndexAnchor[];
  calibration: {
    /** Path on the API (e.g. "/model/calibration.svg"); light and dark mode. */
    plot_url: string;
    /** Test year, same-day forecasts; the plot's points (bins with >= 50 site-days). */
    bins: CalibrationBin[];
  };
  /** What drives the model most, largest first (mean |SHAP|, log-odds). */
  top_features: { label: string; importance: number }[];
  limitations: string[];
  /** Last successful hourly scoring run; null without a database or before the first run. */
  last_scored_at: string | null;
}

// ---------- Errors ----------

export interface ApiError {
  detail: string;
}
