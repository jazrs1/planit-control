// node --test tests/replay-timeline.test.cjs
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
    exports, window: { matchMedia: () => ({ matches: false }) },
    require(name) {
      if (name in overrides) return overrides[name];
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.resolve(__dirname, "..", relative + ".tsx")) ? ".tsx" : ".ts"), overrides);
      }
      return require(name);
    },
  }, { filename });
  return exports;
}

const Timeline = load("components/ReplayTimeline.tsx", { "@/components/ReplayControl": { __esModule: true, default: () => null } });
const status = {
  running: true, window: "2025-08-04_2200-2300", speed: 30, simulated_now: "2025-08-04T22:20:00Z",
  files_total: 180, files_done: 60, flashes_ingested: 5000,
  window_start: "2025-08-04T22:00:00Z", window_end: "2025-08-04T23:00:00Z", quiet_until: "2025-08-04T23:31:00Z",
};
const sites = [{ id: "a", name: "Alpha Plant", timezone: "America/New_York" }, { id: "b", name: "Bravo Plant", timezone: "America/Chicago" }, { id: "c", name: "Charlie Plant", timezone: "America/New_York" }];
const events = [
  { id: "e1", at: "2025-08-04T22:05:00Z", kind: "stop_work_start", site_id: "a", distance_mi: 6.58 },
  { id: "e2", at: "2025-08-04T22:10:00Z", kind: "approach_start", site_id: "b", distance_mi: 11.3 },
  { id: "e3", at: "2025-08-04T22:45:00Z", kind: "all_clear", site_id: "c", distance_mi: null },
];
const series = { bin_minutes: 5, bins: [{ start: "2025-08-04T22:00:00Z", flashes: 1495, sites_in_stop_work: 7 }, { start: "2025-08-04T22:30:00Z", flashes: 10, sites_in_stop_work: 1 }] };
const render = (props) => renderToStaticMarkup(React.createElement(Timeline.default, {
  replay: status, alerts: [], sites, timeline: { events, series, failed: false }, nowMs: Date.parse(status.simulated_now), stale: false, ...props,
}));

test("only events at or before simulated now are shown, and approach starts carry no distance", () => {
  const html = render();
  assert.match(html, /Alpha Plant · 6\.5 mi|Alpha Plant · 6\.6 mi/);
  assert.match(html, /Bravo Plant/);
  assert.doesNotMatch(html, /11\.3 mi|11 mi/, "an approach start's distance is from its last update, so it's left out");
  assert.doesNotMatch(html, /Charlie Plant/, "the 22:45 all clear hasn't happened at 22:20");
  assert.doesNotMatch(html, /since this page opened/i);
  assert.match(html, /peak 1,495/, "bins after simulated now aren't drawn or counted");
});

test("time ticks come from the window, and the label reads like a person wrote it", () => {
  const html = render();
  for (const tick of ["6:00 PM", ">6:30<", ">7:00<", ">7:30<"]) assert.match(html, new RegExp(tick));
  assert.doesNotMatch(html, /size-\[3px\]/, "no invented flash particles");
  assert.equal(Timeline.replayWindowLabel(status), "Aug 4, 2025 storm · 6:00–7:31 PM EDT");
  assert.equal(Timeline.replayWindowLabel({ window: null, window_start: null, quiet_until: null }), "Aug 4, 2025 storm · 6:00–7:31 PM EDT");
});

test("before the timeline is ready (503s retried quietly) the panel says so, never '0 events' or 'Needs data'", () => {
  const loading = render({ timeline: { events: null, series: null, failed: false, preparing: false } });
  assert.match(loading, /Loading the storm/);
  const preparing = render({ timeline: { events: null, series: null, failed: false, preparing: true } });
  assert.match(preparing, /Preparing replay timeline…/);
  assert.match(preparing, /<span class="font-mono">…<\/span>/, "the events count is unknown, not 0");
  for (const html of [loading, preparing]) assert.doesNotMatch(html, /Needs data/);
});

test("event times use each site's own timezone, naming it when it isn't Eastern", () => {
  const html = render();
  assert.match(html, /6:05 PM</, "an Eastern site's stop-work at 22:05 UTC");
  assert.match(html, /5:10 PM CDT/, "a panhandle (Central) site's advisory at 22:10 UTC");
});
