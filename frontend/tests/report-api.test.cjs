// Run with: node --test tests/report-api.test.cjs
// Uses only Node and the repository's existing TypeScript dependency.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadApi(overrides = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "../lib/api.ts"), "utf8");
  const sandbox = {
    exports, File, DOMException, AbortSignal, Response,
    process: { env: { NEXT_PUBLIC_API_URL: "http://api.test" } },
    console: { warn() {} },
    require(name) { return require(path.join(__dirname, "../../shared", name.replace("@shared/", ""))); },
    ...overrides,
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, sandbox);
  return exports;
}

const photo = () => new File([new Uint8Array([137, 80, 78, 71])], "hazard.png", { type: "image/png" });

test("rejects non-images, unsupported formats, empty and oversized photos before upload", async () => {
  const api = loadApi({ XMLHttpRequest: class { constructor() { throw new Error("Unexpected upload"); } } });
  await assert.rejects(api.uploadPhoto(new File(["text"], "note.txt", { type: "text/plain" })), /Choose an image/);
  await assert.rejects(api.uploadPhoto(new File(["gif"], "hazard.gif", { type: "image/gif" })), /JPEG, PNG, WebP, or HEIC/);
  await assert.rejects(api.uploadPhoto(new File([], "hazard.png", { type: "image/png" })), /empty/);
  await assert.rejects(api.uploadPhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })), /too large/);
  assert.equal(api.validatePhoto(photo()), null);
});

test("uploads the raw file with its MIME type, reports progress, and reads photo_url", async () => {
  const file = photo();
  const progress = [];
  class Xhr {
    upload = {};
    open(method, url) { assert.equal(method, "POST"); assert.equal(url, "http://api.test/uploads"); }
    setRequestHeader(name, value) { assert.equal(name, "Content-Type"); assert.equal(value, file.type); }
    send(body) {
      assert.equal(body, file, "raw File body, not FormData or JSON");
      this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = 201; this.responseText = '{"photo_url":"http://api.test/uploads/photo.png"}'; this.onload();
    }
  }
  const api = loadApi({ XMLHttpRequest: Xhr });
  const result = await api.uploadPhoto(file, value => progress.push(value));
  assert.equal(result.photo_url, "http://api.test/uploads/photo.png");
  assert.deepEqual(progress, [0, 50, 100]);
});

test("upload failures never return mock success", async () => {
  for (const [kind, expected] of [["large", /too large/], ["network", /Network error/], ["timeout", /timed out/], ["invalid", /no photo URL/]]) {
    class Xhr {
      upload = {};
      open() {} setRequestHeader() {}
      send() {
        if (kind === "network") return this.onerror();
        if (kind === "timeout") return this.ontimeout();
        this.status = kind === "large" ? 413 : 201;
        this.responseText = "{}";
        this.onload();
      }
    }
    await assert.rejects(loadApi({ XMLHttpRequest: Xhr }).uploadPhoto(photo()), expected);
  }
});

test("abort cancels an in-flight upload", async () => {
  class Xhr {
    upload = {};
    open() {} setRequestHeader() {} send() {}
    abort() { this.onabort(); }
  }
  const controller = new AbortController();
  const promise = loadApi({ XMLHttpRequest: Xhr }).uploadPhoto(photo(), undefined, controller.signal);
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
});

test("creates a report using the exact contract fields and uploaded photo URL", async () => {
  const body = { site_id: null, photo_url: "http://api.test/uploads/photo.png", lat: 27.8, lon: -82.4, category: "wildlife", note: "Snake: near gate", reporter_role: "crew_member" };
  const api = loadApi({ fetch: async (url, options) => {
    assert.equal(url, "http://api.test/reports");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), body);
    return new Response(JSON.stringify({ ...body, id: "report-1", created_at: "2026-10-16T20:00:00+00:00" }), { status: 201 });
  } });
  assert.equal((await api.createReport(body)).id, "report-1");
});

test("report network/server errors and malformed success cannot show confirmation", async () => {
  const network = loadApi({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(network.createReport({}), /Network error.*Check Reports/);
  const server = loadApi({ fetch: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(server.createReport({}), /service is unavailable/);
  const malformed = loadApi({ fetch: async () => new Response("{}", { status: 201 }) });
  await assert.rejects(malformed.createReport({}), /invalid confirmation/);
});

test("report reads reject offline; samples are available only through explicit DEMO_DATA", async () => {
  const api = loadApi({ fetch: async () => { throw new TypeError("Offline"); } });
  await assert.rejects(api.getReports(), /Offline/);
  assert.ok(api.DEMO_DATA.reports.length > 0);
  assert.equal(await api.orNull(api.getReports()), null);
});
