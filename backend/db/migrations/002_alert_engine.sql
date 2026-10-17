-- Alert engine support: separate replay alerts from live ones, and keep a history of every
-- alert change (the alerts table only holds each alert's current state).

-- Alerts created while replaying a past storm. Live and replay alerts never merge or clear
-- each other, and the API only shows the kind matching the current clock.
ALTER TABLE alerts ADD COLUMN replay boolean NOT NULL DEFAULT false;

DROP INDEX alerts_one_active_per_site_type;
CREATE UNIQUE INDEX alerts_one_active_per_site_type ON alerts (site_id, type, replay) WHERE status = 'active';

-- One row per change: created, extended (countdown reset by a newer strike), cleared.
CREATE TABLE alert_events (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    alert_id            text NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    event               text NOT NULL CHECK (event IN ('created', 'extended', 'cleared')),
    at                  timestamptz NOT NULL,     -- when it happened: strike time, or all_clear_at for 'cleared'
    recorded_at         timestamptz NOT NULL,     -- engine clock (`now`) when the engine noticed
    strike_distance_mi  double precision,         -- created/extended: distance of the newest strike
    all_clear_at        timestamptz NOT NULL      -- countdown end after this event
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, at);
