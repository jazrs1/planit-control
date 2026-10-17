"""Crew reports feed the site hazard picture (last 48 h, within 2 mi) and keep their species."""

import json
import math
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from psycopg.rows import dict_row
from pydantic import ValidationError

from app.config import get_settings
from app.schemas import CreateReportRequest
from briefing import writer
from briefing.inputs import go_status
from hazards.risk import predict
from hazards.scoring import Inputs

NOW = datetime(2026, 7, 15, 18, 0, tzinfo=timezone.utc)
SITE = {"id": "s", "name": "Test", "lat": 28.0, "lon": -82.0, "timezone": "America/New_York",
        "fema_flood_zone": "X", "fema_sfha": False, "near_river": False, "river_name": None}


def report(category, hours_ago, species=None, distance=0.5):
    return {"id": f"rpt_{category}", "category": category, "species": species,
            "created_at": NOW - timedelta(hours=hours_ago), "distance_mi": distance}


def cards_for(*reports, readings=None):
    inp = Inputs(site=SITE, readings={k: (v, NOW) for k, v in (readings or {}).items()},
                 crew_reports=sorted(reports, key=lambda r: r["created_at"], reverse=True), now=NOW)
    return predict(inp, {})


# ---------- cards ----------

@pytest.mark.parametrize("category, card, label", [
    ("flooding", "flood", "Flooding or washout"),
    ("heat_illness", "heat", "Heat illness"),
    ("unsafe_ground", "soil_saturation", "Unsafe ground"),
    ("fire_smoke", "wildfire", "Fire or smoke"),
])
def test_crew_report_raises_its_card_to_at_least_watch(category, card, label):
    scored = cards_for(report(category, 2))
    c = scored["cards"][card]
    assert c["hazard_status"] == "watch"
    assert c["reading"].startswith(f"Crew report: {label}, 2 h ago")
    assert scored["hazard_index_today"] >= 4


def test_crew_report_never_lowers_a_card():
    scored = cards_for(report("heat_illness", 1), readings={("heat", "heat_index_f"): 118.0})
    assert scored["cards"]["heat"]["hazard_status"] == "danger"


def test_downed_line_is_a_danger_crew_hazard():
    crew = cards_for(report("downed_line", 0.5), report("flooding", 3))["cards"]["crew_hazards"]
    assert crew["hazard_status"] == "danger"
    assert crew["reading"].startswith("Crew report: Downed line, 30 min ago")
    assert {r["category"] for r in crew["reports"]} == {"downed_line", "flooding"}


def test_crew_card_ok_when_no_reports_and_watch_for_other():
    assert cards_for()["cards"]["crew_hazards"]["hazard_status"] == "ok"
    assert cards_for(report("other", 5))["cards"]["crew_hazards"]["hazard_status"] == "watch"


def test_wildlife_report_keeps_species_in_reading():
    w = cards_for(report("wildlife", 2, species="Snake"))["cards"]["wildlife"]
    assert w["reading"].startswith("Crew report: Wildlife (Snake), 2 h ago")


def test_more_reports_are_counted():
    flood = cards_for(report("flooding", 1), report("flooding", 6))["cards"]["flood"]
    assert "Crew report: Flooding or washout, 1 h ago (+1 more)" in flood["reading"]


# ---------- species ----------

def body(**kw):
    return {"site_id": None, "photo_url": "http://x/p.jpg", "lat": 28.0, "lon": -82.0, "category": "wildlife",
            "note": "", "reporter_role": "crew_member", **kw}


def test_species_is_optional_trimmed_and_wildlife_only():
    assert CreateReportRequest(**body()).species is None
    assert CreateReportRequest(**body(species="  Snake ")).species == "Snake"
    assert CreateReportRequest(**body(species="   ")).species is None
    with pytest.raises(ValidationError):
        CreateReportRequest(**body(category="flooding", species="Snake"))


# ---------- database: 48 h / 2 mi window, species round trip ----------

class FakePool:
    """Hands out the test's connection so everything stays in its rolled-back transaction."""
    def __init__(self, conn):
        self.conn = conn

    @contextmanager
    def connection(self, timeout=None):
        yield self.conn


@pytest.fixture
def conn():
    url = get_settings().database_url
    if not url:
        pytest.skip("DATABASE_URL not set")
    with psycopg.connect(url, row_factory=dict_row, connect_timeout=15) as conn:
        try:
            yield conn
        finally:
            conn.rollback()


def offset(lat, lon, miles_north):
    return lat + miles_north / 69.09, lon


def test_only_recent_nearby_reports_feed_the_site(conn):
    from app import site_data
    from app.routers.reports import create_report, list_reports
    sanford = conn.execute("SELECT lat, lon FROM sites WHERE id = 'sanford'").fetchone()
    pool = FakePool(conn)
    lat, lon = offset(sanford["lat"], sanford["lon"], 0.5)
    snake = create_report(CreateReportRequest(**body(site_id="sanford", lat=lat, lon=lon, species="Snake", note="TEST")), pool)
    flood = create_report(CreateReportRequest(**body(site_id="sanford", lat=lat, lon=lon, category="flooding", note="TEST")), pool)
    old = create_report(CreateReportRequest(**body(site_id="sanford", lat=lat, lon=lon, category="downed_line", note="TEST")), pool)
    conn.execute("UPDATE reports SET created_at = now() - interval '3 days' WHERE id = %s", (old["id"],))
    far_lat, far_lon = offset(sanford["lat"], sanford["lon"], 3.0)
    far = create_report(CreateReportRequest(**body(lat=far_lat, lon=far_lon, category="heat_illness", note="TEST")), pool)

    assert snake["species"] == "Snake" and flood["species"] is None
    assert any(r["id"] == snake["id"] and r["species"] == "Snake" for r in list_reports(200, pool))

    detail = site_data.get_site_detail(pool, "sanford")
    c = detail["conditions"]
    crew_ids = {r["id"] for r in c["crew_hazards"]["reports"]}
    assert {snake["id"], flood["id"]} <= crew_ids                  # recent and within 2 mi: included
    assert old["id"] not in crew_ids                               # 3 days old: excluded
    assert far["id"] not in crew_ids                               # 3 miles away: excluded
    assert c["flood"]["hazard_status"] in ("watch", "danger")
    assert c["flood"]["reading"].startswith("Crew report: Flooding or washout")
    assert all(r["id"] != old["id"] for r in c["crew_hazards"]["reports"])   # the old downed line doesn't count
    assert any(s["species"] == "Snake (crew report)" for s in c["wildlife"])
    assert "Heat illness" not in c["heat"].get("reading", "")       # the far heat-illness report doesn't count


# ---------- briefing ----------

def test_downed_line_or_heat_illness_raise_go_to_caution():
    assert go_status(1.0, 0, [], ["downed_line"]) == "caution"
    assert go_status(1.0, 0, [], ["heat_illness"]) == "caution"
    assert go_status(1.0, 0, [], ["flooding"]) == "go"


def test_template_mentions_crew_reports_and_stays_grounded():
    from tests.test_briefing import CALM
    inputs = {**CALM, "go_status": "caution", "crew_reports_last_48_h_within_2_mi": [
        {"category": "Downed line", "reported": "2 h ago", "reported_at": "4 PM", "distance_mi": 0.8},
        {"category": "Heat illness", "reported": "5 h ago", "reported_at": "1 PM", "distance_mi": 1.2}]}
    w = writer.template(inputs)
    assert any("downed line 0.8 mi away, reported 2 h ago" in r for r in w.risks)
    assert any("heat illness" in r for r in w.risks)
    assert any("energized" in a for a in w.actions) and any("water, shade and rest" in a for a in w.actions)
    assert writer.problems(w.text, inputs) == []


def test_briefing_cannot_invent_a_downed_line():
    from tests.test_briefing import CALM
    assert writer.unsupported_claims("Watch for the downed line near the gate", {**CALM, "crew_reports_last_48_h_within_2_mi": []})
