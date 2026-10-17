"""Demo code (ADMIN_TOKEN) on replay start/stop and send-now (one site or all); send-now rate limits.

Runs the real routes in a small app with a fake pool: no database, no model calls, no replay started.
"""

from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import admin
from app.config import get_settings
from app.db import get_pool
from app.routers import briefing as briefing_route
from app.routers import replay as replay_route

CODE = {"X-Admin-Token": "s3cret-demo"}


class FakePool:
    @contextmanager
    def connection(self):
        class Conn:
            def execute(self, *a):
                class Row:
                    def fetchone(self):
                        return {"n": 55}
                return Row()
        yield Conn()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(get_settings(), "admin_token", "s3cret-demo")
    admin.send_all_limit.reset()
    admin.send_site_limit.reset()
    monkeypatch.setattr(briefing_route, "_all_running", False)
    generated = []
    monkeypatch.setattr(briefing_route.service, "generate", lambda pool, ids: generated.append(ids) or ["x"])
    monkeypatch.setattr(briefing_route.service, "latest", lambda pool, site_id: None)
    sample = next(iter(briefing_route.mocks.load("briefings").values()))
    monkeypatch.setattr(briefing_route.service, "to_response", lambda row: sample)
    monkeypatch.setattr(replay_route.replay, "available_windows", lambda: [])   # never start a real replay
    app = FastAPI()
    app.include_router(replay_route.router)
    app.include_router(briefing_route.router)
    app.dependency_overrides[get_pool] = FakePool
    c = TestClient(app)
    c.generated = generated
    return c


def test_replay_start_and_stop_need_the_demo_code(client):
    for path in ("/replay/start", "/replay/stop"):
        assert client.post(path).status_code == 401
        assert client.post(path, headers={"X-Admin-Token": "wrong"}).status_code == 401
    assert client.post("/replay/start", headers=CODE).status_code == 404     # past the check: no replay files here
    assert client.post("/replay/stop", headers=CODE).status_code == 200
    assert client.get("/replay/status").status_code == 200                   # read-only stays open


def test_without_admin_token_configured_the_actions_are_off(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "admin_token", "")
    assert client.post("/replay/start", headers=CODE).status_code == 503
    assert client.post("/briefing/send-now", json={}, headers=CODE).status_code == 503


def test_send_all_needs_the_code_and_runs_at_most_once_per_15_minutes(client, monkeypatch):
    assert client.post("/briefing/send-now", json={}).status_code == 401
    assert client.post("/briefing/send-now", json={}).status_code == 401      # failed tries don't use the window
    first = client.post("/briefing/send-now", json={}, headers=CODE)
    assert first.status_code == 202 and first.json() == {"generated": [], "queued": 55}
    monkeypatch.setattr(briefing_route, "_all_running", False)               # the background run finished
    again = client.post("/briefing/send-now", json={}, headers=CODE)
    assert again.status_code == 429 and 14 * 60 < int(again.headers["Retry-After"]) <= 15 * 60
    assert "15 min" in again.json()["detail"]


def test_send_all_is_refused_while_a_run_is_in_progress(client, monkeypatch):
    monkeypatch.setattr(briefing_route, "_all_running", True)
    assert client.post("/briefing/send-now", json={}, headers=CODE).status_code == 409


def test_one_site_needs_the_code_and_runs_at_most_once_a_minute(client):
    assert client.post("/briefing/send-now", json={"site_id": "sanford"}).status_code == 401
    assert client.post("/briefing/send-now", json={"site_id": "sanford"}, headers={"X-Admin-Token": "no"}).status_code == 401
    assert client.generated == []                                             # no model call without the code
    assert client.post("/briefing/send-now", json={"site_id": "sanford"}, headers=CODE).status_code == 200
    again = client.post("/briefing/send-now", json={"site_id": "sanford"}, headers=CODE)
    assert again.status_code == 429 and 0 < int(again.headers["Retry-After"]) <= 60
    assert client.post("/briefing/send-now", json={"site_id": "big-bend"}, headers=CODE).status_code == 200   # per site
    assert client.generated == [["sanford"], ["big-bend"]]
