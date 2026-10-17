"""System clock: real UTC normally, simulated during lightning replay.

Anything time-based (recent flashes, alert countdowns) must use clock.now(), never
datetime.now(), so replay behaves exactly like live.
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone

# (simulated time at origin, time.monotonic() at origin, speed multiplier) while replaying.
_sim: tuple[datetime, float, float] | None = None


def now() -> datetime:
    if _sim is None:
        return datetime.now(timezone.utc)
    origin, real_origin, speed = _sim
    return origin + timedelta(seconds=(time.monotonic() - real_origin) * speed)


def real_now() -> datetime:
    """Real UTC even during replay: for live lightning, which keeps running while a replay plays."""
    return datetime.now(timezone.utc)


def is_simulated() -> bool:
    return _sim is not None


def start_simulation(origin: datetime, speed: float) -> None:
    global _sim
    _sim = (origin, time.monotonic(), speed)


def stop_simulation() -> None:
    global _sim
    _sim = None


async def sleep_until(moment: datetime) -> None:
    """Sleep until clock.now() >= moment, in real seconds scaled by the replay speed."""
    while (remaining := (moment - now()).total_seconds()) > 0:
        speed = _sim[2] if _sim else 1.0
        await asyncio.sleep(min(remaining / speed, 1.0))
