-- PlanIT Control initial schema for Tiger Data (TimescaleDB).
-- Applied by: cd backend && python -m scripts.migrate
-- Never edit a migration that has been applied; add 002_*.sql instead.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Great-circle distance in miles. IMMUTABLE so the continuous aggregate below can use it.
CREATE FUNCTION miles_between(lat1 double precision, lon1 double precision,
                              lat2 double precision, lon2 double precision)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN 3958.8 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
));

-- ---------- sites: one row per EIA plant, seeded from data/sites.json ----------
CREATE TABLE sites (
    plant_id     integer PRIMARY KEY,                 -- EIA plant id
    id           text NOT NULL UNIQUE,                -- API site id (slug, e.g. 'big-bend'); other tables reference this
    name         text NOT NULL,
    utility      text NOT NULL,
    county       text NOT NULL,
    lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon          double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    technology   text NOT NULL,
    capacity_mw  double precision NOT NULL,
    timezone     text NOT NULL                        -- IANA, e.g. 'America/Chicago'
);

-- ---------- conditions: hazard readings per site over time (hypertable) ----------
-- Long/narrow: one row per (site, hazard, metric, time), so a new data source needs no schema change.
-- Categorical readings are numeric codes, e.g. flood status 0 none, 1 advisory, 2 watch, 3 warning.
CREATE TABLE conditions (
    site_id  text NOT NULL REFERENCES sites (id),
    ts       timestamptz NOT NULL,
    hazard   text NOT NULL CHECK (hazard IN ('heat', 'lightning', 'flood', 'soil', 'wildfire', 'wildlife')),
    metric   text NOT NULL,                           -- e.g. 'heat_index_f', 'moisture_pct'
    value    double precision NOT NULL,
    source   text NOT NULL,                           -- e.g. 'nws', 'firms', 'usgs:02323500'
    PRIMARY KEY (site_id, hazard, metric, ts)         -- also makes re-ingesting idempotent (ON CONFLICT)
);
SELECT create_hypertable('conditions', by_range('ts', INTERVAL '7 days'));

-- ---------- lightning_flashes: raw statewide flashes (hypertable) ----------
CREATE TABLE lightning_flashes (
    ts           timestamptz NOT NULL,
    lat          double precision NOT NULL,
    lon          double precision NOT NULL,
    energy       double precision,                    -- flash energy as reported by the source (GLM: joules)
    source_file  text NOT NULL                        -- lets ingest skip files it already loaded
);
SELECT create_hypertable('lightning_flashes', by_range('ts', INTERVAL '1 day'));
CREATE INDEX lightning_flashes_source_file_idx ON lightning_flashes (source_file);

-- ---------- alerts ----------
CREATE TABLE alerts (
    id                       text PRIMARY KEY DEFAULT 'alt_' || substr(md5(gen_random_uuid()::text), 1, 12),
    site_id                  text NOT NULL REFERENCES sites (id),
    type                     text NOT NULL CHECK (type IN ('lightning', 'heat', 'flood', 'wildfire')),
    status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cleared')),
    started_at               timestamptz NOT NULL DEFAULT now(),
    all_clear_at             timestamptz,             -- lightning: last_strike_at + 30 min
    last_strike_at           timestamptz,
    last_strike_distance_mi  double precision
);
-- At most one active alert per site and type: a new strike updates it instead of opening another.
CREATE UNIQUE INDEX alerts_one_active_per_site_type ON alerts (site_id, type) WHERE status = 'active';
CREATE INDEX alerts_site_started_idx ON alerts (site_id, started_at DESC);

-- ---------- hazard_scores: ML model output (hypertable) ----------
CREATE TABLE hazard_scores (
    site_id    text NOT NULL REFERENCES sites (id),
    scored_at  timestamptz NOT NULL DEFAULT now(),
    for_date   date NOT NULL,                         -- site-local date the score is for (today or tomorrow)
    score      double precision NOT NULL CHECK (score BETWEEN 0 AND 10),
    factors    jsonb NOT NULL DEFAULT '[]',           -- ContributingFactor[] (shared/types.ts)
    PRIMARY KEY (site_id, for_date, scored_at)
);
SELECT create_hypertable('hazard_scores', by_range('scored_at', INTERVAL '30 days'));
CREATE INDEX hazard_scores_site_scored_idx ON hazard_scores (site_id, scored_at DESC);

-- ---------- reports: crew hazard reports ----------
CREATE TABLE reports (
    id             text PRIMARY KEY DEFAULT 'rpt_' || substr(md5(gen_random_uuid()::text), 1, 12),
    site_id        text REFERENCES sites (id),        -- null for reports away from a tracked site
    lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon            double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    category       text NOT NULL CHECK (category IN ('downed_line', 'flooding', 'wildlife', 'fire_smoke',
                                                     'heat_illness', 'unsafe_ground', 'other')),
    note           text NOT NULL,
    photo_url      text NOT NULL,
    reporter_role  text NOT NULL CHECK (reporter_role IN ('crew_member', 'foreman', 'safety_officer')),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_created_idx ON reports (created_at DESC);
CREATE INDEX reports_site_created_idx ON reports (site_id, created_at DESC);

-- ---------- briefings: 6 PM next-day briefing per site ----------
CREATE TABLE briefings (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id     text NOT NULL REFERENCES sites (id),
    for_date    date NOT NULL,
    text        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, for_date)                        -- also serves lookups by site
);

-- ---------- Continuous aggregate: flashes per site per 5 minutes within 10 miles ----------
-- TimescaleDB keeps this rollup up to date incrementally, so "how many flashes near site X in the
-- last 30 minutes" reads a few small rows instead of scanning every raw flash in Florida.
-- materialized_only = false: queries also include flashes newer than the last refresh.
CREATE MATERIALIZED VIEW lightning_flashes_5m_by_site
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    time_bucket(INTERVAL '5 minutes', f.ts)          AS bucket,
    s.id                                             AS site_id,
    count(*)                                         AS flash_count,
    min(miles_between(s.lat, s.lon, f.lat, f.lon))   AS nearest_mi
FROM lightning_flashes f
JOIN sites s ON miles_between(s.lat, s.lon, f.lat, f.lon) <= 10
GROUP BY bucket, s.id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('lightning_flashes_5m_by_site',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes');
