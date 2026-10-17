// node --test tests/alerts.test.cjs
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
      if (name === "@/components/StopWorkCountdown") return { __esModule: true, default: () => React.createElement("div", { "data-countdown": true }) };
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.resolve(__dirname, "..", relative + ".tsx")) ? ".tsx" : ".ts"), overrides);
      }
      return require(name);
    },
  }, { filename });
  return exports;
}

const helpers = load("lib/alerts.ts");
const Banner = load("components/AlertBanner.tsx").default;
const site = { id: "gulf", name: "Gulf", county: "Escambia", timezone: "America/Chicago", hazard_index: 5, top_hazard: "flood" };
const flood = { id: "flood-1", site_id: site.id, type: "flood", started_at: "2026-10-16T16:00:00-04:00", all_clear_at: null, last_strike_distance_mi: null };
const lightning = { ...flood, id: "lightning-1", type: "lightning", last_strike_distance_mi: 9.996, all_clear_at: "2026-10-16T16:30:00-04:00" };
const conditions = { status: "warning", source: "NWS Flood Warning", hazard_status: "danger", reading: "Heavy rain near the river", as_of: "2026-10-16T16:00:00-04:00" };
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test("strike distances floor to one decimal, including the ten-mile boundary", () => {
  for (const [input, expected] of [[9.996, "9.9 mi"], [9.999999999, "9.9 mi"], [9.9, "9.9 mi"], [2.49, "2.4 mi"], [2, "2.0 mi"], [0.099, "0.0 mi"], [0, "0.0 mi"], [10, "10.0 mi"]]) {
    assert.equal(helpers.formatStrikeDistance(input), expected);
  }
  for (const missing of [null, NaN, Infinity, -1]) assert.equal(helpers.formatStrikeDistance(missing), null);
});

test("flood banners are amber with reason and site-local start time, never countdowns", () => {
  for (const all_clear_at of [null, lightning.all_clear_at]) {
    const html = render(Banner, { alert: { ...flood, all_clear_at }, site, flood: conditions });
    assert.match(html, /FLOOD RISK/);
    assert.match(html, /bg-risk-amber-bg/);
    assert.match(html, /Reason: Heavy rain near the river/);
    assert.match(html, /3:00 PM CDT/);
    assert.doesNotMatch(html, /STOP WORK|data-countdown|All clear|bg-risk-red/);
  }
});

test("unknown flood reasons stay unknown, and missing site timezone uses labeled UTC", () => {
  const html = render(Banner, { alert: flood });
  assert.match(html, /Reason unavailable/);
  assert.match(html, /8:00 PM UTC/);
  assert.equal(helpers.floodReason({ ...conditions, hazard_status: null }), "Reason unavailable");
  assert.equal(helpers.floodReason({ ...conditions, as_of: null }), "Reason unavailable");
  assert.equal(helpers.floodReason({ ...conditions, reading: null }), "NWS Flood Warning");
});

test("only lightning gets STOP WORK, red styling and a countdown", () => {
  const html = render(Banner, { alert: lightning, site });
  assert.match(html, /STOP WORK/);
  assert.match(html, /bg-risk-red-bg/);
  assert.match(html, /9\.9 mi/);
  assert.match(html, /data-countdown/);
  for (const type of ["heat", "wildfire"]) {
    assert.doesNotMatch(render(Banner, { alert: { ...lightning, type }, site }), /STOP WORK|data-countdown|bg-risk-red/);
  }
});

test("dashboard cards show simultaneous flood and lightning alerts separately", () => {
  const Card = load("components/SiteCard.tsx").default;
  const html = render(Card, { site, alerts: [lightning, flood], flood: conditions });
  assert.match(html, /STOP WORK/);
  assert.match(html, /FLOOD RISK/);
  assert.match(html, /Heavy rain near the river/);
  assert.match(html, /9\.9 mi/);
  assert.equal((html.match(/data-countdown/g) || []).length, 1);
  assert.match(render(Card, { site, alerts: [flood], alertsUnconfirmed: true }), /Not confirmed/);
});

function nav(alerts, status = "live") {
  return render(load("components/TopNavigation.tsx", {
    "@/components/AlertsProvider": { useAlertsState: () => ({ alerts, status }) },
    "next/navigation": { usePathname: () => "/alerts" },
    "next/link": { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) },
  }).default, {});
}

test("navigation breaks down alert types and chooses amber for flood-only alerts", () => {
  assert.match(nav([flood]), /bg-risk-amber-bg/);
  assert.doesNotMatch(nav([flood]), /bg-risk-red-bg/);
  assert.match(nav([flood]), /0 stop work · 1 flood risk/);
  assert.match(nav([lightning, flood]), /1 stop work · 1 flood risk/);
  assert.match(nav([lightning, flood]), /Alerts, 2 active/);
  assert.match(nav([lightning, flood]), /bg-risk-red-bg/);
  assert.match(nav(null, "unreachable"), /— stop work · — flood risk/);
  assert.match(nav([flood], "stale"), /0\? stop work · 1\? flood risk/);
  assert.doesNotMatch(nav([flood], "stale"), /bg-risk-amber-bg/);
  assert.match(nav([flood], "demo"), /Demo data/);
});
