// node --test tests/held-stop-work.test.cjs
// A real stop-work held because lightning data is delayed (Alert.held_reason, read as optional until the
// backend field is in shared/types): "waiting for lightning data", never a countdown at 0:00 or "All clear".
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
      if (name === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.resolve(__dirname, "..", relative + ".tsx")) ? ".tsx" : ".ts"), overrides);
      }
      if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.slice(8)));
      return require(name);
    },
  }, { filename });
  return exports;
}

const NOW = Date.parse("2026-10-17T22:40:00Z");
// The all-clear time has passed: a plain countdown would read 00:00 / All clear.
const stop = (extra = {}) => ({ id: "a1", site_id: "big-bend", type: "lightning", started_at: "2026-10-17T22:00:00Z", all_clear_at: "2026-10-17T22:30:00Z", last_strike_distance_mi: 3.2, replay: false, ...extra });
const held = (extra = {}) => stop({ held_reason: "lightning_data_delayed", ...extra });
const site = { id: "big-bend", name: "Big Bend", county: "Hillsborough", timezone: "America/New_York", hazard_index: 9, hazard_index_live: 9, top_hazard: "lightning", lightning_approach: null };
const provider = (status = "live") => ({ "@/components/AlertsProvider": { useAlertsState: () => ({ alerts: [], status, replay: null, connection: { level: status === "stale" ? "offline" : "online" } }), useServerNow: () => () => NOW } });
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

function waiting(html) {
  assert.match(html, /[Ww]aiting for lightning data/);
  assert.doesNotMatch(html, /All clear|all clear|00:00|role="timer"/);
}

test("only a real lightning stop-work with held_reason lightning_data_delayed is held; the field is optional", () => {
  const { heldForLightningData } = load("lib/alerts.ts");
  assert.equal(heldForLightningData(held()), true);
  assert.equal(heldForLightningData(stop()), false, "no field yet: a normal countdown");
  assert.equal(heldForLightningData(stop({ held_reason: null })), false);
  assert.equal(heldForLightningData(stop({ held_reason: "something_else" })), false);
  assert.equal(heldForLightningData(held({ replay: true })), false, "only a real stop-work");
  assert.equal(heldForLightningData(held({ type: "flood" })), false);
  assert.equal(heldForLightningData(null), false);
});

test("the countdown shows the wait in every variant, never a timer at 0:00 or All clear", () => {
  const Countdown = load("components/StopWorkCountdown.tsx", provider()).default;
  for (const variant of [{}, { inline: true }, { boxless: true }, { prominent: true }]) {
    waiting(render(Countdown, { all_clear_at: held().all_clear_at, replay: false, held: true, ...variant }));
  }
  // Not held: the normal countdown is still there.
  assert.match(render(Countdown, { all_clear_at: stop().all_clear_at, replay: false }), /role="timer"/);
  // Connection lost while held: still the wait (last known), never All clear.
  const Offline = load("components/StopWorkCountdown.tsx", provider("stale")).default;
  const offline = render(Offline, { all_clear_at: held().all_clear_at, replay: false, held: true });
  waiting(offline);
  assert.match(offline, /Last known, connection lost/);
});

test("site row, expanded row, crew sign, site detail and alerts cards all show the held stop-work", () => {
  const SiteCard = load("components/SiteCard.tsx", provider()).default;
  const row = render(SiteCard, { site, alerts: [held()], nowMs: NOW });
  assert.match(row, /Stop work/);
  waiting(row);
  const expanded = render(SiteCard, { site, alerts: [held()], nowMs: NOW, selected: true, onSelect() {} });
  waiting(expanded);
  assert.match(expanded, /Stop work stays in place/);

  const AlertBanner = load("components/AlertBanner.tsx", provider()).default;
  for (const props of [{ prominent: true }, { compact: true }, {}]) {
    const html = render(AlertBanner, { alert: held(), site, ...props });
    assert.match(html, /STOP WORK/);
    waiting(html);
    assert.match(html, /Lightning data is delayed/);
  }

  const { StopWorkCard } = load("components/AlertCards.tsx", provider());
  const card = render(StopWorkCard, { alert: held(), siteName: "Big Bend", lastKnown: false });
  waiting(card);
  assert.match(card, /Lightning data is delayed/);
});

test("read-aloud says the data is delayed once; the data coming back is not an all clear", () => {
  const { readAloudState, readAloudChanges } = load("lib/readAloud.ts");
  const say = (prev, next) => [...readAloudChanges("Big Bend", prev, next, false)];
  const clear = readAloudState(site, [], "live", null, NOW);
  const stopped = readAloudState(site, [stop()], "live", null, NOW);
  const holding = readAloudState(site, [held()], "live", null, NOW);
  assert.deepEqual(say(stopped, holding), ["Lightning data delayed at Big Bend. Stop work stays in place."]);
  assert.deepEqual(say(holding, holding), [], "said once");
  assert.deepEqual(say(holding, stopped), [], "data back: the stop-work goes on, nothing to say");
  assert.deepEqual(say(clear, holding), ["Stop work at Big Bend. Lightning 3.2 miles away.", "Lightning data delayed at Big Bend. Stop work stays in place."]);
  assert.deepEqual(say(holding, clear), ["All clear at Big Bend. Stop work has ended."], "only the stop-work really ending is an all clear");
  // A replay alert is never held, even in Replay view.
  const replay = readAloudState(site, [held({ replay: true })], "live", null, NOW, true, "replay");
  assert.ok(![...replay.items.values()].some((text) => /data delayed/.test(text)));
});
