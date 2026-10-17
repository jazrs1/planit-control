"""Hook between lightning ingestion and the alert engine.

on_new_flashes() runs once per ingestion cycle, after that cycle's flashes are committed to
lightning_flashes and the lightning_flashes_5m_by_site rollup has been refreshed:
  - live:   every ~20 s (lightning/live.py)
  - replay: once per GLM file, i.e. every 20 s of simulated time (lightning/replay.py)
It also runs when a cycle found no new flashes, so the engine can clear alerts whose
30-minute countdown has run out.

Rules for the engine:
  - Use `now` for every time comparison, never datetime.now(). During replay `now` is the
    simulated clock (also available as app.clock.now()).
  - `flashes` covers Florida plus ~30 mi. Apply the stop-work radius yourself, e.g. with
    lightning.geo.nearest_site_miles(), miles_between() in SQL, or the 5-minute rollup.
  - Exceptions are logged and swallowed by the caller, so a bug here can't stop ingestion.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # glm.py imports this module, so avoid a runtime import cycle
    from lightning.glm import Flash


def on_new_flashes(flashes: list[Flash], now: datetime) -> None:
    # TODO(alerts): call the alert engine here, e.g. alert_engine.process(flashes, now).
    return None
