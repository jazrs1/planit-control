"""Hook between lightning ingestion and the alert engine.

on_new_flashes() runs once per ingestion cycle, after that cycle's flashes are committed to
lightning_flashes and the lightning_flashes_5m_by_site rollup has been refreshed:
  - live:   every ~20 s (lightning/live.py)
  - replay: once per GLM file, i.e. every 20 s of simulated time (lightning/replay.py)
It also runs when a cycle found no new flashes, so the engine can clear alerts whose
30-minute countdown has run out.

Rules for the engine:
  - Use `now` for every time comparison, never datetime.now() or app.clock.now(). Live and replay
    cycles can run at the same time: a live cycle gets real time and replay=False, a replay cycle
    the simulated time and replay=True.
  - `flashes` covers Florida plus ~30 mi. Apply the stop-work radius yourself, e.g. with
    lightning.geo.nearest_site_miles(), miles_between() in SQL, or the 5-minute rollup.
  - Exceptions are logged and swallowed by the caller, so a bug here can't stop ingestion.

After the stop-work engine, the "lightning approaching" forecast (alerts/approach.py) runs in its own
transaction and its own try/except: it sees this cycle's stop-work alerts, and a failure in it can
never affect them.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # glm.py imports this module, so avoid a runtime import cycle
    from lightning.glm import Flash

log = logging.getLogger(__name__)


def on_new_flashes(flashes: list[Flash], now: datetime, *, replay: bool = False) -> None:
    from alerts import approach, engine

    # Replay writes its own alerts (alerts.replay = true) so it never touches live ones.
    engine.run(flashes, now, replay=replay)
    try:
        approach.run(now, replay=replay)
    except Exception:  # noqa: BLE001 - the forecast must never disturb stop-work alerts
        log.exception("Lightning approach forecast failed (stop-work alerts are unaffected)")
