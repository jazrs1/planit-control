import pytest

from alerts import engine
from lightning import health


@pytest.fixture(autouse=True)
def lightning_feed_current(monkeypatch):
    """Tests see a current lightning feed unless they say otherwise (the stall tests patch it), so an
    expired live alert is cleared and hidden as usual. Real health is in-memory and empty in tests."""
    monkeypatch.setattr(engine, "feed_current", lambda now: True)


@pytest.fixture(autouse=True)
def lightning_health_not_stalled(monkeypatch):
    """A stall marked by one test (health.mark_stalled) never leaks into the next."""
    monkeypatch.setattr(health, "_stalled", set())
