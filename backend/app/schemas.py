"""Pydantic mirror of shared/types.ts. Change both in the same PR."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

ReportCategory = Literal[
    "downed_line", "flooding", "wildlife", "fire_smoke", "heat_illness", "unsafe_ground", "other"
]

HazardType = Literal["heat", "lightning", "flood", "soil_saturation", "wildfire", "wildlife"]
HazardIndex = Annotated[float, Field(ge=0, le=10)]


class LightningApproach(BaseModel):
    arrival_at: datetime
    minutes_to_arrival: int
    from_direction: str
    from_bearing_deg: float
    heading_deg: float
    speed_mph: float
    distance_mi: float
    issued_at: datetime
    updated_at: datetime


class Site(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    county: str
    timezone: str
    hazard_index: HazardIndex
    top_hazard: HazardType
    lightning_approach: LightningApproach | None = None


class HazardCard(BaseModel):
    """Optional fields every hazard card has (additive; absent in older mocks)."""
    hazard_status: Literal["ok", "watch", "danger"] | None = None
    reading: str | None = None
    as_of: datetime | None = None


class HeatConditions(HazardCard):
    heat_index_f: float
    air_temp_f: float
    humidity_pct: float
    risk_band: Literal["lower", "moderate", "high", "very_high"] | None = None
    peak_heat_index_f: float | None = None
    peak_at: datetime | None = None


class LightningConditions(HazardCard):
    nearest_strike_mi: float | None
    nearest_strike_at: datetime | None
    strikes_last_30_min: int


class FloodConditions(HazardCard):
    status: Literal["none", "advisory", "watch", "warning"]
    source: str | None
    rain_past_12h_in: float | None = None
    rain_past_24h_in: float | None = None
    rain_past_72h_in: float | None = None
    rain_next_24h_in: float | None = None
    fema_flood_zone: str | None = None
    in_special_flood_hazard_area: bool | None = None
    near_river: bool | None = None


class SoilConditions(HazardCard):
    moisture_pct: float
    saturated: bool
    level: Literal["dry", "moist", "saturated"] | None = None


class WildfireConditions(HazardCard):
    nearest_detection_mi: float | None
    detected_at: datetime | None
    confidence: Literal["low", "nominal", "high"] | None
    detections_25mi: int | None = None
    red_flag_warning: bool | None = None


class WildlifeSighting(BaseModel):
    species: str
    distance_mi: float
    seen_at: datetime
    source: str


class WildlifeSummary(HazardCard):
    observations_30d: int
    venomous_30d: int
    crew_reports_2mi: int


class CrewReportNote(BaseModel):
    id: str
    category: ReportCategory
    species: str | None = None
    reported_at: datetime
    distance_mi: float


class CrewHazards(HazardCard):
    reports: list[CrewReportNote]


class SiteConditions(BaseModel):
    heat: HeatConditions
    lightning: LightningConditions
    flood: FloodConditions
    soil: SoilConditions
    wildfire: WildfireConditions
    wildlife: list[WildlifeSighting]
    wildlife_summary: WildlifeSummary | None = None
    crew_hazards: CrewHazards | None = None


class NwsAlert(BaseModel):
    event: str
    severity: str | None
    headline: str | None
    ends_at: datetime | None


FactorSource = Literal["model", "rule"]


class ContributingFactor(BaseModel):
    hazard: HazardType | None   # None: a factor that isn't one hazard (a downed-line crew report)
    label: str
    weight: float = Field(ge=0, le=1)
    source: FactorSource | None = None


class SiteDetail(Site):
    conditions: SiteConditions
    hazard_index_today: HazardIndex
    hazard_index_tomorrow: HazardIndex
    top_factors: list[ContributingFactor]
    updated_at: datetime
    nws_alerts: list[NwsAlert] | None = None


class Alert(BaseModel):
    id: str
    site_id: str
    type: Literal["lightning", "heat", "flood", "wildfire"]
    started_at: datetime
    all_clear_at: datetime | None
    last_strike_distance_mi: float | None




class CreateReportRequest(BaseModel):
    site_id: str | None
    photo_url: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    category: ReportCategory
    note: str
    reporter_role: Literal["crew_member", "foreman", "safety_officer"]
    # Wildlife only, e.g. "Snake", "Alligator". Optional; blank is stored as null.
    species: str | None = Field(None, max_length=60)

    @model_validator(mode="after")
    def _species_for_wildlife_only(self):
        self.species = (self.species or "").strip() or None
        if self.species and self.category != "wildlife":
            raise ValueError("species is only for category 'wildlife'")
        return self


class UploadResponse(BaseModel):
    photo_url: str


class HazardReport(CreateReportRequest):
    id: str
    created_at: datetime


class BriefingKeyNumbers(BaseModel):
    hazard_index: HazardIndex
    max_heat_index_f: float
    lightning_probability_pct: float
    rain_in: float
    soil_moisture_pct: float
    wildfire_detections_25mi: int


class Briefing(BaseModel):
    site_id: str
    site_name: str
    for_date: str
    generated_at: datetime
    top_hazard: HazardType
    text: str
    key_numbers: BriefingKeyNumbers
    go_status: Literal["go", "caution", "no_go"] | None = None
    headline: str | None = None
    risks: list[str] | None = None
    actions: list[str] | None = None
    top_factors: list[ContributingFactor] | None = None
    generator: Literal["claude", "gemini", "template"] | None = None
    model: str | None = None
    unavailable: list[str] | None = None


class SendBriefingRequest(BaseModel):
    site_id: str | None = None


class SendBriefingResponse(BaseModel):
    generated: list[Briefing]
    queued: int


class LightningFlash(BaseModel):
    ts: datetime
    lat: float
    lon: float


class StartReplayRequest(BaseModel):
    window: str | None = None
    speed: float = Field(30, gt=0, le=3600)


class ReplayStatus(BaseModel):
    running: bool
    window: str | None
    speed: float | None
    simulated_now: datetime | None
    files_total: int
    files_done: int
    flashes_ingested: int


# ---------- GET /sites/{id}/score-history ----------

class ScorePoint(BaseModel):
    scored_at: datetime
    for_date: str
    horizon: Literal["today", "tomorrow"]
    hazard_index: HazardIndex
    top_hazard: HazardType | None
    model_score: HazardIndex | None


class ScoreHistory(BaseModel):
    site_id: str
    points: list[ScorePoint]


# ---------- GET /model/info ----------

class ModelMetrics(BaseModel):
    pr_auc: float
    roc_auc: float
    brier: float


class ModelComparison(BaseModel):
    name: str
    description: str
    same_day: ModelMetrics
    day_ahead: ModelMetrics | None


class ModelTraining(BaseModel):
    train_years: list[int]
    validation_year: int
    test_year: int
    sites: int
    train_site_days: int
    train_events: int


class ModelTestSet(BaseModel):
    site_days: int
    events: int
    base_rate: float


class ModelBand(BaseModel):
    band: Literal["green", "amber", "red"]
    share_of_days: float
    event_rate: float
    share_of_events: float


class IndexAnchor(BaseModel):
    index: HazardIndex
    percentile: float
    probability: float


class CalibrationBin(BaseModel):
    mean_predicted: float
    observed: float
    site_days: int


class ModelCalibration(BaseModel):
    plot_url: str
    bins: list[CalibrationBin]


class ModelFeature(BaseModel):
    label: str
    importance: float


class ModelInfo(BaseModel):
    version: str
    trained_at: datetime
    label: str
    weather_source: str
    hybrid: str
    training: ModelTraining
    test: ModelTestSet
    results: list[ModelComparison]
    bands: list[ModelBand]
    index_anchors: list[IndexAnchor]
    calibration: ModelCalibration
    top_features: list[ModelFeature]
    limitations: list[str]
    last_scored_at: datetime | None


# ---------- GET /lightning/cells ----------

class LightningCell(BaseModel):
    id: str
    lat: float
    lon: float
    flash_count: int
    recent_flashes: int
    radius_mi: float
    tracked: bool
    speed_mph: float | None
    heading_deg: float | None
    moving_toward: str | None
    last_flash_at: datetime


# ---------- GET /sites/{id}/beacon ----------

class Beacon(BaseModel):
    site_id: str
    state: Literal["stop", "approaching", "flood", "clear"]
    seconds_to_all_clear: int | None
    minutes_to_arrival: int | None
    as_of: datetime
