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
const cell = { id: "cell-1", lat: 28, lon: -82, radius_mi: 10, flash_count: 100, recent_flashes: 25, tracked: true, speed_mph: 18, heading_deg: 90, moving_toward: "E", last_flash_at: approach.updated_at };
const detail = { ...require("../../shared/mocks/site_details.json")[site.id], ...site };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const Chip = load("components/LightningApproachChip.tsx").default;
const helpers = load("lib/lightning.ts");
const chipProps = { approach, nowMs, stopWork: false, unconfirmed: false };

function advisory(html) {
  assert.match(html, /LIGHTNING POSSIBLE WITHIN THE HOUR/);
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
    assert.match(html, /WITHIN THE HOUR \?/);
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
  advisory(render(Card, { site, nowMs }));
  advisory(render(Card, { site, nowMs, alerts: [{ ...lightning, type: "flood", all_clear_at: null }] }));
  for (const alertsUnconfirmed of [false, true]) {
    const html = render(Card, { site, nowMs, alerts: [lightning], alertsUnconfirmed });
    assert.match(html, /STOP WORK/);
    assert.doesNotMatch(html, /LIGHTNING POSSIBLE|Storm approaching/);
  }
  assert.match(render(Card, { site, nowMs, approachUnconfirmed: true }), /Not confirmed/);
});

const nullComponent = { __esModule: true, default: () => null };
const baseState = { alerts: [], status: "live", replay: null, connection: { level: "online" } };
function modules(state, extra = {}) {
  return {
    "@/components/AlertsProvider": { useAlertsState: () => state, useServerNow: () => () => nowMs },
    "@/components/BriefingCard": nullComponent,
    "@/components/HazardPanel": nullComponent,
    "@/components/CrewReadings": nullComponent,
    "@/components/CrewBriefing": nullComponent,
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
  assert.doesNotMatch(render(Detail, { siteId: site.id, initialDetail: detail }), /LIGHTNING POSSIBLE/);
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
  return [...(match(tree) ? [tree] : []), ...elements(tree.props?.children, match)];
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
      assert.doesNotMatch(html, /LIGHTNING POSSIBLE/);
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
    getLightningRecent: async () => { if (failFlashes) throw Error("offline flashes"); return [{ lat: 28, lon: -82, ts: approach.updated_at }]; },
    getLightningCells: async () => { cellReads++; if (failCells) throw Error("offline cells"); return [cell]; },
  });
  const Dashboard = load("components/SupervisorDashboard.tsx", overrides).default;
  const draw = () => { polls = []; return driver.render(Dashboard, { initialSites: [site] }); };
  const map = tree => elements(tree, el => el.type === Map)[0].props;
  let tree = draw();
  assert.deepEqual(polls.map(p => p.ms), [30_000, 10_000]);
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
  assert.match(renderToStaticMarkup(tree), /Storm cells: 1\? · Last known · Not confirmed/);
  failCells = false; failFlashes = true;
  await polls[1].poll(); tree = draw();
  assert.equal(map(tree).flashes.length, 1);
  assert.equal(map(tree).cellsUnconfirmed, false);
  assert.match(renderToStaticMarkup(tree), /last known, fade paused/);
  state.replay = { running: true }; draw();
  assert.deepEqual(polls.map(p => p.ms), [3_000, 3_000]);
  state.alerts = [lightning];
  tree = draw();
  assert.equal(elements(tree, el => el.type === Card)[0].props.alerts[0].type, "lightning");
  const previousReads = cellReads;
  state.status = "demo"; tree = draw();
  assert.deepEqual(polls.map(p => p.ms), [null, null]);
  assert.equal(cellReads, previousReads);
  assert.equal(map(tree).demo, true);
  assert.equal(map(tree).cells, overrides["@/lib/api"].DEMO_DATA.lightningCells);
  assert.match(renderToStaticMarkup(tree), /Demo data/);
});
