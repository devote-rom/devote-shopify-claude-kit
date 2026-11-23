// The kit reads the Shopify CLI's JSON in both the 4.x and 5.x shapes (scripts/shopify-json.mjs).
//
// Exists because Shopify CLI 5.0 (Oct 2026) wrapped theme list in {themes}, turned theme check
// into {valid, issues}, reshaped and pretty-printed theme push, and wrapped store execute in
// {data}. On one Mac deploy stopped with ".map is not a function" and npm run qa could not read
// theme check at all. The outputs below are the real shapes from both versions, names changed.
// The last test is the guard: no script parses CLI JSON by hand again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliJson, executeData, pushResult, themeCheckFiles, themeList } from "../scripts/shopify-json.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pretty = (o) => JSON.stringify(o, null, 2) + "\n";

test("theme list: 4.x plain array and 5.x {themes}, ids as strings", () => {
  const v4 = pretty([{ id: 111, name: "Live", processing: false, createdAtRuntime: false, role: "live" }]);
  const v5 = pretty({ themes: [{ id: "111", name: "Live", role: "live", processing: false }] });
  assert.deepEqual(themeList(v4).map((t) => t.id), ["111"]);
  assert.deepEqual(themeList(v5).map((t) => t.id), ["111"]);
  assert.deepEqual(themeList(pretty({ themes: [] })), []);
  assert.equal(themeList("Not logged in"), null);
  assert.equal(themeList(pretty({ error: { type: "abort", message: "no" } })), null);
});

test("theme check: 4.x files with offenses and 5.x issues count the same errors per file", () => {
  const a = "/repo/sections/a.liquid", b = "/repo/snippets/b.liquid";
  const v4 = JSON.stringify([
    { path: a, offenses: [{ check: "ImgWidthAndHeight", severity: "error" }, { check: "X", severity: 0 }], errorCount: 2 },
    { path: b, offenses: [{ check: "OrphanedSnippet", severity: "warning" }], errorCount: 0 },
  ]);
  const v5 = JSON.stringify({ valid: false, issues: [
    { filePath: a, check: "ImgWidthAndHeight", severity: "error", startRow: 5 },
    { filePath: a, check: "LiquidHTMLSyntaxError", severity: "error", startRow: 9 },
    { filePath: b, check: "OrphanedSnippet", severity: "warning", startRow: 1 },
  ] });
  const want = [{ path: a, errors: 2 }, { path: b, errors: 0 }];
  assert.deepEqual(themeCheckFiles(v4), want);
  assert.deepEqual(themeCheckFiles(v5), want);
  assert.deepEqual(themeCheckFiles(JSON.stringify({ valid: true, issues: [] })), []);
  assert.equal(themeCheckFiles(""), null);
  assert.equal(themeCheckFiles(JSON.stringify({ valid: true })), null, "no issues list is unreadable, not clean");
});

test("theme push: 4.x one-line {theme} and 5.x pretty {status, issues} give the same rejected files", () => {
  const v4ok = `Pushing...\n{"theme":{"id":1,"name":"P","role":"unpublished","errors":{}}}\n`;
  const v4bad = `{"theme":{"id":1,"name":"P","errors":{"sections/header.liquid":["Invalid schema"]}}}`;
  const theme = { id: "1", name: "P", role: "unpublished", storeDomain: "x.myshopify.com", previewUrl: null, editorUrl: null };
  const v5ok = pretty({ status: "success", changed: true, theme, issues: [] });
  const v5bad = pretty({ status: "partial", changed: true, theme, issues: [{ filePath: "/tmp/stage/sections/header.liquid", message: "Invalid schema" }] });
  assert.deepEqual(pushResult(v4ok), { errors: {} });
  assert.deepEqual(pushResult(v5ok, "/tmp/stage"), { errors: {} });
  assert.deepEqual(pushResult(v4bad).errors, { "sections/header.liquid": ["Invalid schema"] });
  assert.deepEqual(pushResult(v5bad, "/tmp/stage").errors, { "sections/header.liquid": ["Invalid schema"] });
  assert.equal(pushResult(pretty({ status: "skipped", reason: "unsafe-directory" })).skipped, "unsafe-directory");
  assert.equal(pushResult("Theme pushed"), null);
});

test("store execute: 4.x data and 5.x {data, extensions} give the same fields", () => {
  const shop = { shop: { name: "A store" } };
  assert.deepEqual(executeData(pretty(shop)), shop);
  assert.deepEqual(executeData(pretty({ data: shop, extensions: { cost: { actualQueryCost: 1 } } })), shop);
});

test("cliJson takes the last document after one-line progress events", () => {
  const out = `{"type":"progress","status":"started","message":"Loading"}\n{"type":"progress","status":"completed"}\n${pretty({ themes: [{ id: "9" }] })}`;
  assert.deepEqual(cliJson(out), { themes: [{ id: "9" }] });
});

test("guard: no kit script parses Shopify CLI JSON output by hand", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith(".mjs") && rel !== "scripts/shopify-json.mjs") files.push(rel);
    }
  };
  walk("scripts");
  const bad = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      // a CLI call whose output goes straight into JSON.parse, or the old one-line push marker
      if (/JSON\.parse\([^)]*\b(run|shopify|execCli|exec)\(\s*\[?\s*"(shopify|theme)/.test(line) || line.includes(`'{"theme"'`)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], "read Shopify CLI output with scripts/shopify-json.mjs, which knows both the 4.x and 5.x shapes");
});
