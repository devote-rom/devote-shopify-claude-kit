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

/** Dotted keys in "from" that "into" does not have. A key that is text on one side and a group on the other is not missing: differingValues reports it. */
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

/** Each object in a locale file's text, by its key path: where its body starts and how many members it has. */
function objectsIn(text) {
  const objs = new Map();
  const stack = [];
  let key = null, expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    const top = stack[stack.length - 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (expectKey && top?.type === "obj") { key = JSON.parse(text.slice(i, j + 1)); if (top.entry) top.entry.members++; }
      i = j; continue;
    }
    if (c === "{") {
      const path = !top ? [] : top.type === "obj" && top.path ? [...top.path, key] : null;
      const entry = path ? { open: i + 1, members: 0, path } : null;
      if (entry) objs.set(JSON.stringify(path), entry);
      stack.push({ type: "obj", path, entry }); expectKey = true; continue;
    }
    if (c === "[") { stack.push({ type: "arr" }); expectKey = false; continue; }
    if (c === "}" || c === "]") { stack.pop(); expectKey = false; continue; }
    if (c === ":") { expectKey = false; continue; }
    if (c === ",") { expectKey = top?.type === "obj"; continue; }
  }
  return objs;
}

const canonical = (v) => JSON.stringify(v, (_, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/**
 * Live's locale text with every key it lacks added from "from", written into the text itself so its
 * comments, notes and layout stay exactly as they were. Null when that cannot be done safely: the
 * result is read back and must equal live's data plus the new keys, nothing else.
 */
export function insertMissingKeys(text, from) {
  const live = parseLocale(text);
  if (!live) return null;
  const objs = objectsIn(text);
  const unit = (text.match(/\n([ \t]+)"/) || [, "  "])[1];
  const groups = new Map();
  const walk = (src, into, path) => {
    for (const [k, v] of Object.entries(src || {})) {
      if (!(k in into)) { const id = JSON.stringify(path); if (!groups.has(id)) groups.set(id, []); groups.get(id).push([k, v]); }
      else if (isObj(v) && isObj(into[k])) walk(v, into[k], [...path, k]);
    }
  };
  walk(from, live.data, []);
  const edits = [];
  for (const [id, entries] of groups) {
    const o = objs.get(id);
    if (!o) return null;
    const indent = unit.repeat(o.path.length + 1);
    const body = entries.map(([k, v]) => `\n${indent}${JSON.stringify(k)}: ${JSON.stringify(v, null, unit).replace(/\n/g, "\n" + indent)}`).join(",");
    edits.push({ at: o.open, add: body + (o.members ? "," : "\n" + unit.repeat(o.path.length)) });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.add + out.slice(e.at);
  const back = parseLocale(out);
  return back && canonical(back.data) === canonical(withMissingKeys(live.data, from)) ? out : null;
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

// Comment, doc and raw blocks print nothing, so example keys inside them are not used. Blanked to
// spaces so line numbers stay right.
const NOT_RENDERED = /\{%-?\s*(comment|doc|raw)\s*-?%\}[\s\S]*?\{%-?\s*end\1\s*-?%\}/g;

/** Text keys a Liquid file prints with | t (the filter may sit on the next line), with their line numbers. */
export function translationKeys(liquid) {
  const text = String(liquid).replace(NOT_RENDERED, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  for (const m of text.matchAll(T_KEY)) {
    if (!m[2].startsWith("shopify.")) out.push({ key: m[2], line: text.slice(0, m.index).split("\n").length });
  }
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
