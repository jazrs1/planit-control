const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, overrides = {}, globals = {}) {
  const exports = {};
  const filename = path.join(__dirname, "..", file);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    exports, ...globals,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.join(__dirname, "..", `${relative}.tsx`)) ? ".tsx" : ".ts"), overrides, globals);
      }
      if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.slice(8)));
      return require(name);
    },
  }, { filename });
  return exports;
}
class ApiRequestError extends Error { constructor(message, status) { super(message); this.status = status; } }
const preferences = { role: "crew", site_ids: ["big-bend"] };

function device(options = {}) {
  const calls = [], posts = [], updates = [], storage = new Map();
  if (options.preferences) storage.set("planit-control.push-preferences", JSON.stringify({ ...options.preferences, disabled: options.disabled ?? false }));
  let current = null, serial = 0;
  const makeSubscription = () => {
    const json = { endpoint: `https://fcm.googleapis.com/device-${++serial}`, expirationTime: null, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
    return { endpoint: json.endpoint, toJSON: () => json, unsubscribe: async () => { calls.push("browser unsubscribe"); if (options.browserFails) throw Error("browser failed"); current = null; return true; } };
  };
  if (options.existing) current = makeSubscription();
  const notification = { permission: options.permission ?? (options.existing ? "granted" : "default"), requestPermission: () => {
    calls.push("permission"); notification.permission = options.answer ?? "granted"; return Promise.resolve(notification.permission);
  } };
  const registration = { pushManager: {
    getSubscription: async () => current,
    subscribe: async (input) => { calls.push({ subscribe: input }); current = makeSubscription(); return current; },
  } };
  const window = { isSecureContext: options.secure ?? true, PushManager: class {}, Notification: notification,
    matchMedia: () => ({ matches: options.standalone ?? false }),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.storageBlocked) throw Error("blocked"); storage.set(key, value); } },
  };
  const navigator = { userAgent: options.ua ?? "Desktop Safari", platform: "Win32", maxTouchPoints: 0,
    serviceWorker: { register: async (url, init) => { calls.push({ register: url, scope: init.scope }); return registration; }, ready: Promise.resolve(registration) },
  };
  const api = {
    ApiRequestError,
    getPushPublicKey: async () => { calls.push("public key"); return { public_key: "AQID-_8" }; },
    subscribePush: async (body) => { calls.push("server subscribe"); posts.push(body); if (options.serverFails) throw Error("offline"); return { id: "sub-1", site_ids: body.site_ids, role: body.role, created_at: "2026-10-17T18:00:00Z", updated_at: "2026-10-17T18:00:00Z" }; },
    testPush: async (body) => { calls.push({ test: body }); if (options.testError) throw new ApiRequestError("test failed", options.testError); return options.testResult ?? { sent: true, removed: false }; },
    unsubscribePush: async (body) => { calls.push({ unsubscribe: body }); if (options.removeFails) throw Error("offline"); return { removed: true }; },
  };
  const module = load("lib/push.ts", { "@/lib/api": api }, { window, navigator, Notification: notification, atob });
  const client = new module.DevicePush(state => updates.push(state));
  return { client, calls, posts, storage, options, updates, module, get subscription() { return current; }, notification };
}

test("load never prompts or creates a subscription; only enable asks before any asynchronous setup", async () => {
  const d = device();
  await d.client.initialize();
  assert.equal(d.client.state.phase, "off");
  assert.equal(d.calls.includes("permission"), false);
  assert.equal(d.calls.includes("public key"), false);
  assert.equal(d.posts.length, 0);
  const pending = d.client.enable(preferences);
  assert.equal(d.calls.at(-1), "permission", "permission is requested synchronously from the click action");
  await pending;
  assert.equal(d.client.state.phase, "registered");
  const subscriptionCall = d.calls.find(value => value.subscribe)?.subscribe;
  assert.equal(subscriptionCall.userVisibleOnly, true);
  assert.deepEqual(Array.from(subscriptionCall.applicationServerKey), [1, 2, 3, 251, 255]);
  assert.equal(d.posts[0].subscription, d.subscription.toJSON(), "send the browser's JSON, including expirationTime, unchanged");
  assert.equal(d.posts[0].site_ids, preferences.site_ids);
  assert.equal(d.posts[0].role, "crew");
  assert.deepEqual(JSON.parse([...d.storage.values()][0]), { ...preferences, disabled: false });
  assert.doesNotMatch([...d.storage.values()].join(""), /endpoint|auth-key|p256dh-key/);
});

test("existing subscriptions refresh quietly with saved sites and role, including all sites", async () => {
  for (const site_ids of [["big-bend", "crist"], null]) {
    const d = device({ existing: true, preferences: { role: "supervisor", site_ids } });
    await d.client.initialize();
    assert.equal(d.client.state.phase, "registered");
    assert.equal(d.posts.length, 1);
    assert.equal(JSON.stringify(d.posts[0].site_ids), JSON.stringify(site_ids));
    assert.equal(d.posts[0].role, "supervisor");
    assert.equal(d.posts[0].subscription, d.subscription.toJSON());
    assert.equal(d.calls.includes("permission"), false);
    assert.equal(d.calls.includes("public key"), false);
    assert.equal(d.calls.some(value => value.subscribe), false);
  }
});

test("permission denial/dismissal and empty site choices cannot register a device", async () => {
  for (const answer of ["denied", "default"]) {
    const d = device({ answer }); await d.client.initialize(); await d.client.enable(preferences);
    assert.equal(d.posts.length, 0);
    assert.equal(d.client.state.phase, answer === "denied" ? "blocked" : "off");
    assert.equal(d.calls.includes("public key"), false);
  }
  const d = device(); await d.client.initialize();
  await d.client.enable({ role: "crew", site_ids: [] });
  assert.equal(d.calls.includes("permission"), false);
  assert.match(d.client.state.message, /at least one site/);
});

test("a server failure never pretends registration succeeded; retry preserves browser subscription and choices", async () => {
  const d = device({ serverFails: true });
  await d.client.initialize(); await d.client.enable(preferences);
  assert.equal(d.client.state.phase, "unconfirmed");
  assert.equal(d.client.state.canUnsubscribe, true);
  const subscription = d.subscription;
  d.options.serverFails = false; await d.client.enable(preferences);
  assert.equal(d.client.state.phase, "registered");
  assert.equal(d.subscription, subscription);
  assert.equal(d.calls.filter(value => value === "permission").length, 1);
  const quiet = device({ existing: true, serverFails: true, preferences });
  await quiet.client.initialize();
  assert.equal(quiet.client.state.phase, "unconfirmed");
  assert.equal(quiet.client.state.canUnsubscribe, true);
});

test("a removed test subscription is renewed and posted again without another permission prompt", async () => {
  const d = device({ existing: true, preferences, testResult: { sent: false, removed: true } });
  await d.client.initialize();
  const old = d.subscription.endpoint;
  await d.client.sendTest();
  assert.notEqual(d.subscription.endpoint, old);
  assert.equal(d.posts.length, 2);
  assert.equal(d.posts.at(-1).subscription.endpoint, d.subscription.endpoint);
  assert.equal(d.posts.at(-1).role, "crew");
  assert.equal(JSON.stringify(d.posts.at(-1).site_ids), JSON.stringify(preferences.site_ids));
  assert.equal(d.calls.includes("permission"), false);
  assert.match(d.client.state.message, /renewed.*another test/);
  assert.equal(d.calls.filter(value => value.test).length, 1);
  assert.equal(d.client.state.phase, "registered");
});

test("test results distinguish accepted, failed, throttled, unknown and unsuccessfully renewed subscriptions", async () => {
  for (const options of [
    { testResult: { sent: true, removed: false }, message: /accepted.*delayed/ },
    { testResult: { sent: false, removed: false }, message: /not confirmed/ },
    { testError: 429, message: /10 seconds/ },
    { testError: 503, message: /not confirmed/ },
    { testError: 404, message: /restored.*another test/ },
  ]) {
    const d = device({ existing: true, preferences, ...options }); await d.client.initialize(); await d.client.sendTest();
    assert.match(d.client.state.message, options.message);
    assert.equal(d.calls.includes("permission"), false);
  }
  const d = device({ existing: true, preferences, testResult: { sent: false, removed: true } });
  await d.client.initialize(); d.options.serverFails = true; await d.client.sendTest();
  assert.equal(d.client.state.phase, "unconfirmed");
});

test("unsubscribe removes browser and server copies; a partial failure stays retryable and cannot quietly re-enable", async () => {
  const d = device({ existing: true, preferences, removeFails: true });
  await d.client.initialize(); const endpoint = d.subscription.endpoint; await d.client.unsubscribe();
  assert.equal(d.subscription, null);
  assert.equal(d.client.state.phase, "unconfirmed");
  assert.match(d.client.state.message, /server removal is not confirmed/);
  assert.equal(JSON.parse([...d.storage.values()][0]).disabled, true);
  d.options.removeFails = false; await d.client.unsubscribe();
  assert.equal(d.client.state.phase, "off");
  assert.equal(d.client.state.canUnsubscribe, false);
  assert.equal(d.calls.filter(value => value.unsubscribe).at(-1).unsubscribe.endpoint, endpoint);
  const failedBrowser = device({ existing: true, preferences, browserFails: true });
  await failedBrowser.client.initialize(); await failedBrowser.client.unsubscribe();
  assert.equal(failedBrowser.client.state.phase, "unconfirmed");
  const reloaded = device({ existing: true, preferences, disabled: true }); await reloaded.client.initialize();
  assert.equal(reloaded.posts.length, 0);
  assert.equal(reloaded.client.state.phase, "unconfirmed");
  assert.equal(reloaded.client.state.canUnsubscribe, true);
});

test("iPhone Safari gets the Home Screen hint; installed iOS and unsupported/insecure browsers remain explicit", async () => {
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1";
  const safari = device({ ua }); await safari.client.initialize();
  assert.equal(safari.client.state.iphoneHint, true);
  assert.equal(safari.client.state.phase, "unsupported");
  assert.equal(safari.calls.length, 0);
  const installed = device({ ua, standalone: true }); await installed.client.initialize();
  assert.equal(installed.client.state.iphoneHint, false);
  assert.equal(installed.client.state.phase, "off");
  const insecure = device({ secure: false }); await insecure.client.initialize();
  assert.match(insecure.client.state.message, /HTTPS or localhost/);
});

test("enabling after partial removal finishes the old removal before registering and later removes the new endpoint", async () => {
  const d = device({ existing: true, preferences, removeFails: true });
  await d.client.initialize(); const old = d.subscription.endpoint;
  await d.client.unsubscribe();
  d.options.removeFails = false;
  await d.client.enable({ role: "supervisor", site_ids: null });
  assert.equal(d.client.state.phase, "registered");
  const current = d.subscription.endpoint;
  assert.notEqual(current, old);
  await d.client.unsubscribe();
  assert.equal(d.calls.filter(value => value.unsubscribe).at(-1).unsubscribe.endpoint, current);
  assert.equal(d.client.state.phase, "off");
});

test("blocked localStorage is safe and disposed initialization cannot update a new page or mode", async () => {
  const d = device({ storageBlocked: true }); await d.client.initialize(); await d.client.enable(preferences);
  assert.equal(d.client.state.phase, "registered");
  const disposed = device({ existing: true });
  const pending = disposed.client.initialize(); disposed.client.dispose(); const updates = disposed.updates.length; await pending;
  assert.equal(disposed.updates.length, updates);
  assert.equal(disposed.posts.length, 0);
});

test("settings have labeled site/role controls, live confirmation, demo-disabled actions and a delivery warning", () => {
  const state = { phase: "registered", busy: false, canUnsubscribe: true, restored: false, preferences, message: "Device registered", enable() {}, sendTest() {}, unsubscribe() {} };
  const connection = { level: "online" };
  const Component = load("components/PushSettings.tsx", {
    "@/components/PushProvider": { useDevicePush: () => state },
    "@/components/AlertsProvider": { useAlertsState: () => ({ connection }) },
  }).default;
  const draw = () => renderToStaticMarkup(React.createElement(Component, { sites: [{ id: "big-bend", name: "Big Bend" }], defaultSiteId: "big-bend", defaultRole: "crew" }));
  let html = draw();
  for (const text of ["Get alerts on this device", "Your role", "All sites", "Choose sites", "Big Bend", "Save alert preferences", "Send test notification", "Unsubscribe", "No notification does not mean all clear"]) assert.ok(html.includes(text), text);
  connection.level = "offline"; assert.match(draw(), /Last confirmed registration/);
  state.phase = "demo"; state.message = "Demo data · sample registration";
  html = draw(); assert.match(html, /Demo data/);
  assert.match(html, /disabled=""[^>]*>Send test notification/);
  assert.match(html, /disabled=""[^>]*>Get alerts on this device/);
  state.iphoneHint = true; assert.match(draw(), /Add to Home Screen.*iOS 16\.4/);
});

test("the demo provider uses the shared sample and never initializes or mutates browser push", async () => {
  let initialized = 0;
  const effects = [];
  const sample = require("../../shared/mocks/push_subscription.json");
  const Provider = load("components/PushProvider.tsx", {
    react: { ...React, useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], useRef: value => ({ current: value }), useEffect: fn => effects.push(fn), useMemo: fn => fn() },
    "@/components/AlertsProvider": { useAlertsState: () => ({ status: "demo" }) },
    "@/lib/api": { DEMO_DATA: { pushSubscription: sample } },
    "@/lib/push": { INITIAL_PUSH_STATE: {}, DevicePush: class { initialize() { initialized++; } } },
  }).PushProvider;
  const mode = Provider({ children: null });
  const context = mode.type(mode.props);
  effects.forEach(fn => fn());
  assert.equal(context.props.value.phase, "demo");
  assert.equal(context.props.value.info, sample);
  await context.props.value.enable(preferences);
  await context.props.value.sendTest();
  await context.props.value.unsubscribe();
  assert.equal(initialized, 0);
});

function worker() {
  const events = {}, shown = [], opened = [];
  const self = {
    location: { origin: "https://planit.test" },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async url => opened.push(url) },
    skipWaiting: async () => {}, addEventListener: (name, fn) => { events[name] = fn; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8"), { self, URL });
  return { events, shown, opened, self };
}

test("worker shows the backend's title/body/tag/url and keeps stop-work visible without inventing fallback alerts", async () => {
  const sw = worker();
  const message = { title: "[REPLAY] STOP WORK: Big Bend", body: "Shelter now", tag: "lightning:big-bend", url: "/sites/big-bend", kind: "stop_work" };
  let pending;
  sw.events.push({ data: { json: () => message }, waitUntil: promise => { pending = promise; } }); await pending;
  assert.equal(sw.shown[0].title, message.title);
  assert.equal(sw.shown[0].options.body, message.body);
  assert.equal(sw.shown[0].options.tag, message.tag);
  assert.equal(sw.shown[0].options.data.url, "https://planit.test/sites/big-bend");
  assert.equal(sw.shown[0].options.requireInteraction, true);
  assert.equal(sw.shown[0].options.renotify, true);
  sw.events.push({ data: null });
  sw.events.push({ data: { json: () => { throw Error("bad JSON"); } } });
  sw.events.push({ data: { json: () => ({}) } });
  assert.equal(sw.shown.length, 1);
  assert.equal(eventsFetch(sw.events), false, "no service-worker caching of live safety responses");
});
function eventsFetch(events) { return "fetch" in events; }

test("notification clicks close the notification and open or focus the correct frontend URL", async () => {
  const sw = worker();
  let closed = 0, pending;
  const click = async url => { sw.events.notificationclick({ notification: { data: { url }, close: () => { closed++; } }, waitUntil: promise => { pending = promise; } }); await pending; };
  await click("/briefings"); assert.equal(sw.opened[0], "https://planit.test/briefings");
  await click("https://outside.test"); assert.equal(sw.opened[1], "https://planit.test/alerts");
  await click("javascript:alert(1)"); assert.equal(sw.opened[2], "https://planit.test/alerts");
  await click(undefined); assert.equal(sw.opened[3], "https://planit.test/alerts");
  let focused = 0;
  sw.self.clients.matchAll = async () => [{ url: "https://planit.test/briefings", focus: async () => { focused++; } }];
  await click("/briefings");
  assert.equal(focused, 1); assert.equal(sw.opened.length, 4); assert.equal(closed, 5);
});
