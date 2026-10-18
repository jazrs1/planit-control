import pytest

from alerts import engine


@pytest.fixture(autouse=True)
def lightning_feed_current(monkeypatch):
    """Tests see a current lightning feed unless they say otherwise (the stall tests patch it), so an
    expired live alert is cleared and hidden as usual. Real health is in-memory and empty in tests."""
    monkeypatch.setattr(engine, "feed_current", lambda now: True)
