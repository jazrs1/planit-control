// node --test tests/site-picker.test.cjs
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
    exports, Intl,
    require(name) {
      if (name in modules) return modules[name];
      if (!name.startsWith("@/")) return require(name);
      const base = path.join(__dirname, "..", name.slice(2));
      return load(path.relative(path.join(__dirname, ".."), fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.tsx`), modules);
    },
  });
  return exports;
}

const sites = require("../../shared/mocks/sites.json");
const draw = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test("the report photo input offers camera and library: no capture attribute, any image type (checked on pick)", () => {
  const ReportForm = load("components/ReportForm.tsx", { "@/components/ReportMap": { __esModule: true, default: () => null }, "@/lib/api": { createReport: async () => ({}), uploadPhoto: async () => ({}), validatePhoto: () => null } }).default;
  const html = draw(ReportForm, { sites, initialSiteId: "" });
  const input = html.match(/<input[^>]*id="photo"[^>]*>/)[0];
  assert.doesNotMatch(input, /capture/, "capture would make phones open only the camera");
  assert.match(input, /accept="image\/\*"/);
  assert.match(html, /JPEG, PNG, WebP, or HEIC\. Up to 10 MB\./);
  // The site field is the search picker, with "no site" shown until a site is chosen.
  assert.match(html, /role="combobox"[^>]*value="Away from a site \/ unknown"/);
  assert.doesNotMatch(html, /<select[^>]*id="site"/);
});

test("the site picker shows the chosen site, or the no-site option when none is chosen", () => {
  const SitePicker = load("components/SitePicker.tsx").default;
  const bigBend = sites.find((site) => site.id === "big-bend");
  assert.match(draw(SitePicker, { sites, selectedId: "big-bend", onSelect() {}, label: "Site" }), new RegExp(`value="${bigBend.name}"`));
  assert.match(draw(SitePicker, { sites, selectedId: null, onSelect() {}, label: "Site", noneLabel: "Away from a site / unknown" }), /value="Away from a site \/ unknown"/);
  assert.match(draw(SitePicker, { sites: null, selectedId: null, onSelect() {}, label: "Site" }), /placeholder="Sites unavailable"[^>]*|disabled=""/);
  const multiple = draw(SitePicker, { multiple: true, sites, chosen: ["big-bend"], onToggle() {}, label: "Add a site to follow" });
  assert.match(multiple, /value=""/, "multiple: the input is only for searching");
  assert.match(multiple, /Add my nearest site/);
});
