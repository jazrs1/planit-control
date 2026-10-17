"""Pydantic mirror of shared/types.ts. Change both in the same PR."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

HazardType = Literal["heat", "lightning", "flood", "soil_saturation", "wildfire", "wildlife"]
HazardIndex = Annotated[float, Field(ge=0, le=10)]


class Site(BaseModel):
    id: str
    name: str
    lat: float
    lon: float
    county: str
    timezone: str
    hazard_index: HazardIndex
    top_hazard: HazardType


class HeatConditions(BaseModel):
    heat_index_f: float
    air_temp_f: float
    humidity_pct: float


class LightningConditions(BaseModel):
    nearest_strike_mi: float | None
    nearest_strike_at: datetime | None
    strikes_last_30_min: int


class FloodConditions(BaseModel):
    status: Literal["none", "advisory", "watch", "warning"]
    source: str | None


class SoilConditions(BaseModel):
    moisture_pct: float
    saturated: bool


class WildfireConditions(BaseModel):
    nearest_detection_mi: float | None
    detected_at: datetime | None
    confidence: Literal["low", "nominal", "high"] | None


class WildlifeSighting(BaseModel):
    species: str
    distance_mi: float
    seen_at: datetime
    source: str


class SiteConditions(BaseModel):
    heat: HeatConditions
    lightning: LightningConditions
    flood: FloodConditions
    soil: SoilConditions
    wildfire: WildfireConditions
    wildlife: list[WildlifeSighting]


class ContributingFactor(BaseModel):
    hazard: HazardType
    label: str
    weight: float = Field(ge=0, le=1)


class SiteDetail(Site):
    conditions: SiteConditions
    hazard_index_today: HazardIndex
    hazard_index_tomorrow: HazardIndex
    top_factors: list[ContributingFactor]
    updated_at: datetime


class Alert(BaseModel):
    id: str
    site_id: str
    type: Literal["lightning", "heat", "flood", "wildfire"]
    started_at: datetime
    all_clear_at: datetime | None
    last_strike_distance_mi: float | None


ReportCategory = Literal[
    "downed_line", "flooding", "wildlife", "fire_smoke", "heat_illness", "unsafe_ground", "other"
]


class CreateReportRequest(BaseModel):
    site_id: str | None
    photo_url: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    category: ReportCategory
    note: str
    reporter_role: Literal["crew_member", "foreman", "safety_officer"]


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
