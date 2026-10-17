-- Real hazard data: per-site static lookups, NWS alerts, fire detections, wildlife sightings,
-- and source health. Numeric readings go in the conditions hypertable (001).

-- One-time lookups per site (null until looked up; *_checked_at records the attempt).
ALTER TABLE sites
    ADD COLUMN fema_flood_zone      text,          -- NFHL FLD_ZONE, e.g. 'AE', 'VE', 'X'; 'unmapped' if no panel
    ADD COLUMN fema_sfha            boolean,       -- in a Special Flood Hazard Area (1%-annual-chance floodplain)
    ADD COLUMN fema_checked_at      timestamptz,
    ADD COLUMN river_name           text,          -- nearest named river within 1 mile (USGS NHD), if any
    ADD COLUMN near_river           boolean,
    ADD COLUMN river_checked_at     timestamptz,
    ADD COLUMN nws_forecast_zone    text,          -- e.g. 'FLZ151'
    ADD COLUMN nws_county_zone      text,          -- e.g. 'FLC057'
    ADD COLUMN nws_fire_zone        text,
    ADD COLUMN nws_zones_checked_at timestamptz;

-- Active NWS alerts (latest poll), and which sites each one covers.
CREATE TABLE nws_alerts (
    id           text PRIMARY KEY,                -- NWS alert id
    event        text NOT NULL,                   -- e.g. 'Flood Warning', 'Heat Advisory'
    severity     text,
    headline     text,
    sender_name  text,
    onset        timestamptz,
    ends_at      timestamptz,                     -- 'ends', or 'expires' when NWS gives no end
    fetched_at   timestamptz NOT NULL
);
CREATE TABLE site_nws_alerts (
    site_id   text NOT NULL REFERENCES sites (id),
    alert_id  text NOT NULL REFERENCES nws_alerts (id) ON DELETE CASCADE,
    PRIMARY KEY (site_id, alert_id)
);

-- NASA FIRMS VIIRS fire detections over Florida (hypertable, like lightning_flashes).
CREATE TABLE fire_detections (
    ts          timestamptz NOT NULL,             -- acquisition time (UTC)
    lat         double precision NOT NULL,
    lon         double precision NOT NULL,
    satellite   text NOT NULL,                    -- 'N' (Suomi NPP), 'N20', 'N21'
    confidence  text,                             -- 'low' | 'nominal' | 'high'
    frp_mw      double precision,                 -- fire radiative power
    UNIQUE (ts, lat, lon, satellite)
);
SELECT create_hypertable('fire_detections', by_range('ts', INTERVAL '7 days'));

-- iNaturalist sightings of alligators and venomous snakes near our sites.
CREATE TABLE wildlife_observations (
    id             bigint PRIMARY KEY,            -- iNaturalist observation id
    taxon_id       integer NOT NULL,
    species        text NOT NULL,                 -- common name, e.g. 'Florida Cottonmouth'
    venomous       boolean NOT NULL,
    observed_at    timestamptz NOT NULL,
    lat            double precision NOT NULL,
    lon            double precision NOT NULL,
    quality_grade  text NOT NULL,                 -- 'research' | 'needs_id'
    url            text NOT NULL,
    fetched_at     timestamptz NOT NULL
);
CREATE INDEX wildlife_observations_observed_idx ON wildlife_observations (observed_at DESC);

-- Health of each external source: when it last worked, and the last error if any.
CREATE TABLE data_sources (
    name             text PRIMARY KEY,            -- 'open-meteo', 'nws-alerts', 'firms', 'inaturalist', ...
    last_success_at  timestamptz,
    last_attempt_at  timestamptz,
    last_error       text,
    detail           text                         -- e.g. 'skipped: FIRMS_MAP_KEY not set'
);

-- Flood-risk alerts may have no fixed all-clear time (they clear when conditions ease).
ALTER TABLE alert_events ALTER COLUMN all_clear_at DROP NOT NULL;
