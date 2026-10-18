// node --test tests/app-shell.test.cjs
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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, process,
    require(name) { return name.startsWith("@/") ? load(name.slice(2) + ".ts") : require(name); },
  });
  return exports;
}

test("home-screen launch uses crew view, standalone display, and source color tokens", () => {
  const manifest = load("app/manifest.ts").default();
  const tokens = fs.readFileSync(path.join(__dirname, "../styles/tokens.css"), "utf8");
  assert.equal(manifest.name, "Fieldcast");
  assert.equal(manifest.short_name, "Fieldcast");
  assert.equal(manifest.start_url, "/crew");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.theme_color, tokens.match(/--pc-brand:\s*([^;]+);/)[1]);
  assert.equal(manifest.background_color, tokens.match(/--pc-bg:\s*([^;]+);/)[1]);
  for (const icon of manifest.icons.filter(icon => icon.type === "image/png")) {
    const data = fs.readFileSync(path.join(__dirname, "../public", icon.src));
    assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes);
  }
  assert.ok(manifest.icons.some(icon => icon.purpose === "maskable"));
});

test("Apple and social images have the intended sizes, and favicon is valid ICO", () => {
  const apple = fs.readFileSync(path.join(__dirname, "../public/icons/apple-touch-icon.png"));
  assert.equal(apple.readUInt32BE(16), 180); assert.equal(apple.readUInt32BE(20), 180);
  const social = fs.readFileSync(path.join(__dirname, "../public/social-preview.png"));
  assert.equal(social.readUInt32BE(16), 1200); assert.equal(social.readUInt32BE(20), 630);
  const favicon = fs.readFileSync(path.join(__dirname, "../app/favicon.ico"));
  assert.equal(favicon.readUInt16LE(2), 1); assert.equal(favicon.readUInt16LE(4), 1);
  assert.equal(favicon.readUInt32LE(18), 22);
});

test("each page metadata has a description and a matching social title", () => {
  const metadata = load("lib/metadata.ts").pageMetadata("Alerts", "Current site alerts.");
  assert.equal(metadata.title.absolute, "Alerts · Fieldcast");
  assert.equal(metadata.description, "Current site alerts.");
  assert.equal(metadata.openGraph.title, "Alerts · Fieldcast");
  assert.equal(metadata.twitter.card, "summary_large_image");
  assert.equal(metadata.twitter.title, metadata.openGraph.title);
  // The homepage's shared-link card says the name and the tagline, while its tab title stays per page.
  const home = load("lib/metadata.ts").pageMetadata("Dashboard", "Monitor sites.", { title: "Fieldcast", description: "Live job-site safety for Florida utility crews" });
  assert.equal(home.title.absolute, "Dashboard · Fieldcast");
  assert.equal(home.openGraph.title, "Fieldcast");
  assert.equal(home.openGraph.description, "Live job-site safety for Florida utility crews");
});
