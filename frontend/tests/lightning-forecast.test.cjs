// node --test tests/lightning-forecast.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, overrides = {}) {
  const exports = {};
  const filename = path.resolve(__dirname, "..", file);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
      if (name === "@/components/StopWorkCountdown") return { __esModule: true, default: () => React.createElement("div", { "data-countdown": true }) };
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.resolve(__dirname, "..", relative + ".tsx")) ? ".tsx" : ".ts"), overrides);
      }
      if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.slice(8)));
      return require(name);
    },
  }, { filename });
  return exports;
}

const nowMs = Date.parse("2026-10-16T20:40:00Z");
const approach = {
  arrival_at: "2026-10-16T20:57:00Z", minutes_to_arrival: 17,
  from_direction: "W", from_bearing_deg: 270, heading_deg: 90, speed_mph: 18.3,
  distance_mi: 22.5, issued_at: "2026-10-16T20:35:00Z", updated_at: "2026-10-16T20:39:40Z",
};
const site = { id: "big-bend", name: "Big Bend", county: "Hillsborough", timezone: "America/New_York", hazard_index: 5, top_hazard: "heat", lightning_approach: approach };
const lightning = { id: "stop-1", site_id: site.id, type: "lightning", started_at: approach.updated_at, all_clear_at: approach.arrival_at, last_strike_distance_mi: 3 };
const cell = { id: "cell-1", lat: 28, lon: -82, radius_mi: 10, flash_count: 100, recent_flashes: 25, tracked: true, speed_mph: 18, heading_deg: 90, moving_toward: "E", last_flash_at: approach.updated_at, replay: false };
const detail = { ...require("../../shared/mocks/site_details.json")[site.id], ...site };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const Chip = load("components/LightningApproachChip.tsx").default;
const helpers = load("lib/lightning.ts");
const chipProps = { approach, nowMs, stopWork: false, unconfirmed: false };

function advisory(html) {
  assert.match(html, /Lightning possible within the hour/);
  assert.match(html, /Advisory/, "reads as an advisory, not a confirmed alert");
  assert.match(html, /Storm approaching from the W at 18 mph/);
  assert.doesNotMatch(html, /20:57|4:57|17 min|arrival_at|role="timer"|All clear/);
}

test("advisories use a broad amber heads-up and motion, never ETA or countdown", () => {
  for (const minutes_to_arrival of [0, 1, 17, 60]) {
    const html = render(Chip, { ...chipProps, approach: { ...approach, minutes_to_arrival } });
    advisory(html);
    assert.match(html, /bg-risk-amber-bg/);
    assert.doesNotMatch(html, /Not confirmed|data-countdown/);
  }
  for (const missing of [null, undefined]) assert.equal(render(Chip, { ...chipProps, approach: missing }), "");
  assert.equal(render(Chip, { ...chipProps, stopWork: true }), "");
});

test("stale and unknown advisories stay visible, grey with ? and Not confirmed; demos are labeled", () => {
  for (const props of [
    { ...chipProps, unconfirmed: true },
    { ...chipProps, nowMs: nowMs + 3 * 60_000 },
    { ...chipProps, approach: { ...approach, updated_at: "invalid" } },
  ]) {
    const html = render(Chip, props);
    advisory(html);
    assert.match(html, /unconfirmed/i);
    assert.doesNotMatch(html, /WITHIN THE HOUR \?/);
    assert.match(html, /Last known/);
    assert.match(html, /Not confirmed/);
    assert.doesNotMatch(html, /text-risk-amber|bg-risk-amber-bg/);
  }
  const demo = render(Chip, { ...chipProps, demo: true, nowMs: nowMs + 86_400_000 });
  assert.match(demo, /Demo data/);
  assert.match(demo, /bg-risk-amber-bg/);
  assert.equal(helpers.approachUnconfirmed(approach, nowMs), false);
  assert.equal(helpers.approachUnconfirmed(approach, nowMs - 120_000), true);
});

test("dashboard cards suppress advisories for a stop-work, including last-known stop-work", () => {
  const Card = load("components/SiteCard.tsx").default;
  advisory(render(Card, { site, nowMs, selected: true }));
  advisory(render(Card, { site, nowMs, alerts: [{ ...lightning, type: "flood", all_clear_at: null }], selected: true }));
  for (const alertsUnconfirmed of [false, true]) {
    const html = render(Card, { site, nowMs, alerts: [lightning], alertsUnconfirmed, selected: true });
    assert.match(html, /STOP WORK/);
    assert.doesNotMatch(html, /Lightning possible|Storm approaching/i);
  }
  assert.match(render(Card, { site, nowMs, approachUnconfirmed: true, selected: true }), /Not confirmed/);
  assert.match(render(Card, { site, nowMs }), /Lightning possible/);
});

const nullComponent = { __esModule: true, default: () => null };
const baseState = { alerts: [], status: "live", replay: null, connection: { level: "online" } };
function modules(state, extra = {}) {
  return {
    "@/components/AlertsProvider": { useAlertsState: () => state, useServerNow: () => () => nowMs },
    "@/components/ViewModeProvider": { useViewMode: () => ({ mode: state.viewMode ?? "live", setMode() {} }) },
    "@/components/BriefingCard": nullComponent,
    "@/components/HazardPanel": nullComponent,
    "@/components/SiteScoreHistory": nullComponent,
    "@/components/CrewReadings": nullComponent,
    "@/components/CrewBriefing": nullComponent,
    "@/components/PushSettings": nullComponent,
    "@/lib/api": { DEMO_DATA: { sites: [site], lightning: [], lightningCells: [cell], siteDetails: { [site.id]: detail }, briefings: {} } },
    "@/lib/useCrewSiteData": { useCrewSiteData: () => ({ detail, detailFailed: false, briefingFailed: false, loading: false }) },
    "@/lib/usePolling": { usePolling() {} },
    ...extra,
  };
}

test("site detail shows the advisory, respects stop-work priority, and labels connection loss and demos", () => {
  for (const state of [baseState, { ...baseState, status: "demo" }]) {
    const Detail = load("components/SiteDetailView.tsx", modules(state)).default;
    const html = render(Detail, { siteId: site.id, initialDetail: detail });
    advisory(html);
    if (state.status === "demo") assert.match(html, /Demo data/);
  }
  const Detail = load("components/SiteDetailView.tsx", modules({ ...baseState, alerts: [lightning] })).default;
  assert.doesNotMatch(render(Detail, { siteId: site.id, initialDetail: detail }), /Lightning possible/i);
  // A replay stop-work is only a secondary tag: it never hides a real advisory.
  const Replay = load("components/SiteDetailView.tsx", modules({ ...baseState, alerts: [{ ...lightning, replay: true }] })).default;
  const replayHtml = render(Replay, { siteId: site.id, initialDetail: detail });
  advisory(replayHtml);
  assert.ok(replayHtml.indexOf("Lightning possible") < replayHtml.indexOf("Replay"), "the real advisory comes before the replay tag");
  const Offline = load("components/SiteDetailView.tsx", modules({ ...baseState, status: "stale", connection: { level: "offline", lastSuccessAt: nowMs } })).default;
  const html = render(Offline, { siteId: site.id, initialDetail: detail });
  advisory(html);
  assert.match(html, /Not confirmed/);
});

// Small hook driver: execute actual component callbacks and inspect their React output without a browser.
function hookDriver() {
  let slots = [], cursor = 0, effects = [];
  const hooks = {
    ...React,
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
    useCallback(fn) { return fn; }, useMemo(fn) { return fn(); }, useEffect(fn) { effects.push(fn); },
  };
  return {
    hooks,
    render(Component, props) { cursor = 0; effects = []; return Component(props); },
    flushEffects() { effects.forEach(fn => fn()); },
    reset() { slots = []; },
  };
}
function elements(tree, match) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, match));
  // The dashboard's site list (SiteListFinder) draws its rows with renderSite: expand them too.
  const rows = typeof tree.props?.renderSite === "function" && Array.isArray(tree.props.sites) ? tree.props.sites.map(tree.props.renderSite) : [];
  return [...(match(tree) ? [tree] : []), ...elements(tree.props?.children, match), ...elements(rows, match)];
}

test("crew view shows direction and speed and gives known stop-work priority", () => {
  for (const state of [baseState, { ...baseState, alerts: [lightning] }, { ...baseState, alerts: [lightning], status: "stale" }, { ...baseState, alerts: null, status: "unreachable" }, { ...baseState, status: "demo" }]) {
    const driver = hookDriver();
    const Crew = load("components/CrewView.tsx", modules(state, { react: driver.hooks })).default;
    const mode = Crew({ initialSites: [site] });
    driver.render(mode.type, mode.props);
    driver.flushEffects(); // storage readiness resolves; no browser storage is required
    const tree = driver.render(mode.type, mode.props);
    const selected = elements(tree, el => typeof el.type === "function" && el.type.name === "CrewSite")[0];
    assert.ok(selected, "the actual crew site component is selected");
    driver.reset();
    const html = renderToStaticMarkup(driver.render(selected.type, selected.props));
    if (state.alerts?.length) {
      assert.match(html, /STOP WORK/);
      assert.doesNotMatch(html, /Lightning possible/i);
    } else {
      advisory(html);
      if (state.alerts === null) assert.match(html, /Not confirmed/);
      if (state.status === "demo") assert.match(html, /Demo data/);
    }
  }
});

function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  return 2 * 3958.7613 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2));
}

test("storm circles use miles; arrows point along geographic headings, including north at zero degrees", () => {
  for (const heading_deg of [0, 90, 180, 270]) {
    const data = helpers.stormCellsGeoJson([{ ...cell, heading_deg }], nowMs, false);
    const ring = data.features[0].geometry.coordinates[0];
    assert.equal(JSON.stringify(ring[0]), JSON.stringify(ring.at(-1)), "circle is closed");
    for (const point of ring) assert.ok(Math.abs(distance([cell.lon, cell.lat], point) - cell.radius_mi) < 0.001);
    const [start, tip] = data.features[1].geometry.coordinates[0];
    if (heading_deg === 0) assert.ok(tip[1] > start[1] && Math.abs(tip[0] - start[0]) < 0.001);
    if (heading_deg === 90) assert.ok(tip[0] > start[0]);
    if (heading_deg === 180) assert.ok(tip[1] < start[1]);
    if (heading_deg === 270) assert.ok(tip[0] < start[0]);
    const [left, head, right] = data.features[1].geometry.coordinates[1];
    assert.equal(JSON.stringify(tip), JSON.stringify(head));
    for (const wing of [left, right]) assert.ok(distance(start, wing) < distance(start, tip), "arrowhead wings trail the tip");
  }
});

test("untracked or stationary cells get circles only; old and failed cells are marked, demo ages use samples", () => {
  for (const overrides of [{ tracked: false }, { speed_mph: 0, heading_deg: null }, { heading_deg: null }, { speed_mph: null }]) {
    assert.equal(helpers.stormCellsGeoJson([{ ...cell, ...overrides }], nowMs, false).features.length, 1);
  }
  assert.equal(helpers.stormCellsGeoJson([{ ...cell, lat: NaN }], nowMs, false).features.length, 0);
  for (const [time, failed, demo, uncertain] of [[nowMs, false, false, false], [nowMs, true, false, true], [nowMs + 300_000, false, false, true], [nowMs - 120_000, false, false, true], [nowMs + 86_400_000, false, true, false]]) {
    const features = helpers.stormCellsGeoJson([cell], time, failed, demo).features;
    assert.ok(features.every(f => f.properties.uncertain === uncertain));
  }
});

test("storm cells: each layer on its own clock, so real cells stay current during a replay", () => {
  const real = Date.parse("2026-10-17T22:00:00Z"), sim = Date.parse("2025-08-04T22:20:00Z");
  const realCell = { ...cell, id: "cell-1", last_flash_at: new Date(real - 60_000).toISOString() };
  const replayCell = { ...cell, replay: undefined, id: "replay-cell-1", last_flash_at: new Date(sim - 60_000).toISOString() };
  assert.equal(helpers.cellIsReplay(realCell, real), false);
  assert.equal(helpers.cellIsReplay(replayCell, real), true, "the replay- id prefix");
  assert.equal(helpers.cellIsReplay({ ...realCell, replay: true }, real), true, "the explicit flag wins");
  assert.equal(helpers.cellUnconfirmed(realCell, sim, real), false, "a fresh real cell during a replay");
  assert.equal(helpers.cellUnconfirmed(replayCell, sim, real), false, "a fresh replay cell on the replay clock");
  const features = helpers.stormCellsGeoJson([realCell, replayCell], sim, false, false, real).features.filter(f => f.geometry.type === "Polygon");
  assert.equal(JSON.stringify(features.map(f => f.properties.replay)), "[false,true]");
  assert.ok(features.every(f => !f.properties.uncertain));
});

test("storm cells share lightning polling, speed up in replay, retain failed data, and isolate demo data", async () => {
  const driver = hookDriver();
  let polls, failCells = false, failFlashes = false, cellReads = 0;
  const state = { ...baseState };
  const Map = () => null;
  const Card = () => null;
  const overrides = modules(state, {
    react: driver.hooks,
    "@/components/SiteMap": { __esModule: true, default: Map, LIGHTNING_WINDOW_MIN: 15 },
    "@/components/SiteCard": { __esModule: true, default: Card },
    "@/components/ReplayControl": nullComponent,
    "@/lib/useFloodConditions": { useFloodConditions: () => ({}) },
    "@/lib/usePolling": { usePolling: (poll, ms) => polls.push({ poll, ms }) },
  });
  Object.assign(overrides["@/lib/api"], {
    getSites: async () => [site],
    getLightningRecent: async () => { if (failFlashes) throw Error("offline flashes"); return [{ lat: 28, lon: -82, ts: approach.updated_at, replay: false }]; },
    getLightningCells: async () => { cellReads++; if (failCells) throw Error("offline cells"); return [cell]; },
    // A server without #48's counts endpoint: the dashboard counts the flashes it has.
    getLightningCounts: async () => { throw Error("404 Not Found"); },
  });
  const Dashboard = load("components/SupervisorDashboard.tsx", overrides).default;
  const draw = () => { polls = []; return driver.render(Dashboard, { initialSites: [site] }); };
  const map = tree => elements(tree, el => el.type === Map)[0].props;
  let tree = draw();
  // sites, lightning, crew reports, fires (on by default), wildlife (off by default), replay timeline (no replay)
  assert.deepEqual(polls.map(p => p.ms), [30_000, 10_000, 60_000, 300_000, null, null]);
  assert.match(renderToStaticMarkup(tree), /Storm cells: loading/);
  failCells = true;
  await polls[1].poll(); tree = draw();
  assert.match(renderToStaticMarkup(tree), /Storm cells: unavailable · Not confirmed/);
  failCells = false;
  await polls[1].poll(); tree = draw();
  assert.equal(map(tree).cells.length, 1);
  assert.equal(map(tree).cellsUnconfirmed, false);
  failCells = true;
  await polls[1].poll(); tree = draw();
  assert.equal(map(tree).cells.length, 1, "last real cells survive a failed refresh");
  assert.equal(map(tree).cellsUnconfirmed, true, "successful flashes cannot confirm failed cells");
  assert.match(renderToStaticMarkup(tree), /Storm cells: last known · Not confirmed/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /Storm cells: \d+\?/, "never a count with a question mark");
  failCells = false; failFlashes = true;
  await polls[1].poll(); tree = draw();
  assert.equal(map(tree).flashes.length, 1);
  assert.equal(map(tree).cellsUnconfirmed, false);
  assert.match(renderToStaticMarkup(tree), /last known, fade paused/);
  state.replay = { running: true }; draw();
  assert.deepEqual(polls.map(p => p.ms), [3_000, 3_000, 60_000, 300_000, null, 3_000]);
  state.alerts = [lightning];
  tree = draw();
  assert.equal(elements(tree, el => el.type === Card)[0].props.alerts[0].type, "lightning");
  const previousReads = cellReads;
  state.status = "demo"; tree = draw();
  assert.deepEqual(polls.map(p => p.ms), [null, null, null, null, null, null]);
  assert.equal(cellReads, previousReads);
  assert.equal(map(tree).demo, true);
  assert.equal(map(tree).cells, overrides["@/lib/api"].DEMO_DATA.lightningCells);
  assert.match(renderToStaticMarkup(tree), /Demo data/);
});

// ---------- View mode: one moment at a time, per device ----------

const replayStop = { ...lightning, id: "replay-stop-1", replay: true, all_clear_at: "2025-08-04T22:40:00Z" };
const realStop = { ...lightning, id: "real-stop-1", replay: false };

function dashboard(state) {
  const driver = hookDriver();
  const Map = () => null, Card = () => null;
  const overrides = modules(state, {
    react: driver.hooks,
    "@/components/SiteMap": { __esModule: true, default: Map, LIGHTNING_WINDOW_MIN: 15 },
    "@/components/SiteCard": { __esModule: true, default: Card },
    "@/components/ReplayControl": nullComponent,
    "@/lib/useFloodConditions": { useFloodConditions: () => ({}) },
    "@/lib/usePolling": { usePolling() {} },
  });
  Object.assign(overrides["@/lib/api"], { getSites: async () => [site], getLightningRecent: async () => [], getLightningCells: async () => [], getLightningCounts: async () => ({ minutes: 15, real: 0, replay: 0 }) });
  const Dashboard = load("components/SupervisorDashboard.tsx", overrides).default;
  const tree = driver.render(Dashboard, { initialSites: [site] });
  const finder = elements(tree, el => typeof el.props?.renderSite === "function")[0].props;
  return { tree, map: elements(tree, el => el.type === Map)[0].props, cards: elements(tree, el => el.type === Card), finder, html: renderToStaticMarkup(tree) };
}

test("Live view (the default) hides the replay: no replay alerts on the map or in the list, only a banner", () => {
  const running = { running: true, window: "2025-08-04_2200-2300", simulated_now: "2025-08-04T22:20:00Z", files_done: 60, files_total: 180, flashes_ingested: 5000, window_start: "2025-08-04T22:00:00Z", window_end: "2025-08-04T23:00:00Z", quiet_until: "2025-08-04T23:31:00Z" };
  const { map, cards, finder, html } = dashboard({ ...baseState, alerts: [replayStop], replay: running });
  assert.equal(map.alerts.length, 0, "no replay alerts on the map");
  assert.equal(finder.stops.size, 0, "a replay stop-work never counts under the list's Stop work filter in Live view");
  assert.ok(cards.every(card => card.props.alerts.length === 0), "no replay rows");
  assert.match(html, /A storm replay is running/);
  assert.match(html, /Watch replay/);
});

test("Replay view pins a real stop-work on top and keeps it on the map; the list shows the replay's states", () => {
  const { map, cards, finder, html } = dashboard({ ...baseState, alerts: [replayStop, realStop], viewMode: "replay", replay: { running: true, window: "2025-08-04_2200-2300", simulated_now: "2025-08-04T22:20:00Z", files_done: 60, files_total: 180, flashes_ingested: 5000, window_start: "2025-08-04T22:00:00Z", window_end: "2025-08-04T23:00:00Z", quiet_until: "2025-08-04T23:31:00Z" } });
  assert.match(html, /aria-label="Live now"/);
  assert.match(html, /Live now[\s\S]*Big Bend[\s\S]*pc-chip--stop/);
  assert.ok(map.alerts.some(alert => !alert.replay), "the real stop-work stays on the map (drawn red, the real one wins)");
  const row = cards.find(card => card.props.site.id === site.id);
  assert.ok(row.props.alerts.every(alert => alert.replay), "the row shows the replay's state; the real one is pinned");
  assert.ok(finder.stops.has(site.id), "the Stop work filter follows the rows in Replay view");
  assert.match(html, /Back to live/);
});

test("starting a replay switches this device to Replay view", async () => {
  const driver = hookDriver(), modes = [];
  const Control = load("components/ReplayControl.tsx", {
    react: driver.hooks,
    "@/components/AlertsProvider": { useAlertsState: () => ({ ...baseState, refresh: async () => {} }), useServerNow: () => () => nowMs },
    "@/components/DemoCode": { useDemoCode: () => ({ call: (action) => action(), form: null }) },
    "@/components/ViewModeProvider": { useViewMode: () => ({ mode: "live", setMode: (mode) => modes.push(mode) }) },
    "@/lib/api": { startReplay: async () => ({ running: true }), stopReplay: async () => ({}) },
  }).default;
  const button = elements(driver.render(Control, {}), el => el.type === "button")[0];
  button.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(modes), '["replay"]');
});

test("Restart stops and starts the same storm again in one tap, and keeps this device in Replay view", async () => {
  const driver = hookDriver(), calls = [], modes = [];
  const running = { running: true, window: "2025-08-04_2200-2300", speed: 30, simulated_now: "2025-08-04T22:20:00Z", files_done: 60, files_total: 180, flashes_ingested: 5000 };
  const Control = load("components/ReplayControl.tsx", {
    react: driver.hooks,
    "@/components/AlertsProvider": { useAlertsState: () => ({ ...baseState, replay: running, refresh: async () => {} }), useServerNow: () => () => nowMs },
    "@/components/DemoCode": { useDemoCode: () => ({ call: (action) => action(), form: null }) },
    "@/components/ViewModeProvider": { useViewMode: () => ({ mode: "replay", setMode: (mode) => modes.push(mode) }) },
    "@/lib/api": { startReplay: async (body) => { calls.push(["start", body.window, body.speed]); return running; }, stopReplay: async () => { calls.push(["stop"]); return {}; } },
  }).default;
  const restart = elements(driver.render(Control, {}), el => el.type === "button").find(el => JSON.stringify(el.props.children).includes("Restart"));
  restart.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(calls), '[["stop"],["start","2025-08-04_2200-2300",30]]', "stop first, then the same window and speed from the beginning");
  assert.equal(JSON.stringify(modes), '["replay"]');
});

test("view mode is per device: one device in Replay view leaves another in Live view", () => {
  const device = () => {
    const storage = new Map();
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../lib/viewMode.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, { exports, require, window: { localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } } });
    return exports;
  };
  const a = device(), b = device();
  assert.equal(a.readViewMode(), "live", "Live by default");
  a.writeViewMode("replay");
  assert.equal(a.readViewMode(), "replay");
  assert.equal(b.readViewMode(), "live", "another device stays Live");
  const { shown, pinned } = a.alertsForView([replayStop, realStop], "live");
  assert.equal(JSON.stringify([shown.map(x => x.id), pinned.length]), '[["real-stop-1"],0]');
});
