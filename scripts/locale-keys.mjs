// Locale files: reading them, finding the text keys code uses, and adding new keys to live's copy.
//
// Exists because new or renamed text keys reached the preview and live after the code that used
// them, so pages showed "Translation missing" until someone pushed the locale files by hand (Rom,
// 25 Nov 2026). Deploy now pushes changed locale files with the code, and release adds the keys
// live does not have yet to live's own copy, leaving every value live already has as it is: the
// client edits that wording under Edit default theme content.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * JSON with the comments Shopify allows in locale files taken out: /* *\/ blocks, // lines (Horizon
 * themes put translator notes inside), and trailing commas. Text inside strings is left alone.
 */
export function stripJsonComments(text) {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inString) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === "," && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) continue;
    out += c;
  }
  return out;
}

/**
 * A locale file's leading comment (Shopify writes one on some themes), its data, and whether it held
 * other comments (which serializeLocale cannot keep). Null if unreadable.
 */
export function parseLocale(text) {
  const m = String(text).match(/^\s*(\/\*[\s\S]*?\*\/)?([\s\S]*)$/);
  const body = stripJsonComments(m[2]);
  try { return { comment: m[1] || "", data: JSON.parse(body), innerComments: body.replace(/\s/g, "") !== m[2].replace(/\s/g, "") }; } catch { return null; }
}

export function serializeLocale({ comment, data }) {
  return (comment ? comment + "\n" : "") + JSON.stringify(data, null, 2) + "\n";
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Dotted keys in "from" that "into" does not have. A key whose parent is a string on "into" counts as missing. */
export function missingKeys(from, into, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(from || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!isObj(into) || !(k in into)) out.push(key);
    else if (isObj(v) && isObj(into[k])) out.push(...missingKeys(v, into[k], key));
  }
  return out;
}

/** Dotted keys both have, with different string values. */
export function differingValues(from, into, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(from || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!isObj(into) || !(k in into)) continue;
    if (isObj(v) && isObj(into[k])) out.push(...differingValues(v, into[k], key));
    else if (JSON.stringify(v) !== JSON.stringify(into[k])) out.push(key);
  }
  return out;
}

/** "into" with every key it lacks copied from "from". Nothing "into" has is changed. */
export function withMissingKeys(into, from) {
  const out = structuredClone(into);
  for (const [k, v] of Object.entries(from || {})) {
    if (!(k in out)) out[k] = structuredClone(v);
    else if (isObj(v) && isObj(out[k])) out[k] = withMissingKeys(out[k], v);
  }
  return out;
}

/** Whether a dotted key resolves in locale data (to a string, or to an object such as one/other plurals). */
export function hasKey(data, key) {
  let cur = data;
  for (const part of key.split(".")) {
    if (!isObj(cur) || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

// 'a.b' | t, "a.b" | t: and | translate. Keys Shopify provides itself start with shopify.
const T_KEY = /(['"])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1\s*\|\s*(?:t|translate)\b/g;

/** Text keys a Liquid file prints with | t, with their line numbers. */
export function translationKeys(liquid) {
  const out = [];
  String(liquid).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(T_KEY)) if (!m[2].startsWith("shopify.")) out.push({ key: m[2], line: i + 1 });
  });
  return out;
}

/** The theme's default locale file (locales/<lang>.default.json, not the schema one), or null. */
export function defaultLocaleFile(root) {
  const dir = join(root, "locales");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /\.default\.json$/.test(n) && !/\.schema\.json$/.test(n));
  return f ? `locales/${f}` : null;
}

export function readLocale(path) {
  return existsSync(path) ? parseLocale(readFileSync(path, "utf8")) : null;
}
