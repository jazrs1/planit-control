# Web push notifications

Code: `backend/push/notify.py` (what is sent when), `backend/push/webpush.py` (subscriptions, sending), `backend/app/routers/push.py` (routes) · Migration `009_push_notifications.sql` · Tests: `backend/tests/test_push.py`

Phones and browsers get a notification when a site's safety state changes, even with the app closed.

## What is sent

| When | Title | Body |
|---|---|---|
| A lightning stop-work starts | `STOP WORK: <site>, lightning 3.2 mi away` | "Shelter now. All clear no earlier than 4:12 PM EDT; every new strike within 10 mi resets the countdown." |
| A "lightning approaching" advisory starts | `Lightning possible within the hour at <site>` | "Storm to the WSW, moving about 18 mph. A heads-up, not a stop-work order." |
| A stop-work clears | `All clear at <site>` | "No lightning within 10 mi for 30 minutes. The stop-work is lifted." |
| A flood-risk alert starts | `Flood alert: <site>` | The NWS warning's end time, or "2+ inches of rain in 12 hours at a flood-prone site". |
| After the 6 PM briefings (each timezone's run) | One site: `Tomorrow at <site>: CAUTION`, with the briefing headline. Several: `Tomorrow's safety briefings are ready` | "No-go: Big Bend. Caution: 6 sites. Go: 47 sites." |

- **Who gets what:** each subscription chooses sites (or all sites) and gets only those sites' notifications. The role (`crew` / `supervisor`) is stored but doesn't change what is sent yet.
- **Replay:** replay alerts and advisories push too, titled `[REPLAY] …` with `replay: true`, so the demo works on a real phone.
- **One notification per site:** approaching, stop-work and all clear share the tag `lightning:<site>`, so each replaces the last on the phone and it always shows the latest state. Flood uses `flood:<site>`, briefings `briefings`.
- **Times** are in the site's timezone, like everywhere else.
- **The approaching text never gives a countdown.** Arrival estimates run late (`docs/lightning-forecast.md`).
- **Expiry:** a push service keeps trying an offline phone for 30 minutes for lightning (6 h for flood, 12 h for briefings), then drops it. A stale "STOP WORK" never shows up hours later.
- **Not sent:** stop-work extensions (every new strike would buzz the phone), flood alert updates and clears, and briefings from `POST /briefing/send-now`.

## How it stays safe

- **A push failure can never affect an alert.** The alert engine, the forecast, the flood rule and the briefing loop only call `notify.*` after their transaction commits. Those calls queue the work on one background thread and return at once; they never raise. The sender only reads `alerts`, `alert_events` and `lightning_advisories`, in its own transactions. The tests check that alert rows are identical after a dispatch, even when sending crashes.
- **No duplicates.** Each event has a key, claimed in `push_log` with `INSERT … ON CONFLICT DO NOTHING` before anything is sent:
  - `alert_event:<id>` (stop-work, all clear, flood)
  - `advisory:<id>`
  - `briefing:<site>:<date>`

  A claimed key is never sent again, across retries, restarts or a second API process. The tradeoff: a send that fails isn't retried.
- **Missed calls are caught.** A sweep every minute picks up events from the last 10 minutes (60 simulated minutes during a replay) that nobody claimed, e.g. after a restart right after a commit. Older events are never pushed, so a server that was down doesn't send stale alerts.
- **"Restart" all clears are skipped.** The engine sometimes closes an expired countdown and opens a new stop-work in the same cycle. The all clear is then skipped, so a phone doesn't get "All clear" and "STOP WORK" in the same second.
- **Dead subscriptions are removed.** When a push service answers 404 or 410, the subscription is deleted. Nothing else deletes one on the spot. Timeouts, 5xx answers and sends cut off by the deadline are logged with the subscription id (never the endpoint, which works like a password) and counted in `failures`; a delivery resets the count. A push service having a bad hour never costs a crew its alerts.
- **One slow subscription can't hold up the others.**
  - **Parallel:** every send of a notification runs at the same time, up to 32 at once.
  - **Short timeouts:** each request to the push service has a 4 s timeout, and the whole fan-out stops waiting after 15 s. Whatever hasn't answered by then counts as a failure, and the next notification goes out straight away.
  - **Healthy first:** subscriptions with no recent failures are sent to before failing ones.
- **The server only posts to real push services.** It POSTs to the endpoint the browser gave it, so `POST /push/subscribe` accepts only https endpoints on the browser push services: FCM `*.googleapis.com` (Chrome, Edge, Android, Samsung, Brave, Opera), Mozilla `*.mozilla.com`, Apple `*.push.apple.com` and WNS `*.notify.windows.com`.

## Subscription limits

| Limit | Value | Response |
|---|---|---|
| New subscriptions per client network | 100 per hour (an IPv4 address, or an IPv6 /64), enough for a crew yard behind one NAT | 429 with `Retry-After` |
| Subscriptions in total | 1,000 | 503 "Push subscriptions are full" |
| The same push keys under a second endpoint | refused: a browser makes fresh keys for every subscription | 409 |
| The push service answers 404 or 410 | deleted right away | — |
| Still failing, with nothing delivered for 7 days | deleted by the hourly prune | — |

**What counts:**
- **Duplicates never count.** Re-subscribing an existing endpoint is an update (200, same `id`): it never makes a second row and never counts against the caps. Only new endpoints count, and only when they're saved.
- **Quiet weeks are safe.** The 7-day rule only applies to a subscription that is failing (`failures > 0`). One with nothing to send, or one whose browser never opens the app, is never deleted for that.
- **What resets the 7 days:** a delivered notification, a subscribe or re-subscribe, or a test.

**How it's implemented:**
- **The per-client limit** is kept in memory, since the API runs one worker (`docs/deploy.md`); it starts over on a restart. Behind Caddy, uvicorn's `--proxy-headers` gives the real client address.
- **The total cap** is checked under a database lock, so two requests at once can't both take the last place.
- **The numbers** are constants: `NEW_PER_CLIENT` in `app/routers/push.py`, and the rest in `push/webpush.py` and `push/notify.py`.

## Setup

1. **Keys, once:** `cd backend && python -m scripts.generate_vapid_keys`. This writes `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` into `backend/.env` and prints only the public key. Never regenerate them after devices subscribe: every subscription is tied to the public key.
2. **Contact:** set `VAPID_SUBJECT` to the frontend's origin (e.g. `https://planit.example.com`) or `mailto:name@host`. An https URL **with a path is rejected** by pywebpush, and an invalid subject turns push off (routes answer 503).
3. **Migrations:** `python -m scripts.migrate` (009 and 010).
4. **The server:** gets the same keys through `deploy/copy-to-server.sh`, which also forces `PUSH_ENABLED=true` there. Set `PUSH_ENABLED=false` on every other machine that uses the shared database (`docs/deploy.md`).

Without the keys or the migrations, the `/push/*` routes answer 503 and nothing is sent. Alerts work as before.

## API

| Method | Path | Body → response |
|---|---|---|
| GET | `/push/public-key` | → `PushPublicKey` `{public_key}`: base64url, for `applicationServerKey` |
| POST | `/push/subscribe` | `PushSubscribeRequest` `{subscription, site_ids, role}` → 201 `PushSubscriptionInfo` (new) or 200 (an endpoint that's already subscribed: its sites and role are replaced). `site_ids: null` means all sites. 422 for an unknown site, an empty list, or an endpoint that isn't a browser push service; 409 for another subscription's keys; 429 and 503 for the limits above |
| POST | `/push/unsubscribe` | `{endpoint}` → `{removed}` |
| POST | `/push/test` | `{endpoint}` → `{sent, removed}`: one test notification, at most every 10 s (429). `removed: true` means the push service said it's gone, so subscribe again. 404 for an unknown endpoint |

Every push carries the JSON `PushNotification`: `{title, body, kind, site_id, replay, url, tag, sent_at}`. The examples are in `shared/mocks/push_notifications.json`.

## What the frontend needs

The frontend has a manifest (`app/manifest.ts`, `display: standalone`) but no service worker yet.

1. **A service worker**, e.g. `public/sw.js`, registered at scope `/`:
   ```js
   self.addEventListener("push", (event) => {
     const n = event.data.json();                      // PushNotification
     event.waitUntil(self.registration.showNotification(n.title, {
       body: n.body, tag: n.tag, renotify: true, data: { url: n.url },
       icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
       requireInteraction: n.kind === "stop_work",     // stays on screen until dismissed (desktop)
     }));
   });
   self.addEventListener("notificationclick", (event) => {
     event.notification.close();
     event.waitUntil(clients.openWindow(event.notification.data.url));
   });
   ```
2. **A "Get alerts on this device" control** (crew page and site page). Call `Notification.requestPermission()` only from a click; browsers block it otherwise. Then:
   ```js
   const { public_key } = await api.pushPublicKey();          // GET /push/public-key
   const reg = await navigator.serviceWorker.ready;
   const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: public_key });
   await api.pushSubscribe({ subscription: sub.toJSON(), site_ids: chosenSites /* or null */, role });
   ```
   Decode `public_key` (base64url) into a `Uint8Array` before passing it: not every browser accepts the string.
3. **Site choice:** "All sites", or a list, and the role (crew / supervisor). Keep the endpoint (`sub.endpoint`) to call `/push/unsubscribe` and `/push/test` later. **"Send test notification"** calls `/push/test`. If it returns `removed: true`, subscribe again.
4. **Re-subscribe on every load** if `pushManager.getSubscription()` returns one: POST it again (200). It refreshes the server's copy if the browser rotated it. Show 429 ("too many new subscriptions from this network, try later") and 503 ("notifications are full") as plain messages. On 409, unsubscribe in the browser (`sub.unsubscribe()`) and subscribe again.
5. **iPhone:** web push works only after **Add to Home Screen** (iOS 16.4+), from the installed app. Show that hint on iOS Safari when the app isn't installed.
6. **Treat it as an extra, not the alert itself.** The app stays the source of truth. A notification can arrive late or not at all, because phones in battery saver delay pushes. Don't present "no notification" as "all clear".
7. **Types** are in `shared/types.ts`: `PushPublicKey`, `PushSubscribeRequest`, `WebPushSubscription`, `PushSubscriptionInfo`, `PushEndpointRequest`, `PushUnsubscribeResponse`, `PushTestResponse`, `PushNotification`. In demo-data mode, use the matching mocks and don't subscribe.

## Limits

- **No authentication on subscribe:** anyone who can reach the API can subscribe a browser, and get the same alerts the dashboard shows publicly.
- **Delivery isn't guaranteed or ordered.** Push services batch and delay, especially on phones in battery saver. A failed send is logged, not retried.
- **Big fan-outs are slower.** With 1,000 subscriptions and 32 sends at a time, a notification takes a few seconds to reach everyone, and notifications go out one after another.
- **The per-client limit isn't airtight.** It's per process and resets on restart, and someone with many networks can get around it. The total cap is the real backstop.
