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

After the stop-work engine, the "lightning approaching" forecast (alerts/approach.py) runs on a
background worker, in its own transaction and its own try/except: it sees this cycle's stop-work
alerts, and a failure in it can never affect them.

Push notifications (push/notify.py) are queued after the stop-work engine and the forecast commit,
on their own background thread: a push failure can't affect either. Ingestion never waits for it: if the previous
cycle's forecast (same mode) is still running, this cycle's is skipped. Live cycles are 20 s apart,
so live gets a forecast every cycle; a 30x replay cycles every 0.67 s, and a forecast takes
0.3-0.45 s (reading up to ~6,000 flashes and clustering them), which used to slow the replay to ~20x.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # glm.py imports this module, so avoid a runtime import cycle
    from lightning.glm import Flash

log = logging.getLogger(__name__)

_forecast_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lightning-forecast")
_forecast_busy = {False: threading.Lock(), True: threading.Lock()}   # per mode: a forecast queued or running


def on_new_flashes(flashes: list[Flash], now: datetime, *, replay: bool = False) -> None:
    from alerts import engine

    from push import notify

    # Replay writes its own alerts (alerts.replay = true) so it never touches live ones.
    summary = engine.run(flashes, now, replay=replay)
    notify.stop_work_cycle(summary, now, replay=replay)   # committed; queues any push, never raises
    if _forecast_busy[replay].acquire(blocking=False):
        _forecast_pool.submit(_forecast, now, replay)
    else:
        log.debug("Lightning forecast still running; skipped at %s", now.isoformat(timespec="seconds"))


def _forecast(now: datetime, replay: bool) -> None:
    from alerts import approach
    from push import notify

    try:
        notify.forecast_cycle(approach.run(now, replay=replay), now, replay=replay)
    except Exception:  # noqa: BLE001 - the forecast must never disturb stop-work alerts
        log.exception("Lightning approach forecast failed (stop-work alerts are unaffected)")
    finally:
        _forecast_busy[replay].release()


def wait_for_forecast() -> None:
    """Block until queued forecasts have run (for tests)."""
    _forecast_pool.submit(lambda: None).result()
