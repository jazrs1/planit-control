"""iNaturalist sightings of American alligators and Florida's venomous snakes near each site.

Taxon IDs were looked up through the iNaturalist API (/v1/taxa?q=<scientific name>&rank=species).
Both cottonmouth species are included: iNaturalist splits the Florida cottonmouth (A. conanti,
most of the state) from the northern cottonmouth (A. piscivorus, which reaches the panhandle).

Writes per site (wildlife): observations_30d, venomous_30d (within 5 km, last 30 days).
"""

import time
from datetime import datetime, timedelta

from psycopg_pool import ConnectionPool

from hazards import http
from hazards.store import write_readings

NAME = "inaturalist"
API = "https://api.inaturalist.org/v1/observations"
RADIUS_KM = 5
DAYS = 30
TAXA = {  # taxon_id: (common name, venomous)
    26159: ("American Alligator", False),        # Alligator mississippiensis
    53491: ("Eastern Diamondback Rattlesnake", True),  # Crotalus adamanteus
    904173: ("Florida Cottonmouth", True),       # Agkistrodon conanti
    904170: ("Northern Cottonmouth", True),      # Agkistrodon piscivorus
    73867: ("Eastern Coralsnake", True),         # Micrurus fulvius
    30983: ("Pygmy Rattlesnake", True),          # Sistrurus miliarius
}


def fetch_site(site: dict, now: datetime) -> list[dict]:
    data = http.get_json(API, {
        "taxon_id": ",".join(str(t) for t in TAXA), "lat": site["lat"], "lng": site["lon"],
        "radius": RADIUS_KM, "d1": (now - timedelta(days=DAYS)).date().isoformat(),
        "quality_grade": "research,needs_id", "per_page": 200, "order_by": "observed_on",
    }, retries=2)
    observations = []
    for o in data["results"]:
        taxon_id = next((t for t in [o["taxon"]["id"], *o["taxon"].get("ancestor_ids", [])] if t in TAXA), None)
        when = o.get("time_observed_at") or o.get("observed_on")
        if taxon_id is None or not when or not o.get("location"):
            continue
        lat, lon = (float(x) for x in o["location"].split(","))
        name, venomous = TAXA[taxon_id]
        observations.append({"id": o["id"], "taxon_id": taxon_id, "species": name, "venomous": venomous,
                             "observed_at": when, "lat": lat, "lon": lon, "quality_grade": o["quality_grade"],
                             "url": o.get("uri") or f"https://www.inaturalist.org/observations/{o['id']}"})
    return observations


def poll(pool: ConnectionPool, sites: list[dict], now: datetime) -> str:
    rows, total = [], 0
    for site in sites:
        observations = fetch_site(site, now)
        if observations:
            with pool.connection() as conn, conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO wildlife_observations (id, taxon_id, species, venomous, observed_at, lat, lon,
                                                          quality_grade, url, fetched_at)
                       VALUES (%(id)s, %(taxon_id)s, %(species)s, %(venomous)s, %(observed_at)s, %(lat)s, %(lon)s,
                               %(quality_grade)s, %(url)s, %(fetched_at)s)
                       ON CONFLICT (id) DO UPDATE SET quality_grade = EXCLUDED.quality_grade,
                                                      fetched_at = EXCLUDED.fetched_at""",
                    [{**o, "fetched_at": now} for o in observations])
        total += len(observations)
        rows += [(site["id"], now, "wildlife", "observations_30d", float(len(observations)), NAME),
                 (site["id"], now, "wildlife", "venomous_30d", float(sum(o["venomous"] for o in observations)), NAME)]
        time.sleep(1.0)  # iNaturalist asks for about one request per second
    write_readings(pool, rows)
    return f"{total} sightings near {len(sites)} sites"
