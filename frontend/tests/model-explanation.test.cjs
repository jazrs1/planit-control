// node --test tests/model-explanation.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const evaluation = require("../../shared/mocks/model_info.json");

function loader(fetch, overrides = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const filename = path.join(__dirname, "..", file);
    const source = fs.readFileSync(filename, "utf8");
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText, {
      exports, fetch, AbortSignal, console: { warn() {} },
      process: { env: { NEXT_PUBLIC_API_URL: "https://api.test/service/" } },
      require(name) {
        if (name in overrides) return overrides[name];
        if (name === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
        if (name.startsWith("@/")) {
          const relative = name.slice(2);
          return load(relative + (fs.existsSync(path.join(__dirname, "..", `${relative}.tsx`)) ? ".tsx" : ".ts"));
        }
        if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.slice(8)));
        return require(name);
      },
    }, { filename });
    return exports;
  }
  return load;
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const renderPage = async (load) => renderToStaticMarkup(await load("app/how-it-works/page.tsx").default());

test("the model API read uses no-store, rejects server and network failures, and never supplies mock metrics", async () => {
  let status = 200, offline = false, requested, options;
  const load = loader(async (url, init) => {
    requested = url; options = init;
    if (offline) throw new TypeError("fetch failed");
    return response(status === 200 ? evaluation : { detail: "Model unavailable" }, status);
  });
  const api = load("lib/api.ts");
  assert.deepEqual(await api.getModelInfo(), evaluation);
  assert.equal(requested, "https://api.test/service/model/info");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  status = 503;
  await assert.rejects(api.getModelInfo(), /Model unavailable/);
  offline = true;
  await assert.rejects(api.getModelInfo(), /fetch failed/);
});

test("the page renders API years, metrics, baseline descriptions, relative comparisons and the API-hosted plot", async () => {
  const info = structuredClone(evaluation);
  info.training = { train_years: [2030, 2031], validation_year: 2032, test_year: 2033, sites: 61, train_site_days: 42001, train_events: 1234 };
  info.test = { site_days: 9000, events: 333, base_rate: 0.037 };
  info.results[0].same_day = { pr_auc: 0.256, roc_auc: 0.8765, brier: 0.01234 };
  info.results[1].same_day.pr_auc = 0.064;
  info.results[2].same_day.pr_auc = 0.128;
  info.results[1].description = "Monthly hazardous-day frequency from the API.";
  info.calibration.plot_url = "/model/updated-calibration.svg";
  info.hybrid = "Current hybrid rules returned by the model service.";
  info.limitations = ["Evaluation limitation from the API."];
  const html = await renderPage(loader(async () => response(info)));
  for (const text of ["2030–2031", "Calibrated on 2032", "tested on 2033", "61 sites", "42,001", "1,234", "0.2560", "0.8765", "0.01234", "4.0×", "2.0×", "3.70%", "333 of 9,000", info.results[1].description, info.results[2].description, info.hybrid, info.limitations[0]]) assert.ok(html.includes(text), text);
  assert.match(html, /src="https:\/\/api\.test\/service\/model\/updated-calibration\.svg"/);
  assert.match(html, /href="#model"/);
  assert.match(html, /archived Open-Meteo forecasts matched against NOAA Storm Events/);
  assert.doesNotMatch(html, /Coming soon|To be added|placeholder|will replace|2022–2023|0\.1285|20,075/);
});

test("all reported metrics include day-ahead results and unavailable evaluations stay unknown", async () => {
  const info = structuredClone(evaluation);
  info.results[1].day_ahead = null;
  info.results[1].same_day.pr_auc = 0; // Never divide by zero in the ranking comparison.
  const html = await renderPage(loader(async () => response(info)));
  assert.match(html, /0\.1285/);
  assert.match(html, /0\.1021/);
  assert.match(html, /0\.02271/);
  assert.match(html, /forecasts issued a day earlier/);
  assert.match(html, /— = not evaluated/);
  assert.doesNotMatch(html, /Infinity|NaN/);
});

test("offline and HTTP errors preserve the explanation with Model details unavailable and no sample numbers or plot", async () => {
  for (const fetch of [async () => { throw new TypeError("offline"); }, async () => response({ detail: "unavailable" }, 503), async () => response({ detail: "not found" }, 404)]) {
    const html = await renderPage(loader(fetch));
    assert.match(html, /Machine learning model/);
    assert.match(html, /Model details unavailable/);
    assert.match(html, /crew-relevant hazardous weather day/);
    for (const text of ["OSHA heat-index bands", "Hurricane Warning", "lightning stop-work", "Reporting bias", "Heat and wildfire cannot be learned reliably", "Hazardous days are rare"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /0\.1285|0\.8419|1,152|40,150|20,075|calibration\.svg|test results|2022–2023/);
  }
});

test("a failed calibration image shows an explicit unavailable state", () => {
  let failed = false;
  const load = loader(undefined, { react: { ...React, useState: () => [failed, value => { failed = value; }] } });
  const Plot = load("components/ModelCalibrationPlot.tsx").default;
  const image = Plot({ src: "https://api.test/model/calibration.svg" });
  assert.equal(image.type, "img");
  assert.match(image.props.alt, /predicted probability/);
  image.props.onError();
  const html = renderToStaticMarkup(Plot({ src: "https://api.test/model/calibration.svg" }));
  assert.match(html, /role="status"/);
  assert.match(html, /Model calibration plot unavailable/);
  assert.doesNotMatch(html, /<img/);
});
