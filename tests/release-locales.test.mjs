// npm run release writes new text keys into live's own locale file, keeping its notes, and stops
// when a key the code prints would still be missing on live.
//
// Exists because new keys reached live after the code that printed them, so live showed
// "Translation missing" (Rom, 25 Nov 2026). Runs the real release.mjs against a fake Shopify CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  const src = opt("--theme") === "1" && process.env.FAKE_LIVE ? process.env.FAKE_LIVE : process.env.FAKE_THEME, dest = opt("--path");
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

function setup({ liveLocale, repoLocale, liquid }) {
  const dir = mkdtempSync(join(tmpdir(), "release-locales-"));
  const repo = join(dir, "repo"), live = join(dir, "live"), bin = join(dir, "bin"), log = join(dir, "pushes.log");
  cpSync(join(KIT, "scripts"), join(repo, "scripts"), { recursive: true, filter: (src) => !src.endsWith("-baseline.json") });
  const runJs = join(bin, "node_modules", "@shopify", "cli", "bin", "run.js");
  put(bin, { [join("node_modules", "@shopify", "cli", "bin", "run.js")]: FAKE_CLI });
  writeFileSync(join(bin, "shopify"), `#!/bin/sh\nexec "${process.execPath}" "${runJs}" "$@"\n`);
  chmodSync(join(bin, "shopify"), 0o755);
  writeFileSync(join(bin, "shopify.cmd"), `@"${process.execPath}" "%~dp0node_modules\\@shopify\\cli\\bin\\run.js" %*\r\n`);
  writeFileSync(log, "");
  const env = { ...process.env, FAKE_THEME: live, FAKE_LIVE: live, FAKE_LOG: log, PATH: bin + delimiter + (process.env.PATH ?? process.env.Path ?? "") };
  delete env.Path;
  // A git hook sets GIT_DIR; inherited, git in the scripts below reads the kit's repo, not this one
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const OLD = "<p>old</p>";
  put(live, { "sections/a.liquid": OLD, "locales/en.default.json": liveLocale, "templates/index.json": "{}" });
  put(repo, {
    "sections/a.liquid": OLD,
    "locales/en.default.json": repoLocale,
    "templates/index.json": "{}",
    "package.json": JSON.stringify({ scripts: { deploy: "node scripts/deploy.mjs --store acme.myshopify.com --theme 2 --domain www.acme.com.au" } }),
  });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe", env });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "live as pulled");
  put(repo, { "sections/a.liquid": liquid });
  const hash = spawnSync(process.execPath, ["--input-type=module", "-e", `import { codeHash } from ${JSON.stringify(new URL("file://" + join(repo, "scripts", "review-stamp.mjs")).href)}; console.log(codeHash())`], { cwd: repo, env, encoding: "utf8" }).stdout.trim();
  put(repo, {
    ".review-stamp.json": JSON.stringify({ hash, at: "t", code: "c.md", security: "s.md" }),
    ".qa-pass.json": JSON.stringify({ codeHash: hash, store: "acme.myshopify.com", theme: "2" }),
    ".release-approval.json": JSON.stringify({ by: "A person", at: "t", store: "acme.myshopify.com", codeHash: hash }),
  });
  const release = () => spawnSync(process.execPath, [join(repo, "scripts", "release.mjs")], { cwd: repo, env, encoding: "utf8" });
  const pushed = () => readFileSync(log, "utf8").split("\n").filter(Boolean).flatMap((l) => JSON.parse(l));
  return { dir, live, release, pushed };
}

test("release adds the new key to live's own locale text and keeps live's notes and wording", () => {
  const liveLocale = '/*\n * auto-generated\n */\n{\n  "general": {\n    // menu label\n    "close": "Shut"\n  }\n}\n';
  const { dir, live, release, pushed } = setup({
    liveLocale,
    repoLocale: '{ "general": { "close": "Close", "open": "Open" } }',
    liquid: "{{ 'general.close' | t }} {{ 'general.open' | t }}",
  });
  try {
    const r = release();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(pushed().includes("locales/en.default.json"), r.stdout);
    const now = readFileSync(join(live, "locales/en.default.json"), "utf8");
    for (const line of liveLocale.split("\n").filter((l) => l.trim())) assert.ok(now.includes(line), line);
    assert.match(now, /"open": "Open"/);
    assert.match(r.stdout, /1 new text key added to live's copy: general\.open/);
    assert.match(r.stdout, /differ from live and were left as live has them: general\.close/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release stops when a key the code prints is text on live and a group in the repo", () => {
  const { dir, live, release, pushed } = setup({
    liveLocale: '{ "products": { "badge": "Badge" } }',
    repoLocale: '{ "products": { "badge": { "new": "New" } } }',
    liquid: "{{ 'products.badge.new' | t }}",
  });
  try {
    const r = release();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /would still lack 1 text key\(s\) the code prints.*products\.badge\.new/);
    assert.deepEqual(pushed(), []);
    assert.equal(readFileSync(join(live, "sections/a.liquid"), "utf8"), "<p>old</p>");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
