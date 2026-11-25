// Locale files: new text keys reach live without changing live's wording, and a | t key the
// default locale lacks fails the guard (Rom, 25 Nov 2026: "Translation missing" on previews).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { differingValues, hasKey, insertMissingKeys, missingKeys, parseLocale, translationKeys, withMissingKeys } from "../scripts/locale-keys.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a locale file with Shopify's leading comment still reads", () => {
  const text = "/*\n * ------------------------------------------------------------\n * IMPORTANT: The contents of this file are auto-generated.\n */\n{ \"general\": { \"close\": \"Close\" } }\n";
  assert.equal(parseLocale(text).data.general.close, "Close");
  assert.equal(parseLocale("{ not json"), null);
});

test("// notes inside a locale file (Horizon themes) and trailing commas still read; strings are untouched", () => {
  const text = '{\n  "a": {\n    // the label for the menu\n    "menu": "Menu // not a comment",\n    "url": "https://x.com/a,}",\n    "b": "c",\n  },\n}\n';
  const l = parseLocale(text);
  assert.equal(l.data.a.menu, "Menu // not a comment");
  assert.equal(l.data.a.url, "https://x.com/a,}");
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

test("new keys go into live's own text: comments, notes, wording and layout stay as they were", () => {
  const live = '/*\n * auto-generated\n */\n{\n    "general": {\n        // the menu label\n        "menu": "Menu",\n        "close": "Shut"\n    },\n    "empty": {}\n}\n';
  const repo = { general: { menu: "Menu", close: "Close", open: "Open", search: { label: "Search" } }, empty: { a: "A" }, products: { sold_out: "Sold out" } };
  const out = insertMissingKeys(live, repo);
  assert.ok(out, "inserted");
  assert.match(out, /\/\/ the menu label/);
  assert.match(out, /^\/\*\n \* auto-generated/);
  assert.match(out, /\n {8}"open": "Open",/, "four-space layout kept");
  const back = parseLocale(out).data;
  assert.equal(back.general.close, "Shut");
  assert.equal(back.general.open, "Open");
  assert.equal(back.general.search.label, "Search");
  assert.equal(back.empty.a, "A");
  assert.equal(back.products.sold_out, "Sold out");
  // every original line is still there, unchanged
  for (const line of live.split("\n").filter((l) => l.trim() && !l.includes("{}"))) assert.ok(out.includes(line), line); // the empty group gains its key
});

test("nothing to add leaves live's text exactly as it was", () => {
  const live = '{\n  "a": "b" // note\n}\n';
  assert.equal(insertMissingKeys(live, { a: "changed" }), live);
});

test("keys in comment, doc and raw blocks are not used; a | t on the next line is", () => {
  const liquid = "{% doc %}\n  {{ 'example.only' | t }}\n{% enddoc %}\n{% comment %}{{ 'old.key' | t }}{% endcomment %}\n{%- raw -%}{{ 'raw.key' | t }}{%- endraw -%}\n{{ 'real.key'\n  | t }}";
  assert.deepEqual(translationKeys(liquid), [{ key: "real.key", line: 6 }]);
});

test("insertion keeps a same-line note with its group, CRLF line endings, and inherited names are real keys", () => {
  const live = '{\r\n  "a": { // translator note\r\n    "x": "1"\r\n  }\r\n}\r\n';
  const out = insertMissingKeys(live, { a: { x: "1", y: "2", constructor: "C" } });
  assert.match(out, /\{ \/\/ translator note\r\n    "y": "2"/);
  assert.doesNotMatch(out.replace(/\r\n/g, ""), /\n/, "no bare LF");
  assert.equal(parseLocale(out).data.a.constructor, "C");
  assert.deepEqual(missingKeys({ toString: "t" }, {}), ["toString"]);
});

test("keys in inline {% # %} comments are not used", () => {
  assert.deepEqual(translationKeys("{% # {{ 'old.key' | t }} %}\n{{ 'new.key' | t }}"), [{ key: "new.key", line: 2 }]);
});
