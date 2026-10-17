from fastapi import APIRouter, Depends, HTTPException, Response, status
from psycopg_pool import ConnectionPool
from pydantic import TypeAdapter

from app.admin import require_admin
from app.cache import api_cache
from app.db import get_pool
from app.schemas import ReplayEvent, ReplaySeries, ReplayStatus, StartReplayRequest
from lightning import replay, timeline

router = APIRouter(prefix="/replay", tags=["replay"])


@router.post("/start", response_model=ReplayStatus, status_code=status.HTTP_202_ACCEPTED,
             dependencies=[Depends(require_admin)])
async def start_replay(body: StartReplayRequest | None = None, pool: ConnectionPool = Depends(get_pool)):
    body = body or StartReplayRequest()
    windows = replay.available_windows()
    if not windows:
        raise HTTPException(404, "No replay data. Run: cd backend && python -m scripts.find_replay_window")
    window = body.window or windows[-1]
    if window not in windows:
        raise HTTPException(404, f"Unknown window '{window}'. Available: {', '.join(windows)}")
    try:
        replay.runner.start(pool, window, body.speed)
    except RuntimeError as err:
        raise HTTPException(409, str(err))
    return replay.runner.status()


@router.post("/stop", response_model=ReplayStatus, dependencies=[Depends(require_admin)])
async def stop_replay():
    await replay.runner.stop()
    return replay.runner.status()


@router.get("/status", response_model=ReplayStatus)
def replay_status():
    return replay.runner.status()


_events = TypeAdapter(list[ReplayEvent])
_series = TypeAdapter(ReplaySeries)


def _timeline_or_503(window: str) -> dict:
    found = timeline.get(window)
    if found is None:
        timeline.ensure(window)
        raise HTTPException(503, "The replay timeline is being prepared (about 30 s the first time); retry shortly.",
                            headers={"Retry-After": "5"})
    return found


@router.get("/events", response_model=list[ReplayEvent])
def replay_events():
    """Every event of the current or most recent replay run's storm, oldest first: stop-work starts,
    approach starts and all clears, at simulated times. The whole storm is listed as soon as the replay
    starts (lightning/timeline.py works it out ahead of time with the same rules), so show only events
    at or before ReplayStatus.simulated_now. Replay only: never live events. [] before any replay."""
    window = replay.runner.window
    if window is None:
        return Response(b"[]", media_type="application/json")
    found = _timeline_or_503(window)
    return Response(api_cache.get_or_compute(("replay-events", window),
                                             lambda: _events.dump_json(_events.validate_python(timeline.events(found)))),
                    media_type="application/json")


@router.get("/series", response_model=ReplaySeries)
def replay_series():
    """Flashes and sites in stop-work per 5-minute bin (simulated time), from the window's start through
    the bin holding the replay's simulated now (or where the last run ended). The bin still in progress
    only counts up to now. Empty bins before any replay."""
    window, until = replay.runner.window, replay.runner.simulated_until()
    if window is None or until is None:
        return {"bin_minutes": 5, "bins": []}
    found = _timeline_or_503(window)
    key = ("replay-series", window, int(until.timestamp()) // 20)   # one entry per replay cycle
    return Response(api_cache.get_or_compute(key, lambda: _series.dump_json(_series.validate_python(
        {"bin_minutes": 5, "bins": timeline.series(found, until)}))), media_type="application/json")
