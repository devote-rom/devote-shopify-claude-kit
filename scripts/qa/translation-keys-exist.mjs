// Guard: every text key Liquid prints with | t is in the theme's default locale file.
//
// A key the locale file lacks shows "Translation missing: en.<key>" on the page, and nothing else
// fails: the deploy goes green and the shopper sees it (Rom, 25 Nov 2026). Add the key to
// locales/<lang>.default.json, or use the theme's own key when it has one.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLocaleFile, hasKey, readLocale, translationKeys } from "../locale-keys.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = defaultLocaleFile(ROOT);
if (!file) { console.log("  not checked: no locales/*.default.json in this repo"); process.exit(0); }
const locale = readLocale(join(ROOT, file));
if (!locale) { console.log(`  ${file}:1: is not valid JSON, so no text key can be checked`); process.exit(1); }

const problems = [];
for (const dir of ["sections", "snippets", "blocks", "layout", "templates", "templates/customers"]) {
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".liquid")); } catch { continue; }
  for (const f of files) {
    for (const { key, line } of translationKeys(readFileSync(join(ROOT, dir, f), "utf8"))) {
      if (!hasKey(locale.data, key)) problems.push(`${dir}/${f}:${line}: '${key}' | t is not in ${file}, so the page shows "Translation missing"`);
    }
  }
}
if (problems.length) { for (const p of problems) console.log("  " + p); process.exit(1); }
