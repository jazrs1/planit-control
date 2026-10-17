const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function loader(overrides = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const filename = path.join(__dirname, "..", file);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText, {
      exports, ...globals,
      require(name) {
        if (name in overrides) return overrides[name];
        if (name.startsWith("@/")) {
          const relative = name.slice(2);
          return load(relative + (fs.existsSync(path.join(__dirname, "..", `${relative}.tsx`)) ? ".tsx" : ".ts"));
        }
        return require(name);
      },
    }, { filename });
    return exports;
  }
  return load;
}

// Exercise hooks, observer callbacks and polling without adding a browser/testing package.
function hooks() {
  const slots = [];
  let cursor = 0, effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0]; },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = fn(); });
      }
    },
    useId() { return "score-tooltip"; },
  };
  return {
    react,
    render(fn, props) { cursor = 0; effects = []; return fn(props); },
    flush() { effects.forEach(fn => fn()); effects = []; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(child => find(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
}

const site = { id: "big-bend", name: "Big Bend", timezone: "America/Chicago" };
const now = Date.parse("2026-10-16T20:00:00Z");
const point = (hours, score, extra = {}) => ({ scored_at: new Date(now + hours * 3600_000).toISOString(), for_date: "2026-10-16", horizon: "today", hazard_index: score, top_hazard: "heat", model_score: null, ...extra });
const history = { site_id: site.id, points: [point(-5, 3), point(-4, 3), point(-3, 3), point(-2, 3), point(-1, 4), point(0, 7)] };
const helpers = loader()("lib/scoreHistory.ts");
const Chart = loader()("components/ScoreSparkline.tsx").default;
const renderChart = (props) => renderToStaticMarkup(React.createElement(Chart, { site, history, ...props }));

test("history uses hybrid today scores only, sorted and deduplicated, within seven days of the latest run", () => {
  const points = helpers.historyPoints({ site_id: site.id, points: [point(0, 7), point(-1, 4), point(-2, 10, { horizon: "tomorrow" }), point(-1, 5), point(-200, 1), point(-3, 11), point(-3, NaN), point(-3, 3, { scored_at: "invalid" }), point(-168, 0)] });
  assert.deepEqual(Array.from(points, p => p.hazard_index), [0, 5, 7]);
  assert.equal(points.at(-1).model_score, null, "a hybrid score does not require the ML part");
  assert.equal(helpers.historyPoints(null).length, 0);
  const segments = helpers.historySegments([point(-8, 2), point(-7, 3), point(0, 7)]);
  assert.deepEqual(Array.from(segments, segment => segment.length), [2, 1]);
});

test("missing, short (under 6 runs) and duplicate-only series show Not enough history yet, with no invented line", () => {
  for (const value of [null, { site_id: site.id, points: [] }, { site_id: site.id, points: [point(0, 7)] }, { site_id: site.id, points: [point(0, 7), point(0, 7)] }, { site_id: site.id, points: [point(-4, 3), point(-3, 3), point(-2, 3), point(-1, 4), point(0, 7)] }, { ...history, site_id: "another-site" }]) {
    const html = renderChart({ history: value });
    assert.match(html, /Not enough history yet/);
    assert.doesNotMatch(html, /<svg|<polyline/);
  }
});

test("risk zones have fixed 0–10 geometry, latest point uses shared risk bands, and stale/demo states are explicit", () => {
  const html = renderChart({});
  for (const band of ["green", "amber", "red"]) assert.match(html, new RegExp(`fill-risk-${band}-bg`));
  assert.match(html, /Latest 7\.0/);
  assert.match(html, /r="4\.5" class="fill-risk-red stroke-surface"/);
  assert.match(html, /Oct 16, 3:00 PM CDT · 7\.0 \/ 10/);
  assert.match(html, /cx="592" cy="33\.2/);
  const stale = renderChart({ unconfirmed: true });
  assert.match(stale, /Latest 7\.0 \?/);
  assert.match(stale, /Not confirmed/);
  assert.match(stale, /stroke-muted/);
  assert.doesNotMatch(stale, /fill-risk-(?:red|amber|green)/);
  assert.match(renderChart({ demo: true }), /Demo data/);
  for (const [score, band] of [[3.9, "green"], [4, "amber"], [6.9, "amber"], [7, "red"]]) {
    assert.match(renderChart({ history: { ...history, points: [point(-5, 3), point(-4, 3), point(-3, 3), point(-2, 3), point(-1, 3), point(0, score)] } }), new RegExp(`r="4.5" class="fill-risk-${band}`));
  }
});

test("tooltips work with keyboard, hover and touch and always use the site's timezone", () => {
  const driver = hooks();
  const Component = loader({ react: driver.react })("components/ScoreSparkline.tsx").default;
  const draw = () => driver.render(Component, { history, site });
  const svg = tree => find(tree, el => el.type === "svg")[0];
  let tree = draw();
  svg(tree).props.onFocus(); tree = draw();
  assert.match(renderToStaticMarkup(tree), /role="tooltip"[^>]*>Oct 16, 3:00 PM CDT · 7\.0 \/ 10/);
  svg(tree).props.onKeyDown({ key: "Home", preventDefault() {}, stopPropagation() {} }); tree = draw();
  assert.match(renderToStaticMarkup(tree), /role="tooltip"[^>]*>Oct 16, 10:00 AM CDT · 3\.0 \/ 10/);
  svg(tree).props.onKeyDown({ key: "End", preventDefault() {}, stopPropagation() {} }); tree = draw();
  svg(tree).props.onKeyDown({ key: "ArrowLeft", preventDefault() {}, stopPropagation() {} }); tree = draw();
  assert.match(renderToStaticMarkup(tree), /role="tooltip"[^>]*>Oct 16, 2:00 PM CDT · 4\.0 \/ 10/);
  const event = { currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 600 }) }, clientX: 592 };
  svg(tree).props.onPointerDown(event); tree = draw();
  assert.match(renderToStaticMarkup(tree), /role="tooltip"[^>]*>Oct 16, 3:00 PM CDT · 7\.0 \/ 10/);
  svg(tree).props.onPointerMove({ ...event, clientX: 0 }); tree = draw();
  assert.match(renderToStaticMarkup(tree), /role="tooltip"[^>]*>Oct 16, 10:00 AM CDT · 3\.0 \/ 10/);
});

function historyLoader({ lazy = false, state, getHistory, siteId = site.id } = {}) {
  const driver = hooks();
  let polling, observer;
  const current = state ?? { status: "live", connection: { level: "online" }, replay: null };
  const clock = () => now;
  const api = { DEMO_DATA: { scoreHistory: history }, getScoreHistory: getHistory ?? (async () => history) };
  const Component = loader({
    react: driver.react,
    "@/components/AlertsProvider": { useAlertsState: () => current, useServerNow: () => clock },
    "@/lib/api": api,
    "@/lib/usePolling": { usePolling: (poll, ms) => { polling = { poll, ms }; } },
  }, {
    IntersectionObserver: class { constructor(callback) { observer = { callback, disconnected: false }; } observe() {} disconnect() { observer.disconnected = true; } },
    window: { setInterval: () => 1, clearInterval() {} },
  })("components/SiteScoreHistory.tsx").default;
  const props = { site: { ...site, id: siteId }, lazy, compact: lazy };
  let mode = Component(props);
  const draw = () => driver.render(mode.type, mode.props);
  let tree = draw();
  tree.props.ref.current = {};
  driver.flush();
  return { driver, state: current, draw, get polling() { return polling; }, get observer() { return observer; }, modeKey: () => Component(props).key };
}
const chart = tree => find(tree, el => typeof el.type === "function" && el.type.name === "ScoreSparkline")[0]?.props;

test("55 hidden dashboard histories make no reads; only intersecting cards load and leaving view pauses polling", async () => {
  const reads = [];
  const cards = Array.from({ length: 55 }, (_, i) => historyLoader({ lazy: true, siteId: `site-${i}`, getHistory: async (id) => { reads.push(id); return { ...history, site_id: id }; } }));
  for (const card of cards) { assert.equal(card.polling.ms, null); await card.polling.poll(); }
  assert.equal(reads.length, 0);
  for (const index of [1, 4]) {
    const card = cards[index];
    card.observer.callback([{ isIntersecting: true }]); card.draw(); card.driver.flush();
    assert.notEqual(card.polling.ms, null);
    await card.polling.poll();
    assert.equal(chart(card.draw()).history.site_id, `site-${index}`);
    card.observer.callback([{ isIntersecting: false }]); card.draw();
    assert.equal(card.polling.ms, null);
    await card.polling.poll();
  }
  assert.deepEqual(reads, ["site-1", "site-4"]);
  cards.forEach(card => card.driver.unmount());
  assert.ok(cards.every(card => card.observer.disconnected));
});

test("history refresh failures retain real data as unconfirmed, recover, and speed up during replay", async () => {
  let fail = false;
  const view = historyLoader({ getHistory: async () => { if (fail) throw Error("offline"); return history; } });
  await view.polling.poll(); let tree = view.draw();
  assert.equal(chart(tree).unconfirmed, false);
  assert.equal(view.polling.ms, 300_000);
  fail = true; await view.polling.poll(); tree = view.draw();
  assert.equal(chart(tree).history, history);
  assert.equal(chart(tree).unconfirmed, true);
  assert.equal(view.polling.ms, 5_000);
  fail = false; await view.polling.poll(); tree = view.draw();
  assert.equal(chart(tree).unconfirmed, false);
  view.state.connection.level = "offline";
  assert.equal(chart(view.draw()).unconfirmed, true);
  view.state.connection.level = "online";
  view.state.replay = { running: true }; view.draw();
  assert.equal(view.polling.ms, 3_000);
  view.driver.unmount();
});

test("initial failures are unknown, demos never fetch or borrow another site's sample, and mode keys isolate data", async () => {
  const down = historyLoader({ getHistory: async () => { throw Error("offline"); } });
  await down.polling.poll();
  assert.match(renderToStaticMarkup(down.draw()), /History unavailable · Not confirmed/);
  assert.equal(chart(down.draw()), undefined);
  let reads = 0;
  for (const id of [site.id, "another-site"]) {
    const state = { status: "demo", connection: { level: "online" }, replay: null };
    const demo = historyLoader({ state, siteId: id, getHistory: async () => { reads++; return history; } });
    assert.equal(demo.polling.ms, null);
    await demo.polling.poll();
    const props = chart(demo.draw());
    assert.equal(props.history, id === site.id ? history : null);
    assert.equal(props.demo, true);
    const before = demo.modeKey(); state.status = "live";
    assert.notEqual(demo.modeKey(), before);
    demo.driver.unmount();
  }
  assert.equal(reads, 0);
  down.driver.unmount();
});

test("old hourly scores are unconfirmed and late responses cannot write after unmount", async () => {
  const oldHistory = { ...history, points: [point(-6, 3), point(-5, 4)] };
  const old = historyLoader({ getHistory: async () => oldHistory });
  await old.polling.poll();
  assert.equal(chart(old.draw()).unconfirmed, true);
  old.driver.unmount();
  let finish;
  const view = historyLoader({ getHistory: () => new Promise(resolve => { finish = resolve; }) });
  const pending = view.polling.poll();
  view.driver.unmount();
  finish(history); await pending;
  assert.equal(chart(view.draw()), undefined);
});

test("visibility fallback respects a clipping scroll ancestor", () => {
  const driver = hooks();
  const listeners = {};
  const parent = { parentElement: null, getBoundingClientRect: () => ({ top: 100, bottom: 300, left: 0, right: 600 }) };
  let bounds = { top: 350, bottom: 500, left: 0, right: 600, width: 600, height: 150 };
  const hook = loader({ react: driver.react }, {
    window: { innerWidth: 800, innerHeight: 800, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } },
    getComputedStyle: () => ({ overflowY: "auto", overflowX: "visible" }),
  })("lib/useVisibility.ts").useVisibility;
  let result = driver.render(() => hook(true));
  result.ref.current = { parentElement: parent, getBoundingClientRect: () => bounds };
  driver.flush();
  result = driver.render(() => hook(true));
  assert.equal(result.visible, false, "inside viewport but clipped by list");
  bounds = { ...bounds, top: 150, bottom: 250 }; listeners.scroll();
  assert.equal(driver.render(() => hook(true)).visible, true);
  driver.unmount();
  assert.deepEqual(Object.keys(listeners), []);
});
