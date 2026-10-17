// node --test tests/crew.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    exports, ...globals,
    require(name) {
      if (globals.modules && name in globals.modules) return globals.modules[name];
      return name.startsWith("@/") ? load(name.slice(2) + ".ts", globals) : require(name);
    },
  });
  return exports;
}

const crew = load("lib/crew.ts");
test("storage read/write failures are safe and site selection falls back to a real site", () => {
  const blocked = load("lib/crew.ts", { window: { get localStorage() { throw new Error("blocked"); } } });
  assert.equal(blocked.rememberedSite(), "");
  assert.doesNotThrow(() => blocked.rememberSite("big-bend"));
  const sites = [{ id: "z", name: "Zebra" }, { id: "a", name: "Alpha" }];
  assert.equal(crew.chooseCrewSite(sites, "missing").id, "a");
  assert.equal(crew.chooseCrewSite(sites, "z").id, "z");
  assert.equal(crew.chooseCrewSite([], "z"), undefined);
  assert.equal(sites[0].id, "z", "selection does not reorder fetched data");
});

test("site memory round trips using the crew storage key", () => {
  const stored = new Map();
  const api = load("lib/crew.ts", { window: { localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } } });
  api.rememberSite("big-bend");
  assert.equal(api.rememberedSite(), "big-bend");
  assert.equal(stored.get(api.CREW_SITE_KEY), "big-bend");
});

test("tomorrow follows the backend instant in the site's timezone across midnight and DST", () => {
  const instant = Date.parse("2026-10-17T04:30:00Z");
  assert.equal(crew.tomorrowAtSite(instant, "America/New_York"), "2026-10-18");
  assert.equal(crew.tomorrowAtSite(instant, "America/Chicago"), "2026-10-17");
  assert.equal(crew.tomorrowAtSite(Date.parse("2026-03-08T06:30:00Z"), "America/New_York"), "2026-03-09");
  assert.equal(crew.tomorrowAtSite(Date.parse("2027-01-01T04:30:00Z"), "America/New_York"), "2027-01-01");
});

test("briefing headline uses the backend headline, with a text fallback for older briefings", () => {
  assert.equal(crew.briefingHeadline({ headline: "Caution tomorrow", text: "Body" }), "Caution tomorrow");
  assert.equal(crew.briefingHeadline({ text: "Index 5.9 tomorrow. More details." }), "Index 5.9 tomorrow.");
});

test("placeholder hazard values remain No data, and stale readings stay marked", () => {
  const Readings = load("components/CrewReadings.tsx").default;
  const detail = JSON.parse(fs.readFileSync(path.join(__dirname, "../../shared/mocks/site_details.json"), "utf8"))["big-bend"];
  const source = { ...detail.conditions.heat, heat_index_f: 999, hazard_status: null, as_of: null };
  detail.conditions.heat = source;
  const html = renderToStaticMarkup(React.createElement(Readings, { detail, stale: false }));
  assert.match(html, /No data/);
  assert.doesNotMatch(html, /999/);
  const stale = renderToStaticMarkup(React.createElement(Readings, { detail, stale: true }));
  assert.match(stale, /Not confirmed/);
  assert.match(stale, /grayscale/);
  assert.equal(crew.hasReading({ hazard_status: "ok", as_of: null }), false);
});

test("unconfirmed lightning never displays a countdown or All clear", () => {
  const Countdown = load("components/StopWorkCountdown.tsx", { modules: {
    "@/components/AlertsProvider": {
      useServerNow: () => () => Date.parse("2026-10-16T16:00:00-04:00"),
      useAlertsState: () => ({ status: "stale" }),
    },
  } }).default;
  for (const all_clear_at of ["2026-10-16T16:30:00-04:00", "2026-10-16T15:00:00-04:00"]) {
    const html = renderToStaticMarkup(React.createElement(Countdown, { all_clear_at }));
    assert.match(html, /role="timer"[^>]*>Not confirmed/);
    assert.doesNotMatch(html, /text-risk-green/);
  }
});
