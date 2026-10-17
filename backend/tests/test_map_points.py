"""Map points for the layers panel: GET /fires/recent and GET /wildlife/recent.

Database tests run inside one rolled-back transaction (skipped without DATABASE_URL) and only look
at their own rows: the shared database has real detections and sightings too."""

import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from app.cache import api_cache
from app.config import BACKEND_DIR, get_settings
from app.db import get_pool
from app.routers import fires as fires_route
from app.routers import wildlife as wildlife_route
from app.schemas import FireDetection, WildlifeSightingPoint
from hazards import map_points

NOW = datetime(2026, 10, 17, 18, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
BIG_BEND = (27.7944, -82.4036)
NOWHERE = (25.3000, -81.0000)        # Everglades, far from every plant


def det(lat, lon, ts, satellite="N20", confidence="nominal"):
    return {"lat": lat, "lon": lon, "ts": ts, "satellite": satellite, "confidence": confidence}


def test_plant_hot_spots_are_left_off_the_map():
    near_plant = det(BIG_BEND[0] + 0.003, BIG_BEND[1], NOW)      # ~0.2 mi from Big Bend's stacks
    points = map_points.fire_points([near_plant, det(*NOWHERE, NOW)])
    assert [(p["lat"], p["lon"]) for p in points] == [NOWHERE]


def test_passes_count_separate_satellite_passes_within_5_miles():
    lat, lon = NOWHERE
    points = map_points.fire_points([
        det(lat, lon, NOW - 60 * MIN, "N20"),
        det(lat + 0.01, lon, NOW - 58 * MIN, "N20"),       # same satellite, 2 min later: the same pass
        det(lat + 0.02, lon, NOW - 30 * MIN, "N21"),       # another satellite: a second pass
        det(lat + 0.50, lon, NOW - 10 * MIN, "N"),         # 35 miles north: on its own
    ])
    by_lat = {round(p["lat"], 2): p["passes_24h"] for p in points}
    assert by_lat == {25.30: 2, 25.31: 2, 25.32: 2, 25.80: 1}
    assert [p["detected_at"] for p in points] == sorted((p["detected_at"] for p in points), reverse=True)


def test_neighbors_across_grid_cells_still_count():
    # 25.299 and 25.301 straddle a 0.1-degree grid line; they're 0.14 mi apart.
    points = map_points.fire_points([det(25.299, -81.0, NOW, "N20"), det(25.301, -81.0, NOW - 60 * MIN, "N21")])
    assert {p["passes_24h"] for p in points} == {2}


def test_odd_confidence_reads_as_nominal():
    assert map_points.fire_points([det(*NOWHERE, NOW, confidence=None)])[0]["confidence"] == "nominal"


# ---------- database ----------

class FakePool:
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


def test_fires_last_24_hours_only(conn):
    lat, lon = 25.123456, -80.987654      # an exact spot no real detection has
    for ts in (NOW - 2 * MIN, NOW - 23 * 60 * MIN, NOW - 25 * 60 * MIN):
        conn.execute("INSERT INTO fire_detections (ts, lat, lon, satellite, confidence) VALUES (%s, %s, %s, 'N20', 'high')",
                     (ts, lat, lon))
    mine = [p for p in map_points.recent_fires(conn, NOW) if (p["lat"], p["lon"]) == (lat, lon)]
    assert [p["detected_at"] for p in mine] == [NOW - 2 * MIN, NOW - 23 * 60 * MIN]


def test_wildlife_from_inaturalist_and_crew_without_notes(conn):
    conn.execute(
        """INSERT INTO wildlife_observations (id, taxon_id, species, venomous, observed_at, lat, lon, quality_grade, url, fetched_at)
           VALUES (-424242, 1, 'Test Alligator', false, %s, 25.111, -80.222, 'research', 'https://example.invalid', %s),
                  (-424243, 1, 'Old Alligator', false, %s, 25.112, -80.222, 'research', 'https://example.invalid', %s)""",
        (NOW - 60 * MIN, NOW, NOW - 31 * 24 * 60 * MIN, NOW))
    conn.execute(
        """INSERT INTO reports (site_id, lat, lon, category, species, note, photo_url, reporter_role, created_at)
           VALUES (NULL, 25.333, -80.444, 'wildlife', NULL, 'gate code 1234', 'https://example.invalid/p.jpg',
                   'crew_member', %s)""", (NOW - 5 * MIN,))
    points = map_points.recent_wildlife(conn, NOW)
    mine = [p for p in points if p["lat"] in (25.111, 25.112, 25.333)]
    assert [(p["source"], p["species"]) for p in mine] == [("crew", None), ("inaturalist", "Test Alligator")]
    assert "gate code" not in json.dumps(points, default=str)
    [WildlifeSightingPoint(**p) for p in points]


def test_routes(conn, monkeypatch):
    api_cache.invalidate()
    monkeypatch.setattr(map_points, "recent_fires", lambda c, now: [
        {"lat": 25.3, "lon": -81.0, "detected_at": NOW, "confidence": "high", "passes_24h": 2}])
    app = FastAPI()
    app.include_router(fires_route.router)
    app.include_router(wildlife_route.router)
    app.dependency_overrides[get_pool] = lambda: FakePool(conn)
    client = TestClient(app)
    assert [FireDetection(**f).passes_24h for f in client.get("/fires/recent").json()] == [2]
    assert isinstance(client.get("/wildlife/recent").json(), list)
    api_cache.invalidate()


def test_mocks_match_the_schemas():
    mocks = BACKEND_DIR.parent / "shared" / "mocks"
    [FireDetection(**f) for f in json.loads((mocks / "fires_recent.json").read_text())]
    [WildlifeSightingPoint(**w) for w in json.loads((mocks / "wildlife_recent.json").read_text())]
