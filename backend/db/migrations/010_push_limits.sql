-- Limits on push subscriptions (app/routers/push.py, push/webpush.py; docs/push-notifications.md).

-- The last time we know the subscription worked: the browser subscribed, re-subscribed or sent a test,
-- or a notification was delivered. Used only to drop a subscription that has failed for 7 days.
ALTER TABLE push_subscriptions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX push_subscriptions_last_seen_idx ON push_subscriptions (last_seen_at);

-- A browser makes fresh keys for every subscription, so the same p256dh key under a second endpoint
-- is a copied or made-up subscription: refused. Rows that already share a key keep only the most
-- recently updated one, so the unique index below can be built.
DELETE FROM push_subscriptions a
USING push_subscriptions b
WHERE a.keys ->> 'p256dh' = b.keys ->> 'p256dh'
  AND (a.updated_at, a.id) < (b.updated_at, b.id);
CREATE UNIQUE INDEX push_subscriptions_p256dh_idx ON push_subscriptions ((keys ->> 'p256dh'));
