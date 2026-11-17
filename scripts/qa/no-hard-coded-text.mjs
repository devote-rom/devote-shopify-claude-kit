// Guard: no shopper-facing text that only a developer can change.
//
// Exists because on 17 Nov 2026 one build went live with about 110 bits of text written straight
// into its Liquid: the store's address, phone and opening hours, the dispatch cut-off line,
// shipping and returns lines, cart messages, and labels like "Filter" and "Remove". The client
// could not change any of it without a developer. Marcel: "Nothing should ever be coded in... A
// user with no coding knowledge or access to code should be able to edit all the information."
// DEVOTE-KIT.md, "Nothing Is Hard-Coded", says where each kind of text goes instead.
//
// Fails on, in sections/, snippets/ and blocks/*.liquid:
//   - a text node: <p>Free shipping</p>, or the words around an output: {{ n }} items left
//   - a text attribute: alt, placeholder, title, aria-label (and a submit button's value)
//   - a string printed from Liquid without | t: {{ 'Shop now' }}, echo 'Shop now'
//   - a fallback that prints words: {{ section.settings.heading | default: 'Our story' }}
//   - a label passed or assigned as a literal: {% render 'button', label: 'Shop now' %},
//     {% assign button_text = 'Add to cart' %}
// Ignored: schema, stylesheet, javascript, comments, <script> and <style>; files a page builder or
// app writes (pf-*, gp-*, locksmith-*, ai_gen_block_*: edited in that app); text that is only
// punctuation, numbers, symbols, entities like &nbsp; or a separator; a line carrying, or following
// a line carrying, {% # hard-coded-ok: <why> %}. The marker needs a reason.
//
// Only text the build added fails. Each file is compared with the theme as it was first pulled:
// the repo's first commit, or scripts/qa/hard-coded-text-baseline.json when it exists. A string
// that file already had (as often as it had it) is inherited and passes. A new file has none.
// If the first commit is not the theme as downloaded (the build started from a fresh theme added
// later), record that commit instead, never the working copy:
//   node scripts/qa/no-hard-coded-text.mjs --write-baseline --from <commit that added the theme>
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = join(ROOT, "scripts", "qa", "hard-coded-text-baseline.json");
export const DIRS = ["sections", "snippets", "blocks"];
const ATTRS = new Set(["alt", "placeholder", "title", "aria-label", "aria-description", "aria-roledescription", "aria-valuetext"]);
const LABEL_KEY = /(^|_)(label|labels|heading|subheading|title|subtitle|caption|message|placeholder|alt|text|copy|description|cta|tooltip|note|button)$/i;
const MARKER = /hard-coded-ok\s*:\s*\S/;
const SEP = "\u0001"; // stands where markup or a Liquid tag was, so two text nodes stay two

const blank = (s) => s.replace(/[^\n]/g, " ");
const cut = (s) => s.replace(/[^\n]/g, SEP);

// Whether a string reads as words a shopper sees, rather than a class, handle, file or setting.
export function isProse(s) {
  const t = s.trim();
  if (!/\p{L}{2,}/u.test(t)) return false;
  if (/[\/\\{}<>=#_]|\.[a-z0-9]{2,5}$/i.test(t) || /^to (top|bottom|left|right)\b/.test(t)) return false;
  if (/^\p{Lu}\p{Ll}|^\p{Lu}{2,}\b/u.test(t)) return true;
  const words = t.split(/\s+/);
  return words.length >= 2 && words.every((w) => /^[\p{L}\p{N}'’.,!?:;()&%$+]+$/u.test(w));
}

// A literal passed as a label: any word that is not an identifier (primary, h2, add-to-cart).
function isLabelValue(s) {
  const t = s.trim();
  if (!/\p{L}{2,}/u.test(t)) return false;
  if (/[\/\\{}<>=#_]|\.[a-z0-9]{2,5}$/i.test(t)) return false;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(t)) return false;
  return isProse(t) || /^\p{L}+$/u.test(t) && /^\p{Lu}/u.test(t);
}

// Whether text carries no words: only entities (&nbsp;), punctuation, symbols, numbers, a
// separator ("x", "|", "/"), or code a snippet returns rather than prints (CSS in a capture, a
// class name, a path, a srcset width, true or false).
const CODE_WORDS = new Set(["true", "false", "nil", "null", "blank", "empty", "selected", "checked", "disabled", "hidden", "required", "readonly", "multiple", "open", "defer", "async", "lazy", "eager", "auto", "none"]);
export function isAllowed(text) {
  const t = text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, " ");
  if (/[{};]/.test(t)) return true;
  return !t.split(/\s+/).some((w) => {
    const word = w.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if ((word.match(/\p{L}/gu) || []).length < 2) return false;
    if (/[\/\\_=#@]|\p{L}\.\p{L}/u.test(w) || /^[.#\/\[]/.test(w)) return false;
    if (/^[a-z0-9-]*-[a-z0-9-]*$/.test(w) || /^\d+[a-z%]+$/i.test(word)) return false;
    return !CODE_WORDS.has(word);
  });
}

const lineAt = (src, i) => src.slice(0, i).split("\n").length;

// Check one Liquid statement (the inside of {{ }} as "echo ...", or one line of a tag).
function liquidLiterals(stmt, at, push) {
  const m = stmt.match(/^\s*(\w+)\s*([\s\S]*)$/);
  if (!m) return;
  const [, tag, rest] = m;
  const restAt = at + stmt.indexOf(rest, m[0].indexOf(tag) + tag.length);
  if (tag === "echo") {
    const lit = rest.match(/^(['"])(.*?)\1([\s\S]*)$/);
    if (lit && !/\|\s*t\b/.test(lit[3]) && isProse(lit[2])) push(restAt, "liquid string", lit[2]);
  }
  if (tag === "assign") {
    const a = rest.match(/^(\w+)\s*=\s*(['"])(.*?)\2([\s\S]*)$/);
    if (a && LABEL_KEY.test(a[1]) && !/\|\s*t\b/.test(a[4]) && isLabelValue(a[3])) push(restAt + rest.indexOf(a[2] + a[3]), `assign ${a[1]}`, a[3]);
  }
  if (tag === "render" || tag === "section" || tag === "content_for" || tag === "include") {
    for (const p of rest.matchAll(/(\w+)\s*:\s*(['"])(.*?)\2/g)) {
      if (LABEL_KEY.test(p[1]) && isLabelValue(p[3])) push(restAt + p.index, `${tag} ${p[1]}:`, p[3]);
    }
  }
  for (const d of rest.matchAll(/\|\s*default\s*:\s*(['"])(.*?)\1/g)) {
    if (isProse(d[2])) push(restAt + d.index, "default:", d[2]);
  }
}

// Every hard-coded string in one Liquid file: [{ line, kind, text }].
export function findHardCoded(src) {
  const found = [];
  const push = (i, kind, text) => found.push({ line: lineAt(src, i), kind, text: text.replace(/\s+/g, " ").trim() });

  // 1. Whole blocks nobody reads as page text.
  let s = src.replace(
    /{%-?\s*(schema|stylesheet|javascript|style|comment|doc|raw)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}|{%-?\s*#[\s\S]*?-?%}|<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi,
    cut,
  );

  // 2. Liquid: check its string literals, then take it out. {{ }} leaves spaces (it sits inside a
  //    sentence), {% %} leaves a separator (it starts or ends one).
  s = s.replace(/{{-?([\s\S]*?)-?}}|{%-?([\s\S]*?)-?%}/g, (whole, out, tag, i) => {
    const bodyAt = i + whole.indexOf(out ?? tag);
    if (out !== undefined) liquidLiterals(`echo ${out}`, bodyAt - 5, push);
    else if (/^\s*liquid\b/.test(tag)) {
      let off = 0;
      for (const line of tag.split("\n")) {
        if (!/^\s*(liquid\b|#)/.test(line)) liquidLiterals(line, bodyAt + off, push);
        off += line.length + 1;
      }
    } else liquidLiterals(tag, bodyAt, push);
    return out !== undefined ? blank(whole) : cut(whole);
  });

  // 3. Markup: check text attributes, then take the tags out.
  s = s.replace(/<\/?([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>|<![^>]*>/g, (whole, name, attrs, i) => {
    if (attrs) {
      const submit = /^input$/i.test(name) && /\btype\s*=\s*["']?(submit|button|reset)\b/i.test(attrs);
      for (const a of attrs.matchAll(/([\w:@.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        const attr = a[1].toLowerCase();
        const value = a[2] ?? a[3] ?? a[4] ?? "";
        if ((ATTRS.has(attr) || (submit && attr === "value")) && !isAllowed(value)) {
          push(i + whole.indexOf(a[0]), `${attr}=`, value);
        }
      }
    }
    return cut(whole);
  });

  // 4. What is left is text a shopper reads.
  for (const t of s.matchAll(/[^\u0001]+/g)) {
    if (isAllowed(t[0])) continue;
    push(t.index + t[0].search(/\S/), "text", t[0]);
  }

  // A marker on the line, or the line above, lets one deliberate exception through.
  const lines = src.split("\n");
  return found
    .filter((f) => !MARKER.test(lines[f.line - 1] || "") && !MARKER.test(lines[f.line - 2] || ""))
    .sort((a, b) => a.line - b.line);
}

const keyOf = (f) => `${f.kind} ${f.text}`;
export function countKeys(findings) {
  const c = {};
  for (const f of findings) c[keyOf(f)] = (c[keyOf(f)] || 0) + 1;
  return c;
}

// The findings the build added: each string beyond as many as the original file had.
export function addedFindings(findings, baseCounts = {}) {
  const left = { ...baseCounts };
  return findings.filter((f) => {
    const k = keyOf(f);
    if (left[k] > 0) { left[k]--; return false; }
    return true;
  });
}

// Files a page builder, an app or the editor's block generator writes into the theme. Their text
// is edited in that app or the editor, not in code.
export const APP_FILE = /^(pf-|pagefly|gp-|gem-|gempages|shogun|locksmith|zepto|ecom-|layouthub|beae-|ai_gen_block_)/i;

export function themeFiles(root) {
  const out = [];
  for (const d of DIRS) {
    if (!existsSync(join(root, d))) continue;
    for (const f of readdirSync(join(root, d))) if (f.endsWith(".liquid") && !APP_FILE.test(f)) out.push(`${d}/${f}`);
  }
  return out.sort();
}

// Without GIT_* from the caller (a git hook sets GIT_DIR), so git reads the repo this theme is in.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (args, input) => execFileSync("git", args, { cwd: ROOT, input, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

// Each file's contents at a commit (null where the file did not exist), in one git call.
function readAt(ref, files) {
  const buf = git(["cat-file", "--batch"], files.map((f) => `${ref}:./${f}`).join("\n") + "\n");
  const out = {};
  let pos = 0;
  for (const f of files) {
    const nl = buf.indexOf(10, pos);
    const header = buf.slice(pos, nl).toString();
    pos = nl + 1;
    if (/ missing$/.test(header)) { out[f] = null; continue; }
    const size = Number(header.split(" ")[2]);
    out[f] = buf.slice(pos, pos + size).toString("utf8");
    pos += size + 1;
  }
  return out;
}

function baselineFrom(ref, files) {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
  const at = readAt(sha, files);
  const counts = {};
  for (const f of files) if (at[f] != null) counts[f] = countKeys(findHardCoded(at[f]));
  return { from: sha, files: counts };
}

function firstCommit() {
  const roots = git(["rev-list", "--max-parents=0", "HEAD"]).toString().trim().split("\n");
  return roots[roots.length - 1];
}

function main() {
  const args = process.argv.slice(2);
  const files = themeFiles(ROOT);
  if (!files.length) {
    console.log("  no-hard-coded-text: no sections/, snippets/ or blocks/ Liquid here, so nothing was checked");
    process.exit(1);
  }

  let base;
  try {
    if (args.includes("--write-baseline")) {
      const fromIdx = args.indexOf("--from");
      const ref = fromIdx >= 0 ? args[fromIdx + 1] : firstCommit();
      base = baselineFrom(ref, files);
      writeFileSync(BASE, JSON.stringify({ from: base.from, note: "Hard-coded text the theme had when it was first pulled. Written from that commit, never from the working copy.", files: base.files }, null, 2) + "\n");
      console.log(`  wrote ${BASE} from ${base.from.slice(0, 7)}. Commit it.`);
    } else if (existsSync(BASE)) {
      base = JSON.parse(readFileSync(BASE, "utf8"));
    } else {
      base = baselineFrom(firstCommit(), files);
    }
  } catch (e) {
    console.log(`  no-hard-coded-text: could not read the theme as first pulled (${String(e.stderr || e.message).trim().split("\n")[0]}), so nothing was checked`);
    process.exit(1);
  }

  const problems = [];
  for (const f of files) {
    const added = addedFindings(findHardCoded(readFileSync(join(ROOT, f), "utf8")), base.files[f]);
    for (const a of added) problems.push(`${f}:${a.line}: ${a.kind} "${a.text.length > 80 ? a.text.slice(0, 77) + "..." : a.text}"`);
  }
  if (!problems.length) return;
  for (const p of problems) console.log("  " + p);
  console.log(`  ${problems.length} hard-coded string${problems.length === 1 ? "" : "s"} a merchant cannot edit (compared with ${base.from.slice(0, 7)}, the theme as first pulled).`);
  console.log("  Move each into a section or block setting, a theme setting, or a locale key with | t (DEVOTE-KIT.md, \"Nothing Is Hard-Coded\").");
  console.log("  A deliberate exception gets {% # hard-coded-ok: <why> %} on its line. If these files came with the theme, see this guard's header.");
  process.exit(1);
}

// Compared through realpath: on a path that runs through a symlink (macOS's /var, a linked
// folder) a plain comparison is false, main never runs, and the guard passes without checking.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === invoked) main();
