-- "Lightning approaching" advisories (alerts/approach.py): a storm cell's leading edge is projected
-- to reach a site's 10-mile ring within 60 minutes. Advisories are NOT stop-work alerts: they live in
-- their own table, so the forecast can never change, shorten or clear a stop-work.
-- Numbered 008 because PR #14 (ml-model) adds 007; the two are independent.
CREATE TABLE lightning_advisories (
    id                text PRIMARY KEY DEFAULT 'adv_' || substr(md5(gen_random_uuid()::text), 1, 12),
    site_id           text NOT NULL REFERENCES sites (id),
    replay            boolean NOT NULL DEFAULT false,
    status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'cleared', 'superseded')),  -- superseded: a stop-work began
    started_at        timestamptz NOT NULL,             -- engine clock when first issued
    updated_at        timestamptz NOT NULL,             -- last cycle a cell still projected an arrival
    ended_at          timestamptz,                      -- cleared or superseded at
    arrival_at        timestamptz NOT NULL,             -- latest estimate: leading edge reaches 10 mi
    first_arrival_at  timestamptz NOT NULL,             -- the estimate when first issued
    from_bearing_deg  double precision NOT NULL,        -- where the storm is, seen from the site
    heading_deg       double precision NOT NULL,        -- direction the storm is moving
    speed_mph         double precision NOT NULL,
    distance_mi       double precision NOT NULL,        -- leading edge to the site, at updated_at
    cell_flashes      integer NOT NULL                  -- flashes in the cell over the last 20 minutes
);
CREATE UNIQUE INDEX lightning_advisories_one_active ON lightning_advisories (site_id, replay) WHERE status = 'active';
CREATE INDEX lightning_advisories_site_started_idx ON lightning_advisories (site_id, started_at DESC);
