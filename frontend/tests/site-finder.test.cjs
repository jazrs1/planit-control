// node --test tests/site-finder.test.cjs
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
    exports,
    require(name) {
      if (name in modules) return modules[name];
      if (!name.startsWith("@/")) return require(name);
      const base = path.join(__dirname, "..", name.slice(2));
      return load(path.relative(path.join(__dirname, ".."), fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`), modules);
    },
  });
  return exports;
}

const finder = load("lib/siteFinder.ts");
const sites = require("../../shared/mocks/sites.json");
const ids = (list) => [...list].map((site) => site.id);
const none = new Set();

test("search matches the start of any word in the plant name or county, ignoring case and punctuation", () => {
  const bigBend = sites.find((site) => site.id === "big-bend");
  for (const query of ["big", "BIG BE", "bend", "hills", "hillsborough county", "  big  "]) assert.equal(finder.siteMatches(bigBend, query), true, query);
  for (const query of ["ig", "bend x", "miami"]) assert.equal(finder.siteMatches(bigBend, query), false, query);
  assert.equal(finder.siteMatches({ name: "St. Lucie", county: "St. Lucie" }, "st luc"), true);
  assert.equal(finder.siteMatches({ name: "Turkey Point", county: "Miami-Dade" }, "miami dade"), true);
});

test("counts: High is the live red band, Stop work is real stop-work only", () => {
  const counts = { ...finder.filterCounts(sites, new Set(["big-bend"])) };
  assert.deepEqual(counts, { all: 6, stop: 1, high: 1, elevated: 3, low: 2 });
  // A replay raises hazard_index but never hazard_index_live, and isn't in the real stop-work set.
  const replayRaised = sites.map((site) => site.id === "crystal-river" ? { ...site, hazard_index: 9, replay_override: true } : site);
  assert.deepEqual({ ...finder.filterCounts(replayRaised, none) }, { all: 6, stop: 0, high: 1, elevated: 3, low: 2 });
});

test("by default low-risk sites fold into one group; a search or a filter shows every match in order", () => {
  const byDefault = finder.siteListView(sites, { query: "", filter: "all", realStops: none });
  assert.deepEqual(ids(byDefault.shown), ["deerhaven-generating-station", "big-bend", "martin", "turkey-point"]);
  assert.deepEqual(ids(byDefault.low), ["gulf-clean-energy-center", "crystal-river"]);
  // Search ignores grouping: a low-risk match is shown directly.
  assert.deepEqual(ids(finder.siteListView(sites, { query: "crys", filter: "all", realStops: none }).shown), ["crystal-river"]);
  assert.deepEqual(ids(finder.siteListView(sites, { query: "", filter: "low", realStops: none }).shown), ["gulf-clean-energy-center", "crystal-river"]);
  assert.deepEqual(ids(finder.siteListView(sites, { query: "", filter: "stop", realStops: new Set(["big-bend"]) }).shown), ["big-bend"]);
  assert.equal(finder.siteListView(sites, { query: "nowhere", filter: "all", realStops: none }).shown.length, 0);
});

test("a real stop-work site is never folded away, even on a low live index", () => {
  const view = finder.siteListView(sites, { query: "", filter: "all", realStops: new Set(["crystal-river"]) });
  assert.ok(ids(view.shown).includes("crystal-river"));
  assert.ok(!ids(view.low).includes("crystal-river"));
});

test("nearest plant is computed on the device with great-circle miles", () => {
  // Tampa, about 7 mi from Big Bend.
  const nearest = finder.nearestSite(sites, 27.95, -82.46);
  assert.equal(nearest.site.id, "big-bend");
  assert.ok(nearest.distanceMi > 5 && nearest.distanceMi < 15, String(nearest.distanceMi));
  assert.equal(finder.nearestSite([], 27.95, -82.46), null);
  assert.ok(Math.abs(finder.distanceMi(25.7617, -80.1918, 30.4383, -84.2807) - 400) < 15);
});

test("the dashboard list renders the folded low-risk row and real-only counts", () => {
  const { default: SiteListFinder } = load("components/SiteListFinder.tsx");
  const html = renderToStaticMarkup(React.createElement(SiteListFinder, {
    sites, realStops: new Set(["big-bend"]), alertsState: "known", renderSite: (site) => React.createElement("span", null, `ROW ${site.id}`),
  }));
  assert.match(html, /Low risk · 2 sites/);
  assert.match(html, /ROW big-bend/);
  assert.doesNotMatch(html, /ROW crystal-river/);
  assert.match(html, /aria-pressed="true"[^>]*>All <span[^>]*>6</);
  assert.match(html, />Stop work <span[^>]*>1</);
  const unknown = renderToStaticMarkup(React.createElement(SiteListFinder, { sites, realStops: none, alertsState: "unknown", renderSite: () => null }));
  assert.match(unknown, />Stop work <span[^>]*>—</);
  const stale = renderToStaticMarkup(React.createElement(SiteListFinder, { sites, realStops: new Set(["big-bend"]), alertsState: "stale", renderSite: () => null }));
  assert.match(stale, />Stop work <span[^>]*>1\?</);
});

test("the crew picker is a combobox showing the chosen site, with a location button", () => {
  const { default: CrewSitePicker } = load("components/CrewSitePicker.tsx");
  const html = renderToStaticMarkup(React.createElement(CrewSitePicker, { sites, selectedId: "big-bend", onSelect() {} }));
  assert.match(html, /role="combobox"/);
  assert.match(html, /value="Big Bend"/);
  assert.match(html, /Hillsborough County/);
  assert.match(html, /Use my location/);
  const empty = renderToStaticMarkup(React.createElement(CrewSitePicker, { sites: null, selectedId: null, onSelect() {} }));
  assert.match(empty, /placeholder="Sites unavailable"/);
  assert.match(empty, /disabled=""/);
});
