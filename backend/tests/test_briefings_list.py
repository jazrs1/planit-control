"""GET /briefings: the latest briefing for every site, one per site, in one response."""

import json

import pytest

from app.cache import TTLCache
from tests.test_crew_reports import FakePool, conn  # noqa: F401 - reuse the rolled-back DB fixture


def test_one_latest_briefing_per_site(conn, monkeypatch):  # noqa: F811
    from app.routers import briefing as route
    monkeypatch.setattr(route, "api_cache", TTLCache())
    sites_with = conn.execute("SELECT count(DISTINCT site_id) AS n FROM briefings").fetchone()["n"]
    if not sites_with:
        pytest.skip("no briefings generated yet")
    # An older briefing for a site must not be returned instead of its latest one.
    newest = conn.execute("SELECT site_id, for_date FROM briefings ORDER BY for_date DESC LIMIT 1").fetchone()
    conn.execute("""INSERT INTO briefings (site_id, for_date, text, created_at) VALUES
                    (%s, %s - 30, 'OLD TEST', now() - interval '30 days')""", (newest["site_id"], newest["for_date"]))
    body = json.loads(route.list_briefings(FakePool(conn)).body)
    ids = [b["site_id"] for b in body]
    assert len(ids) == len(set(ids)) == sites_with
    assert all(b["text"] != "OLD TEST" for b in body)
