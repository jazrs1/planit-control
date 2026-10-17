// Run with: node --test tests/connection.test.cjs
// The shared connection state that drives "last known" and the 2-minute "status unknown" outage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

/** Load lib/api.ts and lib/connection.ts into one sandbox so they share the same store. */
function load(fetch) {
  const cache = {};
  const sandbox = {
    window: {}, Response, AbortSignal, fetch,
    process: { env: { NEXT_PUBLIC_API_URL: "http://api.test" } },
    console: { warn() {} },
    require(id) {
      if (id.startsWith("@/lib/")) return mod(id.slice("@/lib/".length));
      return require(path.join(__dirname, "../../shared", id.replace("@shared/", "")));
    },
  };
  function mod(name) {
    if (cache[name]) return cache[name];
    const exports = (cache[name] = {});
    const source = fs.readFileSync(path.join(__dirname, `../lib/${name}.ts`), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(js, { ...sandbox, exports });
    return exports;
  }
  return { api: mod("api"), conn: mod("connection") };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a network error on a read starts failing; the next response ends it and fires reconnect", async () => {
  let up = false;
  const { api, conn } = load(async () => { if (!up) throw new TypeError("fetch failed"); return json(200, []); });
  let reconnects = 0;
  conn.onReconnect(() => reconnects++);

  await assert.rejects(api.getAlerts());
  const failing = conn.getConnectionSnapshot();
  assert.notEqual(failing.failingSince, null);
  await assert.rejects(api.getSites());
  assert.equal(conn.getConnectionSnapshot().failingSince, failing.failingSince, "a run of failures keeps its start time");

  up = true;
  await api.getAlerts();
  const ok = conn.getConnectionSnapshot();
  assert.equal(ok.failingSince, null);
  assert.ok(ok.lastSuccessAt >= failing.failingSince);
  assert.equal(reconnects, 1);
  await api.getAlerts();
  assert.equal(reconnects, 1, "reconnect fires once per recovery, not on every success");
});

test("a 404 proves the backend is up; a 5xx on a read is a failure", async () => {
  let status = 404;
  const { api, conn } = load(async () => json(status, { detail: "nope" }));
  await assert.rejects(api.getBriefing("x"), (err) => err.status === 404);
  assert.equal(conn.getConnectionSnapshot().failingSince, null);
  assert.notEqual(conn.getConnectionSnapshot().lastSuccessAt, null);
  status = 502;
  await assert.rejects(api.getSites());
  assert.notEqual(conn.getConnectionSnapshot().failingSince, null);
});

test("a failed write (503 from POST) is the action's error, not an outage", async () => {
  const { api, conn } = load(async () => json(503, { detail: "Database unavailable" }));
  await assert.rejects(api.sendBriefingNow({ site_id: "big-bend" }), /Database unavailable/);
  assert.equal(conn.getConnectionSnapshot().failingSince, null);
});

test("the outage starts 2 minutes after the last success (or page load if none)", () => {
  const { conn } = load(async () => json(200, []));
  assert.equal(conn.outageStartsAt({ lastSuccessAt: 1_000, failingSince: null }, 0), null);
  assert.equal(conn.outageStartsAt({ lastSuccessAt: 1_000, failingSince: 5_000 }, 0), 1_000 + 120_000);
  assert.equal(conn.outageStartsAt({ lastSuccessAt: null, failingSince: 5_000 }, 500), 500 + 120_000);
});

test("score history uses the encoded site path and errors never turn into sample history", async () => {
  let status = 200, url;
  const history = { site_id: "big-bend", points: [] };
  const { api } = load(async (path) => { url = path; return json(status, status === 200 ? history : { detail: "History unavailable" }); });
  assert.deepEqual(await api.getScoreHistory("a/b"), history);
  assert.equal(url, "http://api.test/sites/a%2Fb/score-history");
  status = 503;
  await assert.rejects(api.getScoreHistory("big-bend"), /History unavailable/);
  assert.equal(api.DEMO_DATA.scoreHistory.site_id, "big-bend");
});

test("storm-cell requests use the API contract path and reject errors without mock fallback", async () => {
  let status = 200, requested;
  const cells = [{ id: "cell-1", lat: 28, lon: -82, radius_mi: 10 }];
  const { api } = load(async (url) => { requested = url; return json(status, status === 200 ? cells : { detail: "Forecast unavailable" }); });
  assert.deepEqual(await api.getLightningCells(), cells);
  assert.equal(requested, "http://api.test/lightning/cells");
  status = 503;
  await assert.rejects(api.getLightningCells(), /Forecast unavailable/);
  assert.ok(api.DEMO_DATA.lightningCells.length > 0);
});
