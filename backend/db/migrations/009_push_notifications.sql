-- Web push notifications (backend/push/, docs/push-notifications.md).

-- One row per browser subscription (PushSubscription.toJSON() from the browser). Re-subscribing
-- the same endpoint updates its sites and role.
CREATE TABLE push_subscriptions (
    id            text PRIMARY KEY DEFAULT 'sub_' || substr(md5(gen_random_uuid()::text), 1, 12),
    endpoint      text NOT NULL UNIQUE,              -- the push service URL (a secret: never log it)
    keys          jsonb NOT NULL CHECK (keys ? 'p256dh' AND keys ? 'auth'),
    site_ids      text[],                            -- null: all sites
    role          text NOT NULL CHECK (role IN ('crew', 'supervisor')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_sent_at  timestamptz,
    failures      integer NOT NULL DEFAULT 0         -- consecutive failed sends (404/410 delete the row)
);

-- One row per notification-worthy event, claimed before sending, so each event is pushed once even
-- with retries, restarts or two API processes. Keys: 'alert_event:<id>', 'advisory:<id>',
-- 'briefing:<site>:<date>'.
CREATE TABLE push_log (
    event_key   text PRIMARY KEY,
    kind        text NOT NULL,                       -- stop_work, approaching, all_clear, flood, briefings
    site_id     text,
    replay      boolean NOT NULL DEFAULT false,
    claimed_at  timestamptz NOT NULL DEFAULT now(),
    sent        integer,                             -- subscriptions it reached (null while sending)
    skipped     text                                 -- why it wasn't sent, e.g. 'all clear followed by a new stop-work'
);

-- The sender looks for recent alert events each time alerts change.
CREATE INDEX alert_events_recorded_idx ON alert_events (recorded_at);
