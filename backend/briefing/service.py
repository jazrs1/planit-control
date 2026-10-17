"""Generate, store, and serve next-day briefings.

Every minute the loop checks each site: once it is BRIEFING_HOUR (6 PM) in the site's own
timezone and that evening's briefing for tomorrow doesn't exist yet, it is generated and stored
(one per site per day; regenerating replaces it). A server that was down at 6 PM catches up when
it starts. Uses real time, not the replay clock.
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from app.config import get_settings
from briefing import inputs as briefing_inputs
from briefing.writer import write
from hazards.store import mark_source

log = logging.getLogger(__name__)
COLUMNS = """b.site_id, s.name AS site_name, b.for_date, b.created_at AS generated_at, b.top_hazard, b.text,
             b.key_numbers, b.go_status, b.headline, b.risks, b.actions, b.top_factors, b.generator, b.model,
             b.unavailable"""


def key_numbers(inputs: dict) -> tuple[dict, list[str]]:
    """BriefingKeyNumbers from the input JSON, plus the fields that have no live data."""
    unavailable = []

    def num(value, field):
        if isinstance(value, (int, float)):
            return value
        unavailable.append(field)
        return 0

    heat, soil, fire = inputs.get("heat"), inputs.get("soil"), inputs["wildfire"]["detections_within_25_mi"]
    return {
        "hazard_index": inputs["hazard_index"],
        "max_heat_index_f": num(heat and heat["peak_heat_index_f"], "max_heat_index_f"),
        "lightning_probability_pct": max(p["thunderstorm_chance_pct"] for p in inputs["periods"]),
        "rain_in": inputs["rain_total_in"],
        "soil_moisture_pct": num(soil and soil["moisture_pct"], "soil_moisture_pct"),
        "wildfire_detections_25mi": num(fire, "wildfire_detections_25mi"),
    }, unavailable


def _store(pool: ConnectionPool, site_id: str, inputs: dict, factors: list[dict], written, now: datetime) -> None:
    numbers, unavailable = key_numbers(inputs)
    with pool.connection() as conn:
        conn.execute(
            """INSERT INTO briefings (site_id, for_date, text, created_at, go_status, top_hazard, headline, risks,
                                      actions, top_factors, key_numbers, unavailable, inputs, generator, model)
               VALUES (%(site)s, %(for_date)s, %(text)s, %(now)s, %(go)s, %(top)s, %(headline)s, %(risks)s,
                       %(actions)s, %(factors)s, %(numbers)s, %(unavailable)s, %(inputs)s, %(generator)s, %(model)s)
               ON CONFLICT (site_id, for_date) DO UPDATE SET
                   text = EXCLUDED.text, created_at = EXCLUDED.created_at, go_status = EXCLUDED.go_status,
                   top_hazard = EXCLUDED.top_hazard, headline = EXCLUDED.headline, risks = EXCLUDED.risks,
                   actions = EXCLUDED.actions, top_factors = EXCLUDED.top_factors,
                   key_numbers = EXCLUDED.key_numbers, unavailable = EXCLUDED.unavailable,
                   inputs = EXCLUDED.inputs, generator = EXCLUDED.generator, model = EXCLUDED.model""",
            {"site": site_id, "for_date": inputs["for_date"], "text": written.text, "now": now,
             "go": inputs["go_status"], "top": inputs["top_hazard"], "headline": written.headline,
             "risks": Jsonb(written.risks), "actions": Jsonb(written.actions), "factors": Jsonb(factors),
             "numbers": Jsonb(numbers), "unavailable": unavailable, "inputs": Jsonb(inputs),
             "generator": written.generator, "model": written.model})
    from app.cache import api_cache

    api_cache.invalidate()   # GET /briefings shows it on the next request


def generate(pool: ConnectionPool, site_ids: list[str] | None = None, now: datetime | None = None) -> list[str]:
    """Build inputs, write, and store briefings for tomorrow. Returns the site ids done.

    Gemini calls are slow (up to ~90 s each), so GEMINI_CONCURRENCY are written at once (the writer
    spaces their starts), and each briefing is stored as soon as it's written, so they appear one
    by one instead of all at the end.
    """
    now = now or datetime.now(timezone.utc)
    built = briefing_inputs.build_all(pool, site_ids, now)

    def write_and_store(item: tuple[str, tuple[dict, list[dict]]]) -> str:
        site_id, (inputs, factors) = item
        _store(pool, site_id, inputs, factors, write(inputs), now)
        return site_id

    with ThreadPoolExecutor(max_workers=get_settings().gemini_concurrency) as workers:
        done = list(workers.map(write_and_store, built.items()))
    log.info("Briefings generated for %d sites", len(done))
    return done


def latest_all(pool: ConnectionPool) -> list[dict]:
    """The latest briefing for every site that has one, largest plant first (like /sites)."""
    with pool.connection() as conn:
        return conn.execute(
            f"""SELECT * FROM (
                    SELECT DISTINCT ON (b.site_id) {COLUMNS}, s.capacity_mw
                    FROM briefings b JOIN sites s ON s.id = b.site_id
                    ORDER BY b.site_id, b.for_date DESC, b.created_at DESC) latest
                ORDER BY capacity_mw DESC, site_id""").fetchall()


def latest(pool: ConnectionPool, site_id: str) -> dict | None:
    with pool.connection() as conn:
        return conn.execute(
            f"""SELECT {COLUMNS} FROM briefings b JOIN sites s ON s.id = b.site_id
                WHERE b.site_id = %s ORDER BY b.for_date DESC, b.created_at DESC LIMIT 1""", (site_id,)).fetchone()


def due_sites(pool: ConnectionPool, now: datetime) -> list[str]:
    """Sites where it is past BRIEFING_HOUR locally and tonight's briefing for tomorrow is missing."""
    hour = get_settings().briefing_hour
    with pool.connection() as conn:
        sites = conn.execute("SELECT id, timezone FROM sites").fetchall()
        existing = {(r["site_id"], r["for_date"]): r["created_at"] for r in conn.execute(
            "SELECT site_id, for_date, created_at FROM briefings WHERE for_date >= %s",
            ((now - timedelta(days=1)).date(),)).fetchall()}
    return [s["id"] for s in sites if is_due(now, ZoneInfo(s["timezone"]), hour, existing.get(
        (s["id"], now.astimezone(ZoneInfo(s["timezone"])).date() + timedelta(days=1))))]


def is_due(now: datetime, tz: ZoneInfo, hour: int, made_at: datetime | None) -> bool:
    """True once it's `hour` o'clock in the site's timezone and tomorrow's briefing wasn't made
    since then (an earlier send-now doesn't count: the 6 PM one uses fresher data)."""
    local = now.astimezone(tz)
    send_at = datetime.combine(local.date(), time(hour), tz)
    return local >= send_at and (made_at is None or made_at < send_at)


async def run_loop(pool: ConnectionPool) -> None:
    """Never raises (except on cancellation)."""
    while True:
        now = datetime.now(timezone.utc)
        try:
            due = await asyncio.to_thread(due_sites, pool, now)
            if due:
                await asyncio.to_thread(generate, pool, due, now)
                mark_source(pool, "briefings", now, detail=f"{len(due)} briefings generated")
        except Exception as err:  # noqa: BLE001 - try again later; the API must keep running
            log.warning("Briefing run failed, retrying in 10 min: %s: %s", type(err).__name__, err)
            try:
                mark_source(pool, "briefings", now, error=f"{type(err).__name__}: {err}"[:500])
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(600)
        await asyncio.sleep(60)


def to_response(row: dict) -> dict:
    """DB row -> Briefing (shared/types.ts)."""
    row = {k: v for k, v in row.items() if k != "capacity_mw"}
    return {**row, "for_date": row["for_date"].isoformat(), "unavailable": row["unavailable"] or []}



