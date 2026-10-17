"""The hazard model, live: score every site after each weather poll and store each scoring run.

    weather poll (hourly) -> forecasts already fetched for the cards
      -> ML weather score for each site's local today and tomorrow (ml/model.py), no extra API calls
      -> hybrid index from hazards/risk.predict() with the current rules
      -> one hazard_scores row per site and day: score/factors (hybrid) + model_* (the ML part)

Between runs, /sites and the briefing read the latest model_* back (latest()) and recombine it with
the rules live, so the lightning override and new crew reports show up immediately.
"""

import logging
from datetime import datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from hazards.store import mark_source

log = logging.getLogger(__name__)

NAME = "hazard-model"   # data_sources row: last run, or why scoring failed
HISTORY_DAYS = 7


@lru_cache(maxsize=1)
def model():
    """The trained model (loaded once). Imported lazily so the API starts even if LightGBM can't load."""
    from ml.model import HazardModel
    return HazardModel.load()


def model_version() -> str:
    return model().meta["trained_at"]


def components(sites: list[dict], forecasts: list[dict], now: datetime) -> dict[str, dict[str, dict]]:
    """{site_id: {site-local date ISO: {probability, score, factors}}} for today and tomorrow, from the
    poller's forecasts (same model, variables and units the hazard model was trained on)."""
    import pandas as pd

    from ml.features import hourly_frame_unix, site_features

    rows, keys = [], []
    for site, forecast in zip(sites, forecasts):
        feats = site_features(site, hourly_frame_unix(forecast, site["timezone"]))
        today = pd.Timestamp(now.astimezone(ZoneInfo(site["timezone"])).date())
        tomorrow = today + pd.Timedelta(days=1)
        if today not in feats.index or tomorrow not in feats.index:
            continue
        # Tomorrow's soil moisture is today's, as in the model's day-ahead evaluation.
        feats.loc[tomorrow, "soil_moisture_pct"] = feats.loc[today, "soil_moisture_pct"]
        for day in (today, tomorrow):
            if pd.isna(feats.loc[day, "tmax_f"]):  # fewer than 20 hours of data for that day
                continue
            rows.append(feats.loc[[day]])
            keys.append((site["id"], day.date()))
    if not rows:
        return {}
    preds = model().predict(pd.concat(rows), [d for _, d in keys])
    out: dict[str, dict[str, dict]] = {}
    for (site_id, day), p in zip(keys, preds):
        out.setdefault(site_id, {})[day.isoformat()] = {
            "probability": round(p.probability, 4), "score": p.hazard_index, "factors": p.factors}
    return out


def run(pool: ConnectionPool, sites: list[dict], forecasts: list[dict], now: datetime) -> str:
    """Score every site and store the run. Never raises: the weather readings are already saved,
    and a model problem must not mark the weather poll failed."""
    from hazards import snapshot
    from hazards.risk import local_days, predict

    try:
        fresh = components(sites, forecasts, now)
        version = model_version()
        snap = snapshot.load(pool, replay=False)  # stored history is live: never replay lightning
        rows = []
        for site in snap.sites:
            inp = snap.inputs[site["id"]]
            inp.model = {**inp.model, **fresh.get(site["id"], {})}
            scored = predict(inp, snap.species_counts[site["id"]])
            today, tomorrow = local_days(inp)
            for day, index, top, factors, ml in (
                (today, scored["hazard_index_today"], scored["top_hazard"], scored["top_factors"], scored["model_today"]),
                (tomorrow, scored["hazard_index_tomorrow"], scored["top_hazard_tomorrow"],
                 scored["top_factors_tomorrow"], scored["model_tomorrow"]),
            ):
                rows.append({
                    "site_id": site["id"], "scored_at": now, "for_date": day, "score": index,
                    "factors": Jsonb(factors), "top_hazard": top,
                    "model_probability": ml["probability"] if ml else None, "model_score": ml["score"] if ml else None,
                    "model_factors": Jsonb(ml["factors"]) if ml else None,
                    "model_version": version if ml else None,
                })
        with pool.connection() as conn, conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO hazard_scores (site_id, scored_at, for_date, score, factors, top_hazard,
                                              model_probability, model_score, model_factors, model_version)
                   VALUES (%(site_id)s, %(scored_at)s, %(for_date)s, %(score)s, %(factors)s, %(top_hazard)s,
                           %(model_probability)s, %(model_score)s, %(model_factors)s, %(model_version)s)
                   ON CONFLICT (site_id, for_date, scored_at) DO NOTHING""",
                rows)
        detail = f"scored {len(fresh)} of {len(sites)} sites with the model; stored {len(rows)} hybrid scores"
        mark_source(pool, NAME, now, detail=detail)
        return detail
    except Exception as err:  # noqa: BLE001 - keep the weather poll's result; log why scoring failed
        log.warning("Hazard model scoring failed: %s: %s", type(err).__name__, err)
        try:
            mark_source(pool, NAME, now, error=f"{type(err).__name__}: {err}"[:500])
        except Exception:  # noqa: BLE001 - database may be the thing that's down
            pass
        return f"model scoring failed: {type(err).__name__}"


def latest(conn: Connection, now: datetime) -> dict[str, dict[str, dict]]:
    """{site_id: {site-local date ISO: model part}}: the newest stored model score for every site and
    day from the last two days. Empty (and logged) if migration 007 hasn't been applied yet."""
    try:
        with conn.transaction():
            rows = conn.execute(
                """SELECT DISTINCT ON (site_id, for_date) site_id, for_date, model_probability, model_score, model_factors
                   FROM hazard_scores WHERE scored_at > %s AND model_score IS NOT NULL
                   ORDER BY site_id, for_date, scored_at DESC""",
                (now - timedelta(days=2),)).fetchall()
    except psycopg.errors.UndefinedColumn:
        log.warning("hazard_scores has no model columns: run `python -m scripts.migrate` (007)")
        return {}
    out: dict[str, dict[str, dict]] = {}
    for r in rows:
        out.setdefault(r["site_id"], {})[r["for_date"].isoformat()] = {
            "probability": r["model_probability"], "score": r["model_score"],
            "factors": current_hazards(r["model_factors"] or [])}
    return out


def current_hazards(factors: list[dict]) -> list[dict]:
    """Stored model factors with their hazard re-derived from the feature (ml/model.FACTOR_HAZARD), so
    rows scored before a mapping change (e.g. gusts: lightning -> storm) read like new ones."""
    from ml.model import DEFAULT_HAZARD, FACTOR_GROUPS, FACTOR_HAZARD

    weather = [f["factor"] for f in factors
               if FACTOR_HAZARD.get(f.get("factor")) and f.get("factor") not in FACTOR_GROUPS.values()]
    fallback = FACTOR_HAZARD[weather[0]] if weather else DEFAULT_HAZARD
    return [{**f, "hazard": FACTOR_HAZARD.get(f["factor"]) or fallback} if f.get("factor") in FACTOR_HAZARD else f
            for f in factors]


def history(conn: Connection, site: dict, now: datetime, days: int = HISTORY_DAYS) -> list[dict]:
    """Stored scoring runs for one site over the last `days` days, oldest first, for today's and
    tomorrow's index as seen at each run (horizon from the run time in the site's timezone)."""
    tz = ZoneInfo(site["timezone"])
    rows = conn.execute(
        """SELECT scored_at, for_date, score, top_hazard, model_score FROM hazard_scores
           WHERE site_id = %s AND scored_at > %s ORDER BY scored_at, for_date""",
        (site["id"], now - timedelta(days=days))).fetchall()
    points = []
    for r in rows:
        ahead = (r["for_date"] - r["scored_at"].astimezone(tz).date()).days
        if ahead not in (0, 1):
            continue
        points.append({"scored_at": r["scored_at"], "for_date": r["for_date"].isoformat(),
                       "horizon": "today" if ahead == 0 else "tomorrow", "hazard_index": r["score"],
                       "top_hazard": r["top_hazard"], "model_score": r["model_score"]})
    return points


def last_run(conn: Connection) -> datetime | None:
    row = conn.execute("SELECT last_success_at FROM data_sources WHERE name = %s", (NAME,)).fetchone()
    return row["last_success_at"] if row else None
