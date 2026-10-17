"""NWS gridpoint rain forecast: parsing, totals, failures (no network)."""
from datetime import datetime, timedelta, timezone

from hazards.sources import nws_qpf

T0 = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)   # 8 AM EDT


def test_six_hour_blocks_in_mm_become_hourly_inches():
    series = nws_qpf.hourly([{"validTime": "2026-10-18T12:00:00+00:00/PT6H", "value": 25.4 * 0.6},
                             {"validTime": "2026-10-18T18:00:00+00:00/P1DT6H", "value": 0.0},
                             {"validTime": "2026-10-20T00:00:00+00:00/PT1H", "value": None}])
    assert len(series) == 6 + 30 + 1
    assert abs(nws_qpf.total(series, T0, T0 + timedelta(hours=3)) - 0.3) < 1e-9     # half the block
    assert abs(nws_qpf.total(series, T0, T0 + timedelta(days=3)) - 0.6) < 1e-9


def test_nws_failure_returns_none(monkeypatch):
    nws_qpf._cache.clear()
    nws_qpf._grid_urls.clear()

    def down(*a, **k):
        raise TimeoutError("api.weather.gov timed out")
    monkeypatch.setattr(nws_qpf.http, "get_json", down)
    assert nws_qpf.forecast({"id": "s", "lat": 26.07, "lon": -80.2}) is None


def test_forecast_is_cached_per_grid(monkeypatch):
    nws_qpf._cache.clear()
    nws_qpf._grid_urls.clear()
    calls = []

    def get_json(url, *a, **k):
        calls.append(url)
        if "/points/" in url:
            return {"properties": {"forecastGridData": "https://api.weather.gov/gridpoints/MFL/110,50"}}
        return {"properties": {"quantitativePrecipitation": {"uom": "wmoUnit:mm", "values": [
            {"validTime": "2026-10-18T12:00:00+00:00/PT6H", "value": 6.0}]}}}
    monkeypatch.setattr(nws_qpf.http, "get_json", get_json)
    site = {"id": "s", "lat": 26.07, "lon": -80.2}
    assert nws_qpf.forecast(site) == nws_qpf.forecast(site)
    assert len(calls) == 2                                   # one /points, one gridpoint; the second call is cached
