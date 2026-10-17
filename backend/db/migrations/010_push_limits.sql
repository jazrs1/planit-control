-- Limits on push subscriptions (app/routers/push.py, push/webpush.py; docs/push-notifications.md).

-- When the browser last showed up (subscribed, re-subscribed on page load, or sent a test). Rows not
-- seen for 14 days are no longer sent to and are deleted by the hourly prune.
ALTER TABLE push_subscriptions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX push_subscriptions_last_seen_idx ON push_subscriptions (last_seen_at);

-- A browser makes fresh keys for every subscription, so the same p256dh key under a second endpoint
-- is a copied or made-up subscription: rejected.
CREATE UNIQUE INDEX push_subscriptions_p256dh_idx ON push_subscriptions ((keys ->> 'p256dh'));
