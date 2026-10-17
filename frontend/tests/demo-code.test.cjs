// node --test tests/demo-code.test.cjs
// The demo code (backend ADMIN_TOKEN): stored with try/catch, sent only on protected actions.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

/** Transpile a frontend file into a sandbox with the given globals; "@/..." imports load the same way. */
function load(file, globals = {}) {
  const exports = {};
  const filename = path.resolve(__dirname, "..", file);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, Response, process: { env: { NEXT_PUBLIC_API_URL: "http://api.test" } }, console: { warn() {} },
    require(name) {
      if (name.startsWith("@/")) {
        const relative = name.slice(2);
        return load(relative + (fs.existsSync(path.resolve(__dirname, "..", relative + ".tsx")) ? ".tsx" : ".ts"), globals);
      }
      if (name.startsWith("@shared/")) return require(path.join(__dirname, "../../shared", name.replace("@shared/", "")));
      return require(name);
    },
    ...globals,
  }, { filename });
  return exports;
}

function storage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

test("the code is remembered in localStorage and cleared", () => {
  const window = { localStorage: storage() };
  const code = load("lib/demoCode.ts", { window });
  assert.equal(code.getDemoCode(), null);
  assert.deepEqual({ ...code.demoCodeHeaders() }, {});
  code.setDemoCode("swamp");
  assert.equal(window.localStorage.getItem("planit-demo-code"), "swamp");
  assert.equal(load("lib/demoCode.ts", { window }).getDemoCode(), "swamp");      // survives a reload
  assert.deepEqual({ ...code.demoCodeHeaders() }, { "X-Admin-Token": "swamp" });
  code.clearDemoCode();
  assert.equal(code.getDemoCode(), null);
});

test("blocked storage doesn't throw: the code is kept for this page load", () => {
  const blocked = { get localStorage() { throw new Error("SecurityError"); } };
  const code = load("lib/demoCode.ts", { window: blocked });
  code.setDemoCode("swamp");
  assert.equal(code.getDemoCode(), "swamp");
  code.clearDemoCode();
  assert.equal(code.getDemoCode(), null);
  assert.equal(load("lib/demoCode.ts", {}).getDemoCode(), null);                   // no window at all (server)
});

test("replay start/stop and send-now carry the code; reads never do", async () => {
  const window = { localStorage: storage() };
  window.localStorage.setItem("planit-demo-code", "swamp");
  const sent = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url, headers: { ...(init.headers ?? {}) } });
    return new Response(url.endsWith("/send-now") ? '{"generated":[],"queued":55}' : '{"running":false}', { status: 200 });
  };
  const api = load("lib/api.ts", { window, fetch });
  await api.startReplay();
  await api.stopReplay();
  await api.sendBriefingNow();
  await api.getReplayStatus();
  assert.deepEqual(sent.map((s) => [s.url.replace("http://api.test", ""), s.headers["X-Admin-Token"] ?? null]), [
    ["/replay/start", "swamp"], ["/replay/stop", "swamp"], ["/briefing/send-now", "swamp"], ["/replay/status", null],
  ]);
});

test("a 401 surfaces as ApiRequestError with status 401, which the demo-code prompt looks for", async () => {
  const fetch = async () => new Response('{"detail":"This action needs the demo code (X-Admin-Token header)."}', { status: 401 });
  const api = load("lib/api.ts", { window: { localStorage: storage() }, fetch });
  await assert.rejects(api.startReplay(), (err) => err instanceof api.ApiRequestError && err.status === 401);
});

test("the prompt is a labeled code field that says when a code was wrong", () => {
  const { DemoCodeForm } = load("components/DemoCode.tsx", { window: { localStorage: storage() } });
  const html = (wrong) => renderToStaticMarkup(React.createElement(DemoCodeForm, { wrong, onSubmit() {}, onCancel() {} }));
  assert.match(html(false), /<label[^>]*>Enter demo code<\/label>/);
  assert.match(html(false), /type="password"/);
  assert.match(html(true), /That code didn&#x27;t work/);
});
