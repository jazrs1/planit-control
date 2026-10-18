// node --test tests/hazard-links.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, modules = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    exports, URL, Intl, Date,
    require(name) {
      if (name in modules) return modules[name];
      if (!name.startsWith("@/")) return require(name);
      const base = path.join(__dirname, "..", name.slice(2));
      return load(path.relative(path.join(__dirname, ".."), fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`), modules);
    },
  });
  return exports;
}

const links = load("lib/hazardLinks.ts");
const HAZARDS = ["lightning", "heat", "flood", "soil_saturation", "wildfire", "wildlife", "storm"];

test("hazardHref links to the site page with the card's anchor", () => {
  assert.equal(links.hazardHref("big-bend", "wildlife"), "/sites/big-bend#hazard-wildlife");
  assert.equal(links.hazardHref("big-bend", "flood"), "/sites/big-bend#hazard-flooding");
  assert.equal(links.hazardHref("big-bend", "soil_saturation"), "/sites/big-bend#hazard-soil");
  assert.equal(links.hazardHref("big-bend", "storm"), "/sites/big-bend#hazard-storm");
  assert.equal(links.hazardHref("a b", "heat"), "/sites/a%20b#hazard-heat");
});

test("each anchor in the hash is a scroll target; cards open their details, the storm section has none", () => {
  for (const hazard of HAZARDS) {
    const target = links.hazardTarget(links.hazardHref("big-bend", hazard).split("/sites/big-bend")[1]);
    assert.deepEqual({ ...target }, { hazard, elementId: links.HAZARD_ANCHOR[hazard], expand: hazard !== "storm" });
  }
  assert.equal(links.hazardTarget("hazard-heat").elementId, "hazard-heat", "a hash without its #");
});

test("an unknown or missing hash is a normal page load", () => {
  for (const hash of ["", "#", "#hazard-", "#hazard-storms", "#hazard-flood", "#site-briefing", "#HAZARD-HEAT", "#%E0%A4%A"]) {
    assert.equal(links.hazardTarget(hash), null, hash);
  }
});

test("the site page renders every scroll target, and no card is opened or highlighted without a hash", () => {
  const details = require("../../shared/mocks/site_details.json");
  const detail = Object.values(details)[0];
  const stub = () => null;
  const SiteDetailView = load("components/SiteDetailView.tsx", {
    "@/components/AlertsProvider": {
      useAlertsState: () => ({ alerts: [], status: "live", replay: null, setDemo() {}, refresh: async () => {}, connection: { level: "online", lastSuccessAt: null } }),
      useServerNow: () => () => Date.parse(detail.updated_at),
    },
    "@/components/BriefingCard": { __esModule: true, default: stub },
    "@/components/SiteScoreHistory": { __esModule: true, default: stub },
    "@/components/LightningApproachChip": { __esModule: true, default: stub },
    "@/components/StopWorkCountdown": { __esModule: true, default: stub },
    "@/lib/api": { ApiRequestError: class extends Error {}, DEMO_DATA: { siteDetails: {}, briefings: {} }, getSiteDetail: async () => detail, sendBriefingNow: async () => ({ generated: [] }) },
    "@/lib/loadBriefings": { loadBriefing: async () => null },
    "@/lib/usePolling": { usePolling() {} },
  }).default;
  const html = renderToStaticMarkup(React.createElement(SiteDetailView, { siteId: detail.id, initialDetail: detail }));
  for (const hazard of HAZARDS) {
    const id = links.HAZARD_ANCHOR[hazard];
    const tag = html.match(new RegExp(`<(?:article|section)[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tag, `${id} is on the page`);
    assert.match(tag[0], /scroll-mt-/, `${id} stops below the sticky banner`);
  }
  assert.doesNotMatch(html, /outline-offset-4/, "no highlight without a hash");
  assert.doesNotMatch(html, /Hide details/, "no card opened without a hash");
});
