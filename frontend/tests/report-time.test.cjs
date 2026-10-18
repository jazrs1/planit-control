// node --test tests/report-time.test.cjs
// A crew report's time: in its site's zone, or Eastern time (with the zone shown) when no site was chosen. Never UTC.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const nothing = { __esModule: true, default: () => null };
const overrides = {
  "@/components/AlertsProvider": { useAlertsState: () => ({ status: "live", replay: null, setDemo() {} }) },
  "@/lib/usePolling": { usePolling() {} },
  "@/lib/api": { DEMO_DATA: { reports: [], sites: [] }, getReports: async () => [], getSites: async () => [] },
  "@/components/ReportMap": nothing,
  "@/components/ReportPhoto": nothing,
};
function load(file) {
  const exports = {};
  const filename = path.resolve(__dirname, "..", file);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name.startsWith("@/")) return load(name.slice(2) + (fs.existsSync(path.resolve(__dirname, "..", name.slice(2) + ".tsx")) ? ".tsx" : ".ts"));
      if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.slice(8)));
      return require(name);
    },
  }, { filename });
  return exports;
}

const ReportsView = load("components/ReportsView.tsx").default;
const report = (extra) => ({ id: "r1", site_id: null, lat: 27.9, lon: -82.4, category: "other", note: "", photo_url: null, reporter_role: "crew", species: null, created_at: "2026-10-18T04:08:42Z", ...extra });
const crist = { id: "crist", name: "Crist", county: "Escambia", timezone: "America/Chicago", lat: 30.5, lon: -87.2, hazard_index: 2, top_hazard: "heat", lightning_approach: null };
const times = (html) => [...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map((m) => m[1]);

test("a report with no site shows Eastern time with the zone, never UTC", () => {
  const html = renderToStaticMarkup(React.createElement(ReportsView, { initialReports: [report()], sites: [] }));
  assert.deepEqual(times(html), ["Oct 18, 12:08 AM EDT"]);
  assert.doesNotMatch(html, /UTC/);
});

test("a report with a site keeps the site's own zone", () => {
  const html = renderToStaticMarkup(React.createElement(ReportsView, { initialReports: [report({ site_id: "crist" })], sites: [crist] }));
  assert.deepEqual(times(html), ["Oct 17, 11:08 PM CDT"]);
});
