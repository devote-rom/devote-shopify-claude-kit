// Changed locale files go up with the code on every deploy, without --with-json, once the editor
// check has passed; templates still need --with-json.
//
// Exists because new text keys reached the preview after the code that printed them, so pages
// showed "Translation missing" until someone pushed locales/*.json by hand (Rom, 25 Nov 2026).
// Runs the real deploy.mjs against a fake Shopify CLI that logs every push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FAKE_CLI = `
const { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");
const a = process.argv.slice(2);
const opt = (n) => a[a.indexOf(n) + 1];
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const rel = (root, f) => relative(root, f).split("\\\\").join("/");
if (a[0] === "theme" && a[1] === "list") { console.log(JSON.stringify([{ id: 1, role: "live" }])); process.exit(0); }
if (a[0] === "theme" && a[1] === "pull") {
  const only = a.flatMap((x, i) => (x === "--only" ? [a[i + 1]] : []));
  const re = only.map((g) => new RegExp("^" + g.replace(/[.]/g, "\\\\.").replace(/\\*/g, "[^/]*") + "$"));
  const src = process.env.FAKE_THEME, dest = opt("--path");
  for (const f of walk(src)) { const r = rel(src, f); if (re.some((x) => x.test(r))) { mkdirSync(dirname(join(dest, r)), { recursive: true }); cpSync(f, join(dest, r)); } }
  process.exit(0);
}
if (a[0] === "theme" && a[1] === "push") {
  const from = a.includes("--path") ? opt("--path") : process.cwd();
  const code = !a.includes("--path");
  const sent = walk(from).map((f) => rel(from, f)).filter((r) => !code || /^(sections|snippets|blocks|layout|assets)\\//.test(r) && !r.endsWith(".json"));
  for (const r of sent) { mkdirSync(dirname(join(process.env.FAKE_THEME, r)), { recursive: true }); cpSync(join(from, r), join(process.env.FAKE_THEME, r)); }
  appendFileSync(process.env.FAKE_LOG, JSON.stringify(sent) + "\\n");
  console.log(JSON.stringify({ theme: { errors: {} } }));
  process.exit(0);
}
console.error("fake shopify: not handled: " + a.join(" "));
process.exit(1);
`;

const put = (root, files) => { for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); } };
const editorHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deploy-locales-"));
  const repo = join(dir, "repo"), theme = join(dir, "theme"), bin = join(dir, "bin"), log = join(dir, "pushes.log");
  cpSync(join(KIT, "scripts"), join(repo, "scripts"), { recursive: true, filter: (src) => !src.endsWith("-baseline.json") });
  const runJs = join(bin, "node_modules", "@shopify", "cli", "bin", "run.js");
  put(bin, { [join("node_modules", "@shopify", "cli", "bin", "run.js")]: FAKE_CLI });
  writeFileSync(join(bin, "shopify"), `#!/bin/sh\nexec "${process.execPath}" "${runJs}" "$@"\n`);
  chmodSync(join(bin, "shopify"), 0o755);
  writeFileSync(join(bin, "shopify.cmd"), `@"${process.execPath}" "%~dp0node_modules\\@shopify\\cli\\bin\\run.js" %*\r\n`);
  writeFileSync(log, "");
  const env = { ...process.env, FAKE_THEME: theme, FAKE_LOG: log, SKIP_QA: "1", PATH: bin + delimiter + (process.env.PATH ?? process.env.Path ?? "") };
  delete env.Path;

  const LOCALE = '{ "general": { "close": "Close" } }';
  const TEMPLATE = '{ "sections": {} }';
  put(theme, { "sections/a.liquid": "{{ 'general.close' | t }}", "locales/en.default.json": LOCALE, "templates/index.json": TEMPLATE });
  put(repo, {
    "sections/a.liquid": "{{ 'general.close' | t }} {{ 'general.open' | t }}",
    "locales/en.default.json": '{ "general": { "close": "Close", "open": "Open" } }',
    "templates/index.json": '{ "sections": { "new": {} } }',
    ".shopifyignore": "templates/*.json\nconfig/settings_data.json\nsections/*.json\nlocales/*.json\n",
    ".editor-baseline.json": JSON.stringify({ 2: { "locales/en.default.json": editorHash(LOCALE), "templates/index.json": editorHash(TEMPLATE) } }),
  });
  // a review stamp for exactly this code, as review:stamp would write it
  const stamp = spawnSync(process.execPath, ["--input-type=module", "-e", `import { codeHash } from ${JSON.stringify(new URL("file://" + join(repo, "scripts", "review-stamp.mjs")).href)}; console.log(codeHash())`], { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, ".review-stamp.json"), JSON.stringify({ hash: stamp.stdout.trim(), at: "test", code: "c.md", security: "s.md" }));
  const deploy = (...extra) => spawnSync(process.execPath, [join(repo, "scripts", "deploy.mjs"), "--store", "acme.myshopify.com", "--theme", "2", "--first-sync", ...(extra.includes("--small") ? ["--domain", "www.acme.com.au"] : ["--skip-walks"]), ...extra], { cwd: repo, env, encoding: "utf8" });
  const pushed = () => readFileSync(log, "utf8").split("\n").filter(Boolean).flatMap((l) => JSON.parse(l));
  return { dir, repo, theme, deploy, pushed };
}

test("a changed locale file goes up with the code, without --with-json", () => {
  const { dir, theme, deploy, pushed } = setup();
  try {
    const r = deploy();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pushed().includes("locales/en.default.json"), r.stdout);
    assert.match(readFileSync(join(theme, "locales/en.default.json"), "utf8"), /"open"/);
    // templates still need --with-json
    assert.ok(!pushed().includes("templates/index.json"));
    assert.doesNotMatch(readFileSync(join(theme, "templates/index.json"), "utf8"), /"new"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a locale someone edited on the theme stops the deploy instead of being overwritten", () => {
  const { dir, theme, deploy, pushed } = setup();
  try {
    put(theme, { "locales/en.default.json": '{ "general": { "close": "Close it" } }' });
    const r = deploy();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!pushed().includes("locales/en.default.json"));
    assert.match(readFileSync(join(theme, "locales/en.default.json"), "utf8"), /Close it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the fast lane refuses a change that is not small, before anything is pushed", () => {
  const { dir, repo, deploy, pushed } = setup();
  try {
    put(repo, { "snippets/price.liquid": "{{ product.price | money }}" });
    const r = deploy("--small", "--page", "/");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Not a small change: snippets\/price\.liquid handles money/);
    assert.deepEqual(pushed(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
