// node --test tests/rain-forecast.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require });
  return exports;
}

const { rainForecast } = load("lib/rainForecast.ts");
// Copied into this realm: objects made inside the vm sandbox have another prototype.
const rain = (ours, nws) => ({ ...rainForecast(ours, nws) });

test("forecasts more than 2x and more than 1 in apart show the range, not the higher value", () => {
  assert.deepEqual(rain(6.5, 0.9), { value: "0.9–6.5 in", caption: "Forecasts disagree, rain next 24 h", note: null, disagree: true });
  assert.deepEqual(rain(0.9, 6.5), { value: "0.9–6.5 in", caption: "Forecasts disagree, rain next 24 h", note: null, disagree: true });
  assert.equal(rain(1.5, 0).disagree, true);
});

test("forecasts within 2x, or within 1 in, show ours with NWS as a secondary line", () => {
  assert.deepEqual(rain(8.0, 7.1), { value: "8.0 in", caption: "Rain expected, next 24 h", note: "NWS: 7.1 in", disagree: false });
  // 3x apart but only 0.6 in: not a disagreement.
  assert.equal(rain(0.9, 0.3).disagree, false);
  // 1.5 in apart but under 2x: not a disagreement.
  assert.equal(rain(3.0, 1.6).disagree, false);
});

test("NWS unavailable shows nothing extra", () => {
  assert.deepEqual(rain(8.04, null), { value: "8.0 in", caption: "Rain expected, next 24 h", note: null, disagree: false });
  assert.deepEqual(rain(8.04, undefined), { value: "8.0 in", caption: "Rain expected, next 24 h", note: null, disagree: false });
  assert.equal(rain(null, null).value, null);
});
