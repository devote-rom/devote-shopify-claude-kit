// Walk: every page on the preview beside the same page on the live site, at 390px and 1440px.
// For each it reads the text of every Shopify section (header and footer too), the order of the
// sections, and the font, size, weight, colour, letter spacing, case and line height of each kind
// of text (h1 to h6, paragraphs, buttons, prices, header menu links). Anything on live that is
// different or gone on the preview fails, unless design/live-compare.json says it was meant.
//
// Exists because a QA tester's most common finding over a year (about 1,000 of 1,789) was
// "differs from live" or "doesn't match the design": text gone, a section gone, a heading or button
// font, size, weight or colour changed, prices styled differently. The visual walk only compares a
// build with its own earlier screenshots, so the first build of a theme was never compared with
// anything.
//
//   PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' LIVE_URL='https://<domain>/' npm run live
//
// Pages: design/seo-pages.json, or LIVE_PAGES. Widths: 390 and 1440.
// Live is loaded twice. Anything that differs between those two loads (a rotating announcement, a
// review count, a stock count, a timer) is dynamic: it is left out of the comparison and listed
// in the report as dynamic, so a real difference is never hidden among them.
// design/live-compare.json:
//   "expected": [{ "page": "/", "kind": "text|section|style", "match": "...", "why": "the brief asked for it" }]
//        page is a path, a path ending in * (a prefix), or "*" for every page; "width" is optional.
//        match is a piece of the text, part of a section's type, or a style role ("h2") or a role
//        and property ("h2 font-size"). A matching difference is listed as expected, not failed.
//   "ignore": ["selector"]   hidden on both sites before reading (rotators, live widgets that a
//                            second load of live did not happen to change)
//   "skip": ["/search"]      pages left out, with the reason in the brand's notes
// LIVE_COMPARE_TRY_CSS='<css>' adds CSS to the preview only, to prove the walk catches a change
// (plant it, watch it fail, take it away) without deploying a broken theme.
// The full report goes to parity/live-compare/report.md. A page that could not be loaded is NOT
// CHECKED and exits 1: it is never a pass.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCookies, onPasswordPage } from "./preview-session.mjs";
import { withPreview } from "./seo-walk.mjs";
import { imagesDone, pagesToCheck, settle } from "./visual-walk.mjs";
import { isMain } from "../platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WIDTHS = [390, 1440];
const OUT = join(ROOT, "parity", "live-compare");
export const PROPS = ["font-family", "font-size", "font-weight", "color", "letter-spacing", "text-transform", "line-height"];

// ------------------------------------------------------------------------------ pure functions

/** Text as compared: spaces of every kind made one space, invisible characters dropped, case kept. */
export function norm(s) {
  return String(s ?? "").replace(/[​-‍﻿]/g, "").replace(/[\s ]+/g, " ").trim();
}

/** A section's text as lines, each normalised; lines under two characters are noise. */
export function chunks(raw) {
  return String(raw ?? "").split(/\n+/).map(norm).filter((l) => l.length >= 2);
}

/**
 * The section's type from its id: shopify-section-template--123__image_banner_AbC123 is
 * image_banner. Shopify adds a six-character instance suffix to new section keys; an older random
 * key (1650000000a1b2c3) says nothing, so the class that names the section (hint) is used.
 */
export function sectionType(id, hint = "") {
  let key = String(id).replace(/^shopify-section-/, "").replace(/^(template|sections)--\d+__/, "");
  key = key.replace(/_([A-Za-z0-9]{6})$/, (m, s) => (/\d/.test(s) || /[A-Z]/.test(s) ? "" : m));
  if (!key || /^\d/.test(key) || /^[a-f0-9-]{10,}$/i.test(key)) key = hint || "section";
  return key;
}

/** The most common value, so one odd element does not decide it. Ties go to the first seen. */
export function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

/** Raw page reading (sections with innerText, style samples per role) to what is compared. */
export function summarise(raw) {
  const sections = (raw.sections || []).map((s) => ({ type: s.type, chunks: chunks(s.text) }));
  const styles = {};
  for (const [role, samples] of Object.entries(raw.styles || {})) {
    if (!samples.length) continue;
    styles[role] = { n: samples.length, props: Object.fromEntries(PROPS.map((p) => [p, mode(samples.map((x) => x[p]))])) };
  }
  return { sections, styles };
}

const flat = (sum) => " " + sum.sections.flatMap((s) => s.chunks).join(" ") + " ";
const counts = (sum) => sum.sections.reduce((m, s) => m.set(s.type, (m.get(s.type) || 0) + 1), new Map());

/** Two px values within half a pixel are the same (sub-pixel rounding); anything else must match. */
export function sameValue(a, b) {
  const pa = /^(-?[\d.]+)px$/.exec(a ?? ""), pb = /^(-?[\d.]+)px$/.exec(b ?? "");
  if (pa && pb) return Math.abs(+pa[1] - +pb[1]) <= 0.5;
  return a === b;
}

/** What changed between two loads of the same live page: text, section types and style roles. */
export function dynamicParts(a, b) {
  const text = new Set(), sections = new Set(), styles = new Set();
  const fa = flat(a), fb = flat(b);
  for (const s of a.sections) for (const c of s.chunks) if (!fb.includes(c)) text.add(c);
  for (const s of b.sections) for (const c of s.chunks) if (!fa.includes(c)) text.add(c);
  const ca = counts(a), cb = counts(b);
  for (const t of new Set([...ca.keys(), ...cb.keys()])) if (ca.get(t) !== cb.get(t)) sections.add(t);
  for (const role of new Set([...Object.keys(a.styles), ...Object.keys(b.styles)])) {
    for (const p of PROPS) if (!sameValue(a.styles[role]?.props[p], b.styles[role]?.props[p])) styles.add(`${role} ${p}`);
  }
  return { text, sections, styles };
}

/** The entry in design/live-compare.json that says this difference was meant, or undefined. */
export function expectedFor(list, { page, width, kind, subject }) {
  return (list || []).find((e) => {
    if (e.kind !== kind) return false;
    if (e.width && +e.width !== width) return false;
    const p = e.page ?? "*";
    if (p !== "*" && p !== page && !(p.endsWith("*") && page.startsWith(p.slice(0, -1)))) return false;
    if (kind === "style") return subject === e.match || subject.startsWith(e.match + " ");
    return subject.includes(e.match);
  });
}

// The order two lists share: the items both have (as many as the shorter has), in each list's order.
function shared(list, other) {
  const left = new Map();
  for (const t of other) left.set(t, (left.get(t) || 0) + 1);
  return list.filter((t) => { const n = left.get(t) || 0; if (!n) return false; left.set(t, n - 1); return true; });
}

/**
 * Live (loaded twice) against the preview. Returns
 *   fails:    differences nobody said were meant
 *   expected: differences design/live-compare.json lists, with its reason
 *   info:     new on the preview (shown, never failed)
 *   dynamic:  what differed between the two live loads, so was left out
 */
export function compare(liveA, liveB, preview, { expected = [], page = "/", width = 0 } = {}) {
  const dyn = dynamicParts(liveA, liveB);
  const fails = [], ok = [], info = [];
  const add = (kind, subject, text) => {
    const e = expectedFor(expected, { page, width, kind, subject });
    if (e) ok.push({ kind, subject, text, why: e.why || "" }); else fails.push({ kind, subject, text });
  };

  // text: every line on live must be somewhere on the preview (any section, any line breaks). The
  // lines of a section that is gone altogether are counted under that section, not one by one.
  const fp = flat(preview), fl = flat(liveA) + flat(liveB);
  const cl = counts(liveA), cp = counts(preview);
  const goneText = new Map();
  const seen = new Set();
  for (const s of liveA.sections) for (const c of s.chunks) {
    if (dyn.text.has(c) || seen.has(c)) continue;
    seen.add(c);
    if (fp.includes(c)) continue;
    if (!cp.has(s.type) && !dyn.sections.has(s.type)) { goneText.set(s.type, (goneText.get(s.type) || 0) + 1); continue; }
    add("text", c, `text on live is missing on the preview (live section ${s.type}): "${c}"`);
  }
  const seenNew = new Set();
  for (const s of preview.sections) for (const c of s.chunks) {
    if (seenNew.has(c) || fl.includes(c)) continue;
    seenNew.add(c);
    info.push(`new text on the preview (section ${s.type}): "${c}"`);
  }

  // sections: none gone, same order for the ones both have
  for (const [t, n] of cl) {
    if (dyn.sections.has(t)) continue;
    const m = cp.get(t) || 0;
    const lines = goneText.get(t) ? `, and with it ${goneText.get(t)} line${goneText.get(t) === 1 ? "" : "s"} of text` : "";
    if (m < n) add("section", t, m === 0 ? `section gone on the preview: ${t}${lines}` : `section ${t}: live has ${n}, the preview ${m}`);
  }
  for (const [t, m] of cp) if (!cl.has(t) && !dyn.sections.has(t)) info.push(`new section on the preview: ${t}${m > 1 ? ` (${m})` : ""}`);
  const lo = shared(liveA.sections.map((s) => s.type).filter((t) => !dyn.sections.has(t)), preview.sections.map((s) => s.type));
  const po = shared(preview.sections.map((s) => s.type).filter((t) => !dyn.sections.has(t)), lo);
  if (lo.join("|") !== po.join("|")) add("section", "order", `sections in a different order. Live: ${lo.join(", ")}. Preview: ${po.join(", ")}`);

  // styles: the most common value of each property, per kind of text
  for (const [role, l] of Object.entries(liveA.styles)) {
    const p = preview.styles[role];
    if (!p) { info.push(`${role}: ${l.n} on live, none on the preview`); continue; }
    for (const prop of PROPS) {
      const subject = `${role} ${prop}`;
      if (dyn.styles.has(subject) || sameValue(l.props[prop], p.props[prop])) continue;
      add("style", subject, `${role} ${prop}: live ${l.props[prop]}, preview ${p.props[prop]}`);
    }
  }

  const dynamic = [...[...dyn.text].map((t) => `text: "${t}"`), ...[...dyn.sections].map((t) => `section: ${t}`), ...[...dyn.styles].map((t) => `style: ${t}`)];
  return { fails, expected: ok, info, dynamic, sections: { live: liveA.sections.map((s) => s.type), preview: preview.sections.map((s) => s.type) } };
}

/** The markdown report, one heading per page and width. */
export function report(results, { live, preview, at = new Date().toISOString() } = {}) {
  const out = [`# Live Compare`, "", `Live: ${live}`, `Preview: ${preview}`, `Run: ${at}`, ""];
  const failing = results.filter((r) => r.fails?.length).length, unchecked = results.filter((r) => r.error).length;
  out.push(`${failing} of ${results.length} page widths differ from live, ${unchecked} not checked.`, "");
  for (const r of results) {
    out.push(`## ${r.page} at ${r.width}px`, "");
    if (r.error) { out.push(`NOT CHECKED: ${r.error}`, ""); continue; }
    const list = (title, items) => { if (items.length) out.push(`### ${title}`, "", ...items.map((t) => `- ${t}`), ""); };
    if (!r.fails.length) out.push("Same as live.", "");
    list("Differs From Live (Fails)", r.fails.map((f) => f.text));
    list("Expected (design/live-compare.json)", r.expected.map((f) => `${f.text}${f.why ? `. Why: ${f.why}` : ""}`));
    list("Information (Not Failed)", r.info);
    list("Changed Between Two Loads Of Live (Left Out As Dynamic)", r.dynamic);
    if (r.sections) out.push(`Sections on live: ${r.sections.live.join(", ") || "none"}`, "", `Sections on the preview: ${r.sections.preview.join(", ") || "none"}`, "");
  }
  return out.join("\n");
}

// ----------------------------------------------------------------------------------- the walk

// Runs in the page: what each kind of text looks like, then the text of every section. Text is
// read with text-transform switched off, so a heading made capitals by CSS reads as a style
// difference, not as different words.
function readPage() {
  const seen = (e) => {
    if (!e || !e.getClientRects().length) return false;
    const cs = getComputedStyle(e);
    if (cs.visibility !== "visible" || cs.display === "none") return false;
    if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) return false;
    for (let x = e; x; x = x.parentElement) if (+getComputedStyle(x).opacity === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  // the element that draws the first piece of visible text inside e
  const drawn = (e) => {
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() && seen(n.parentElement)) return n.parentElement;
    return null;
  };
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && /\d/.test(n.textContent));
  const hdr = document.querySelector("#header-component") || document.querySelector("header") || document.querySelector("[data-header]") || document.querySelector('[id^="shopify-section-"][id*="header"]');
  const roles = {};
  for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) roles[h] = [...document.querySelectorAll(h)];
  roles.paragraph = [...document.querySelectorAll("main p")];
  roles.button = [...document.querySelectorAll('button, a.button, :is(a, button, input, [role="button"])[class*="button"], input[type="submit"]')];
  roles.price = [...document.querySelectorAll('[class*="price"], .money')].filter(ownText);
  roles["header menu link"] = hdr ? [...hdr.querySelectorAll("nav a")] : [];
  const styles = {};
  for (const [role, els] of Object.entries(roles)) {
    styles[role] = [];
    for (const e of [...new Set(els)].slice(0, 300)) {
      const t = e.matches("input") ? (seen(e) ? e : null) : drawn(e);
      if (!t) continue;
      const cs = getComputedStyle(t);
      styles[role].push({
        "font-family": cs.fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase(),
        "font-size": cs.fontSize, "font-weight": cs.fontWeight, color: cs.color,
        "letter-spacing": cs.letterSpacing, "text-transform": cs.textTransform, "line-height": cs.lineHeight,
      });
    }
  }
  const st = document.createElement("style");
  st.textContent = "*, *::before, *::after { text-transform: none !important; }";
  document.head.appendChild(st);
  let all = [...document.querySelectorAll('[id^="shopify-section-"]')].filter((s) => !s.parentElement.closest('[id^="shopify-section-"]'));
  const sections = all.filter((s) => s.getClientRects().length && s.getBoundingClientRect().height > 0 && getComputedStyle(s).visibility !== "hidden").map((s) => {
    // the class that names the section: on the section itself, else on its first child
    const named = (e) => e && [...e.classList].find((c) => !/^(shopify-section|section$|page-width|color-|gradient|isolate|full-width|spacing)/.test(c));
    const hint = named(s) || named(s.firstElementChild) || s.firstElementChild?.tagName.toLowerCase() || "";
    return { id: s.id, hint, text: s.innerText };
  });
  // a site not on Shopify (the old site before launch) has no sections: the page is one
  if (!all.length) sections.push({ id: "(page)", hint: "page", text: document.body.innerText });
  st.remove();
  return { sections, styles };
}

function config() {
  const file = join(ROOT, "design", "live-compare.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

async function load(browser, url, { cookies, masks, tryCss, width }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    // a later page of a list (infinite scroll) is never fetched, so both sites show the first page
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (["xhr", "fetch"].includes(r.resourceType()) && +u.searchParams.get("page") > 1) r.abort(); else r.continue();
    });
    if (cookies) await applyCookies(page, url);
    const res = await page.goto(url, { waitUntil: "load", timeout: 90000 }).catch((e) => ({ error: e.message }));
    if (res?.error || (res?.status && res.status() >= 400)) throw new Error(`${url} gave ${res.error || res.status()}`);
    if (onPasswordPage(page.url())) throw new Error(`${url}: the store password page came back, not the page (set .storefront-password or STOREFRONT_PASSWORD)`);
    await page.mouse.move(-10, -10).catch(() => {});
    await page.evaluate(settle, masks, tryCss || "");
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => {});
    await page.evaluate(imagesDone);
    const raw = await page.evaluate(readPage);
    raw.sections = raw.sections.map((s) => ({ type: sectionType(s.id, s.hint), text: s.text }));
    return summarise(raw);
  } finally { await page.close().catch(() => {}); }
}

async function main() {
  const PREVIEW = process.env.PREVIEW_URL, LIVE = process.env.LIVE_URL;
  if (!PREVIEW || !LIVE) {
    console.log("Nothing checked. Give it the preview and the live URL:\n  PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' LIVE_URL='https://<domain>/' npm run live");
    process.exit(1);
  }
  let puppeteer, Launcher;
  try {
    puppeteer = (await import("puppeteer-core")).default;
    ({ Launcher } = await import("chrome-launcher"));
  } catch { console.log("NOT CHECKED: run npm i -D puppeteer-core chrome-launcher"); process.exit(1); }
  const chrome = Launcher.getInstallations()[0];
  if (!chrome) { console.log("NOT CHECKED: no Chrome found on this machine."); process.exit(1); }
  const pb = new URL(PREVIEW), lb = new URL(LIVE);
  const cfg = config();
  const masks = cfg.ignore || [];
  const tryCss = process.env.LIVE_COMPARE_TRY_CSS || "";
  if (tryCss) console.log(`LIVE_COMPARE_TRY_CSS is set: the preview has extra CSS, so this run is a test of the walk, never a pass for the build`);
  const skip = cfg.skip || [];
  if (skip.length) console.log(`left out by design/live-compare.json: ${skip.join(", ")}`);
  const jobs = pagesToCheck("LIVE_PAGES").filter((p) => !skip.some((k) => p.startsWith(k))).flatMap((page) => WIDTHS.map((width) => ({ page, width })));
  // three browsers with one tab each (live, preview, live again): headless Chrome renders only the
  // front tab, so scroll-triggered loading never runs in a second tab of the same browser
  const browsers = await Promise.all([0, 1, 2].map(() => puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 120000 })));
  const results = [];
  try {
    for (const { page, width } of jobs) {
      if (/FILL-IN/.test(page)) { results.push({ page, width, error: "fill in a real URL in design/seo-pages.json" }); console.log(`NOT CHECKED ${page} at ${width}px: fill in a real URL in design/seo-pages.json`); continue; }
      try {
        // live and the preview together, then live again: the second load comes after the
        // preview's, so a clock, a timer or a rotation that moved while the preview loaded has
        // moved between the two live loads as well, and is caught as dynamic
        const [a, p] = await Promise.all([
          load(browsers[0], withPreview(page, lb), { masks, width }),
          load(browsers[2], withPreview(page, pb), { masks, width, tryCss, cookies: true }),
        ]);
        const b = await load(browsers[1], withPreview(page, lb), { masks, width });
        const r = { page, width, ...compare(a, b, p, { expected: cfg.expected, page, width }) };
        results.push(r);
        const kinds = ["text", "section", "style"].map((k) => [k, r.fails.filter((f) => f.kind === k).length]).filter(([, n]) => n);
        console.log(r.fails.length
          ? `FAIL ${page} at ${width}px: ${kinds.map(([k, n]) => `${n} ${k}`).join(", ")}\n${r.fails.slice(0, 4).map((f) => `     ${f.text.slice(0, 140)}`).join("\n")}${r.fails.length > 4 ? `\n     ...and ${r.fails.length - 4} more in the report` : ""}`
          : `ok   ${page} at ${width}px${r.dynamic.length ? ` (${r.dynamic.length} dynamic, left out)` : ""}`);
      } catch (e) {
        results.push({ page, width, error: e.message });
        console.log(`NOT CHECKED ${page} at ${width}px: ${e.message}`);
      }
    }
  } finally { await Promise.all(browsers.map((b) => b.close())); }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.md"), report(results, { live: LIVE, preview: PREVIEW }) + "\n");
  const fails = results.filter((r) => r.fails?.length).length, unchecked = results.filter((r) => r.error).length;
  console.log(`\n${fails} FAIL, ${unchecked} not checked, ${results.length - fails - unchecked} same as live. Full report: parity/live-compare/report.md`);
  process.exit(fails || unchecked ? 1 : 0);
}

if (isMain(import.meta.url)) main();
