from fastapi import APIRouter, Depends, HTTPException, status
from psycopg_pool import ConnectionPool

from app.db import get_pool
from app.schemas import ReplayStatus, StartReplayRequest
from lightning import replay

router = APIRouter(prefix="/replay", tags=["replay"])


@router.post("/start", response_model=ReplayStatus, status_code=status.HTTP_202_ACCEPTED)
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


@router.post("/stop", response_model=ReplayStatus)
async def stop_replay():
    await replay.runner.stop()
    return replay.runner.status()


@router.get("/status", response_model=ReplayStatus)
def replay_status():
    return replay.runner.status()
