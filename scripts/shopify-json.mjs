// Reads what the Shopify CLI prints with --json / --output json, in both the 4.x and 5.x shapes.
//
// Exists because Shopify CLI 5.0 (Oct 2026) changed every shape the kit reads, and on one Mac
// (Nov 2026) deploy stopped with ".map is not a function" and npm run qa said it could not read
// theme check, every run:
//   theme list --json            4.x [ {id: 123, ...} ]            5.x { themes: [ {id: "123", ...} ] }
//   theme check --output json    4.x [ {path, offenses: [...]} ]   5.x { valid, issues: [ {filePath, severity, ...} ] }
//   theme push --json            4.x {"theme":{..., errors: {file: [msg]}}} on one line
//                                5.x { status, theme, issues: [ {filePath, message} ] }, pretty-printed
//   store execute --json         4.x the GraphQL data itself        5.x { data, extensions }
// Every reader returns null when the output is neither shape, so a caller says "could not read"
// and stops instead of reading an unknown shape as "nothing wrong".
import { isAbsolute, relative } from "node:path";

// The last whole JSON document in the output. Lines before it can be progress or diagnostic
// events (5.x prints those as one-line JSON) or a banner; a document starts on its own line, and
// both versions indent everything inside one, so only a line-start brace can begin it.
export function cliJson(out) {
  const text = String(out ?? "");
  try { return JSON.parse(text.trim()); } catch {}
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if ((c !== "{" && c !== "[") || (i > 0 && text[i - 1] !== "\n")) continue;
    try { return JSON.parse(text.slice(i).trim()); } catch {}
  }
  return null;
}

// theme list: an array of themes, each with id as a string. null when unreadable.
export function themeList(out) {
  const j = cliJson(out);
  const list = Array.isArray(j) ? j : Array.isArray(j?.themes) ? j.themes : null;
  return list && list.map((t) => ({ ...t, id: String(t.id) }));
}

// theme check: [{ path, errors }] per file with at least one offence, errors counting only
// severity "error" (4.x also used 0 for error). null when unreadable.
export function themeCheckFiles(out) {
  const j = cliJson(out);
  const isError = (s) => s === 0 || s === "error";
  if (Array.isArray(j)) {
    if (!j.every((f) => f && typeof f.path === "string" && Array.isArray(f.offenses))) return null;
    return j.map((f) => ({ path: f.path, errors: f.offenses.filter((o) => isError(o.severity)).length }));
  }
  if (j && typeof j === "object" && Array.isArray(j.issues)) {
    const counts = new Map();
    for (const i of j.issues) {
      if (!i || typeof i.filePath !== "string") return null;
      counts.set(i.filePath, (counts.get(i.filePath) || 0) + (isError(i.severity) ? 1 : 0));
    }
    return [...counts].map(([path, errors]) => ({ path, errors }));
  }
  return null;
}

// theme push: { errors: { file: [messages] } } for files Shopify rejected (empty when none), or
// { skipped: reason } when 5.x pushed nothing at all. null when unreadable. dir is the folder
// pushed, so 5.x's absolute file paths come back relative to it, like 4.x's.
export function pushResult(out, dir) {
  const j = cliJson(out);
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (j.status === "skipped" || j.status === "cancelled") return { skipped: j.reason || j.status, errors: {} };
  if (Array.isArray(j.issues) && typeof j.status === "string") {
    const errors = {};
    for (const i of j.issues) {
      const f = dir && isAbsolute(i.filePath) ? relative(dir, i.filePath).replace(/\\/g, "/") : i.filePath;
      (errors[f] ||= []).push(i.message);
    }
    return { errors };
  }
  if (j.theme && typeof j.theme === "object") return { errors: j.theme.errors || {} };
  return null;
}

// store execute: the GraphQL data (the object holding the query's top-level fields). null when unreadable.
export function executeData(out) {
  const j = cliJson(out);
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if ("data" in j && (j.data === null || typeof j.data === "object") && Object.keys(j).every((k) => k === "data" || k === "extensions")) return j.data;
  return j;
}
