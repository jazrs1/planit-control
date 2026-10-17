// node --test tests/read-aloud.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name) => (name.startsWith("@/") ? load(name.slice(2) + ".ts") : require(name)) });
  return exports;
}

const { readAloudState, readAloudChanges } = load("lib/readAloud.ts");
const site = { id: "big-bend", name: "Big Bend" };
const stop = (extra = {}) => ({ id: "a1", site_id: "big-bend", type: "lightning", started_at: "2026-10-17T20:00:00Z", all_clear_at: "2026-10-17T20:40:00Z", last_strike_distance_mi: 3.27, replay: false, ...extra });
const approach = (extra = {}) => ({ arrival_at: "", minutes_to_arrival: 30, from_direction: "W", from_bearing_deg: 270, heading_deg: 90, speed_mph: 20, distance_mi: 15, issued_at: "", updated_at: "", replay: false, ...extra });
const NOW = Date.parse("2026-10-17T20:10:00Z");
// Copied into this realm: arrays made inside the vm sandbox have another prototype.
const say = (prev, next, wasUnknown = false) => [...readAloudChanges("Big Bend", prev, next, wasUnknown)];

test("a new stop-work is spoken with its distance, rounded down, and an all clear when it ends", () => {
  const clear = readAloudState(site, [], "live", null, NOW);
  const stopped = readAloudState(site, [stop()], "live", null, NOW);
  assert.deepEqual(say(clear, stopped), ["Stop work at Big Bend. Lightning 3.2 miles away."]);
  assert.deepEqual(say(stopped, stopped), []);
  assert.deepEqual(say(stopped, clear), ["All clear at Big Bend. Stop work has ended."]);
});

test("unknown is never all clear: it says the connection was lost, once", () => {
  const stopped = readAloudState(site, [stop()], "live", null, NOW);
  const unknown = readAloudState(site, [stop()], "stale", null, NOW);
  assert.equal(unknown.known, false);
  assert.deepEqual(say(stopped, unknown), ["Connection lost. Stop-work status at Big Bend is unknown."]);
  assert.deepEqual(say(stopped, unknown, true), []);
  assert.equal(readAloudState(site, null, "connecting", null, NOW).known, false);
  // Back online and the stop-work ended meanwhile: now the all clear is known.
  assert.deepEqual(say(stopped, readAloudState(site, [], "live", null, NOW), true), ["All clear at Big Bend. Stop work has ended."]);
});

test("replay alerts are prefixed and a cleared replay stop-work ends", () => {
  const before = readAloudState(site, [], "live", null, NOW);
  const replay = readAloudState(site, [stop({ replay: true })], "live", null, NOW);
  assert.deepEqual(say(before, replay), ["Replay: Stop work at Big Bend. Lightning 3.2 miles away."]);
  const cleared = readAloudState(site, [stop({ replay: true })], "live", null, Date.parse("2026-10-17T20:41:00Z"));
  assert.deepEqual(say(replay, cleared), ["Replay: All clear at Big Bend. Stop work has ended."]);
});

test("a lightning advisory is spoken, and a replay stop-work doesn't hide a real one", () => {
  const before = readAloudState(site, [], "live", null, NOW);
  const advisory = readAloudState(site, [stop({ replay: true })], "live", approach(), NOW);
  assert.deepEqual(say(before, advisory), ["Lightning possible within the hour at Big Bend.", "Replay: Stop work at Big Bend. Lightning 3.2 miles away."]);
  // A real stop-work replaces the advisory; the advisory ending says nothing.
  const stopped = readAloudState(site, [stop()], "live", approach(), NOW);
  assert.deepEqual(say(readAloudState(site, [], "live", approach(), NOW), stopped), ["Stop work at Big Bend. Lightning 3.2 miles away."]);
});

test("only the selected site is spoken", () => {
  const before = readAloudState(site, [], "live", null, NOW);
  const other = readAloudState(site, [stop({ site_id: "crist" })], "live", null, NOW);
  assert.deepEqual(say(before, other), []);
});

test("flood risk starts and ends", () => {
  const before = readAloudState(site, [], "live", null, NOW);
  const flood = readAloudState(site, [stop({ type: "flood", all_clear_at: null, last_strike_distance_mi: null })], "live", null, NOW);
  assert.deepEqual(say(before, flood), ["Flood risk at Big Bend."]);
  assert.deepEqual(say(flood, before), ["Flood risk has ended at Big Bend."]);
});
