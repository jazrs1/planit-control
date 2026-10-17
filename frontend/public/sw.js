// This worker handles notifications only. Live safety responses are never cached here.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function notificationUrl(path) {
  try {
    if (typeof path !== "string" || !path) throw new Error("Missing notification URL");
    const url = new URL(path, self.location.origin);
    if (url.origin === self.location.origin && /^https?:$/.test(url.protocol)) return url.href;
  } catch { /* Invalid links open the current alerts page. */ }
  return new URL("/alerts", self.location.origin).href;
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    /** @type {import("../../shared/types").PushNotification} */
    const message = event.data.json();
    if (!message || typeof message.title !== "string" || typeof message.body !== "string" || typeof message.tag !== "string") return;
    event.waitUntil(self.registration.showNotification(message.title, {
      body: message.body, tag: message.tag, renotify: true,
      data: { url: notificationUrl(message.url) },
      icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      requireInteraction: message.kind === "stop_work",
    }));
  } catch { /* Malformed payloads must never invent a safety state. */ }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationUrl(event.notification.data?.url ?? "/alerts");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url === url) { await client.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
