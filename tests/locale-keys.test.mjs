// Locale files: new text keys reach live without changing live's wording, and a | t key the
// default locale lacks fails the guard (Rom, 25 Nov 2026: "Translation missing" on previews).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { differingValues, hasKey, missingKeys, parseLocale, serializeLocale, translationKeys, withMissingKeys } from "../scripts/locale-keys.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a locale file with Shopify's leading comment still reads, and keeps the comment", () => {
  const text = "/*\n * ------------------------------------------------------------\n * IMPORTANT: The contents of this file are auto-generated.\n */\n{ \"general\": { \"close\": \"Close\" } }\n";
  const l = parseLocale(text);
  assert.equal(l.data.general.close, "Close");
  assert.match(serializeLocale(l), /^\/\*[\s\S]*IMPORTANT[\s\S]*\*\/\n\{/);
  assert.equal(parseLocale("{ not json"), null);
});

test("// notes inside a locale file (Horizon themes) and trailing commas still read; strings are untouched", () => {
  const text = '{\n  "a": {\n    // the label for the menu\n    "menu": "Menu // not a comment",\n    "url": "https://x.com/a,}",\n    "b": "c",\n  },\n}\n';
  const l = parseLocale(text);
  assert.equal(l.data.a.menu, "Menu // not a comment");
  assert.equal(l.data.a.url, "https://x.com/a,}");
  assert.equal(l.innerComments, true);
  assert.equal(parseLocale('{ "a": "b" }').innerComments, false);
});

test("release adds only the keys live lacks and never changes live's wording", () => {
  const live = { general: { close: "Shut", search: { label: "Find" } }, cart: { title: "Your bag" } };
  const repo = { general: { close: "Close", open: "Open", search: { label: "Search", empty: "Nothing found" } }, products: { sold_out: "Sold out" } };
  assert.deepEqual(missingKeys(repo, live).sort(), ["general.open", "general.search.empty", "products"].sort());
  assert.deepEqual(differingValues(repo, live).sort(), ["general.close", "general.search.label"]);
  const merged = withMissingKeys(live, repo);
  assert.equal(merged.general.close, "Shut");
  assert.equal(merged.general.search.label, "Find");
  assert.equal(merged.cart.title, "Your bag");
  assert.equal(merged.general.open, "Open");
  assert.equal(merged.general.search.empty, "Nothing found");
  assert.equal(merged.products.sold_out, "Sold out");
  assert.equal(live.general.open, undefined, "the original is not changed");
});

test("the | t keys a Liquid file prints are found, Shopify's own are skipped", () => {
  const liquid = "{{ 'general.close' | t }}\n<span>{{ \"products.count\" | t: count: n }}</span>\n{{ 'shopify.checkout.x' | t }}\n{{ key | t }}\n{{ 'a.b' | translate }}";
  assert.deepEqual(translationKeys(liquid), [{ key: "general.close", line: 1 }, { key: "products.count", line: 2 }, { key: "a.b", line: 5 }]);
  assert.equal(hasKey({ products: { count: { one: "1 item", other: "{{ count }} items" } } }, "products.count"), true);
  assert.equal(hasKey({ general: { close: "Close" } }, "general.open"), false);
  assert.equal(hasKey({ general: "x" }, "general.open"), false);
});

function guardIn(files) {
  const dir = mkdtempSync(join(tmpdir(), "t-keys-"));
  cpSync(join(KIT, "scripts"), join(dir, "scripts"), { recursive: true, filter: (s) => !s.endsWith("-baseline.json") });
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); }
  const r = spawnSync(process.execPath, [join(dir, "scripts", "qa", "translation-keys-exist.mjs")], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test("the guard fails on a | t key the default locale lacks, with file and line", () => {
  const r = guardIn({ "locales/en.default.json": '{ "general": { "close": "Close" } }', "sections/a.liquid": "{{ 'general.close' | t }}\n{{ 'general.open' | t }}" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /sections\/a\.liquid:2: 'general\.open' \| t is not in locales\/en\.default\.json/);
});

test("the guard passes when every key is there, and says so when there is no locale file", () => {
  assert.equal(guardIn({ "locales/en.default.json": '{ "general": { "close": "Close" } }', "locales/en.default.schema.json": "{}", "snippets/b.liquid": "{{ 'general.close' | t }}" }).status, 0);
  const none = guardIn({ "sections/a.liquid": "{{ 'general.open' | t }}" });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /not checked/);
});
