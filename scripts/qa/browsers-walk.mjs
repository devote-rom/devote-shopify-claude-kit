// Walk: every page in the browsers customers use besides Chrome, compared with Chrome at the same
// size. WebKit (the engine Safari uses) at desktop 1440px, on an iPhone and on an iPad; Firefox at
// 1440px and 390px; and Chrome emulating an Android phone. For each one it runs the widths walk's
// checks (buttons that wrap, header clashes, text over text, text cut off, sideways scroll) and
// fails anything found there and not in Chrome, then compares where things sit: the header, the
// main menu, every h1 and h2, every button and every price, matched by order and text. A box that
// moved or changed size by more than the tolerance fails as "different in <engine> at <size>", and
// so does text that runs out of its box in one engine only. Pictures of both, with the differences
// marked in red, go to parity/browsers/.
//
// Exists because every other walk runs in headless Chrome only, and over a year a QA tester logged
// about 130 findings that only showed in Safari (desktop, iPhone, iPad), Firefox or at Android
// sizes: a layout broken in Safari, a sticky header misbehaving, flex gaps, fonts, buttons
// overflowing on an iPhone.
//
//   PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run browsers
//
// Pages: design/seo-pages.json, or BROWSERS_PAGES (a comma list). Rows: all of ENGINES, or
// BROWSERS_ENGINES (a comma list of row ids or engine names, e.g. "webkit" or "firefox-phone").
// One page and one browser at a time, with a pause between loads (BROWSERS_PAUSE_MS, default 3000),
// so a store is never hit by several browsers at once. design/widths.json is read as the widths
// walk reads it.
//
// Needs: puppeteer-core and chrome-launcher (as every walk), and playwright pinned at 1.64.0, whose
// WebKit is build 2370 (in ~/Library/Caches/ms-playwright on a Mac). Never `npx playwright install`:
// on macOS 27 it hangs unzipping, and its cleanup deletes other projects' browsers from the shared
// cache. Firefox is downloaded once into ~/.cache/devote-kit/browsers. Playwright's own Firefox
// will not start on macOS 27, so on a Mac it is started through Launch Services (`open`) with a
// fresh profile every run (no Shopify preview cookie carries over) and driven over WebDriver BiDi.
//
// A page that could not be loaded, a browser that would not start, and Shopify answering 429 (it
// limits a computer that asks too often; the walk waits BROWSERS_RETRY_MS, default 30000, and
// tries once more) are NOT CHECKED and exit 1: never a pass.
//
// Later: real Safari (safaridriver, after a one-off `safaridriver --enable` with an admin password)
// and the iOS Simulator (needs Xcode). Each is one entry in ENGINES and one opener in DRIVERS.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cookieHeader, onPasswordPage } from "./preview-session.mjs";
import { withPreview } from "./seo-walk.mjs";
import { imagesDone, pagesToCheck, settle } from "./visual-walk.mjs";
import { pageFindings, widthsConfig } from "./widths-walk.mjs";
import { isMain } from "../platform.mjs";
import { pacedGoto, pacedFetch } from "./pace.mjs";
import { pageList } from "./page-list.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "parity", "browsers");
export const FIREFOX_CACHE = join(homedir(), ".cache", "devote-kit", "browsers");
const MAX_SHOT = 12000; // css px of page height in a picture

// ------------------------------------------------------------------------------ the rows

// The screens, from Playwright's device list (1.64) so WebKit and the Chrome reference agree on
// the size. Chrome and Firefox take the size from here; WebKit takes the whole device from
// Playwright (user agent included) when it is there.
export const SCREENS = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false, touch: false },
  phone390: { width: 390, height: 844, dpr: 1, mobile: false, touch: false },
  "iPhone 15": { width: 393, height: 659, dpr: 3, mobile: true, touch: true },
  "iPad (gen 7)": { width: 810, height: 1080, dpr: 2, mobile: true, touch: true },
  "Pixel 7": {
    width: 412, height: 839, dpr: 2.625, mobile: true, touch: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36",
  },
};

// One entry per browser and size. engine names the opener in DRIVERS; device names a Playwright
// device (and a SCREENS entry). Adding real Safari or the iOS Simulator later is one entry each:
//   { id: "safari-desktop", engine: "safari", label: "Safari", size: "1440px", screen: "desktop" },
//   { id: "ios-simulator", engine: "ios-simulator", label: "Safari on the iOS Simulator", size: "iPhone 15", device: "iPhone 15", screen: "iPhone 15" },
export const ENGINES = [
  { id: "webkit-desktop", engine: "webkit", label: "WebKit (Safari's engine)", size: "1440px", screen: "desktop" },
  { id: "webkit-iphone", engine: "webkit", label: "WebKit (Safari's engine)", size: "iPhone 15", device: "iPhone 15", screen: "iPhone 15" },
  { id: "webkit-ipad", engine: "webkit", label: "WebKit (Safari's engine)", size: "iPad", device: "iPad (gen 7)", screen: "iPad (gen 7)" },
  { id: "firefox-desktop", engine: "firefox", label: "Firefox", size: "1440px", screen: "desktop" },
  { id: "firefox-phone", engine: "firefox", label: "Firefox", size: "390px", screen: "phone390" },
  { id: "android-pixel", engine: "chrome", label: "Chrome on Android", size: "Pixel 7", device: "Pixel 7", screen: "Pixel 7" },
];

/** The rows to run: all, or those BROWSERS_ENGINES names by id or engine. Unknown names throw. */
export function rowsToRun(list = "", engines = ENGINES) {
  const want = String(list || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!want.length) return engines;
  const unknown = want.filter((w) => !engines.some((e) => e.id === w || e.engine === w));
  if (unknown.length) throw new Error(`unknown browser row: ${unknown.join(", ")} (rows: ${engines.map((e) => e.id).join(", ")})`);
  return engines.filter((e) => want.includes(e.id) || want.includes(e.engine));
}

/**
 * What Chrome is set to for a row's reference: the same size, device scale, touch and phone mode,
 * with Chrome's own user agent. The same device scale matters: srcset hands a 3x iPhone a bigger
 * file than a 1x screen, and on one store a logo's rounded file size then read as squashed in
 * WebKit only. Rows of the same size share one reference load.
 */
export function referenceFor(row) {
  const s = SCREENS[row.screen];
  if (!s) throw new Error(`row ${row.id} has no screen`);
  const ref = { width: s.width, height: s.height, dpr: s.dpr, mobile: s.mobile, touch: s.touch };
  return { ...ref, key: `${ref.width}x${ref.height}@${ref.dpr}x${ref.mobile ? " phone" : ""}${ref.touch ? " touch" : ""}` };
}

/** "WebKit (Safari's engine) on iPhone 15", for every line the walk prints. */
export const where = (row) => `${row.label} at ${row.size}`;

// ------------------------------------------------------------------------------ pure rules

/**
 * Why a load cannot be compared, or null. Shopify answers 429 when it is limiting a computer that
 * asks too often: that is never the page, and never a pass.
 */
export function loadProblem({ status, url, error } = {}) {
  if (error) return error;
  if (status === 429) return "Shopify is limiting requests from this computer; wait and run again";
  if (status >= 400) return `the page gave ${status}`;
  if (url && onPasswordPage(url)) return "the store password page came back, not the page (set .storefront-password or STOREFRONT_PASSWORD)";
  return null;
}

/**
 * How far a box may move or change size before it counts. Fonts are drawn a little differently by
 * every engine, so a heading's line sits a pixel or two apart and a button set by its label is a
 * few pixels wider: that is not a finding. Tuned on the fixture and on real store homepages.
 */
export function tolerance(viewportWidth, { px = 8, share = 0.01 } = {}) {
  return Math.max(px, Math.round(share * viewportWidth));
}

/**
 * Boxes from Chrome (a) and the other engine (b), matched by kind and text, in page order: the
 * first "Add to cart" button in one with the first in the other. A box is { k, t, r: [x, y, w, h],
 * over }. Returns the pairs and what only one side has.
 */
export function matchBoxes(a, b) {
  const key = (x) => `${x.k}\u0000${x.t}`;
  const queues = new Map();
  for (const y of b) { if (!queues.has(key(y))) queues.set(key(y), []); queues.get(key(y)).push(y); }
  const pairs = [], onlyA = [];
  for (const x of a) { const q = queues.get(key(x)); if (q?.length) pairs.push([x, q.shift()]); else onlyA.push(x); }
  return { pairs, onlyA, onlyB: [...queues.values()].flat() };
}

/**
 * The pairs whose box moved or changed size by more than the tolerance. A box that moves takes
 * everything below it along (a taller picture above pushes the rest of the page down), so each
 * box's downward shift is measured against the box above it in Chrome: the nearest one above that
 * shares some of its width (the same column of a footer or a grid), else the nearest one above.
 * Only the first box of a shift is reported, as "everything below moves with it" when a box
 * measured against it shifts the same. Fonts are drawn a little taller or shorter by each engine,
 * so a page drifts a few pixels over a long stretch of text: the allowance grows by `drift` (0.6%)
 * of the distance to the box above. Sideways and size changes get the plain tolerance.
 */
export function differences(pairs, { tol = 8, drift = 0.006 } = {}) {
  const sorted = [...pairs].sort((p, q) => p[0].r[1] - q[0].r[1] || p[0].r[0] - q[0].r[0]);
  const dyOf = ([a, b]) => b.r[1] - a.r[1];
  const overlaps = (x, y) => Math.min(x.r[0] + x.r[2], y.r[0] + y.r[2]) - Math.max(x.r[0], y.r[0]) > 1;
  const refOf = sorted.map((p, i) => {
    let near = -1, column = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j][0].r[1] >= p[0].r[1] - 1) continue; // same row: not above
      if (near < 0) near = j;
      if (overlaps(sorted[j][0], p[0])) { column = j; break; }
    }
    return column >= 0 ? column : near;
  });
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    const r = refOf[i];
    const dx = b.r[0] - a.r[0], dw = b.r[2] - a.r[2], dh = b.r[3] - a.r[3];
    const rel = dyOf(sorted[i]) - (r >= 0 ? dyOf(sorted[r]) : 0);
    const allow = tol + (r >= 0 ? drift * (a.r[1] - sorted[r][0].r[1]) : 0);
    const down = Math.abs(rel) > allow;
    const moved = down || Math.abs(dx) > tol;
    const resized = Math.abs(dw) > tol || Math.abs(dh) > tol;
    if (!moved && !resized) continue;
    // carried along: a box measured against this one shifts the same
    const carries = down && sorted.some((q, k) => refOf[k] === i && Math.abs(dyOf(q) - dyOf(sorted[i])) <= tol);
    out.push({ a, b, dx, dy: down ? rel : 0, dw, dh, moved, resized, carries });
  }
  return out;
}

/** What kind of widths finding a line is, without the element it names: "text sits on a picture". */
export function findingKind(line) {
  return String(line).replace(/"[^"]*"/g, '"..."').replace(/:.*$/, "").replace(/\d+/g, "N").trim();
}

const KIND = { header: "the header", nav: "the main menu", h1: "h1", h2: "h2", button: "button", price: "price" };
const named = (x) => `${KIND[x.k] || x.k}${x.t ? ` "${x.t.slice(0, 40)}"` : ""}`;
const px = (n) => `${Math.abs(Math.round(n))}px`;

/** One plain line per difference. */
export function describe(d, engine) {
  const parts = [];
  if (Math.abs(d.dy) > 0 && d.moved) parts.push(`sits ${px(d.dy)} ${d.dy > 0 ? "lower" : "higher"}`);
  if (Math.abs(d.dx) > 0 && d.moved) parts.push(`${px(d.dx)} further ${d.dx > 0 ? "right" : "left"}`);
  if (d.resized) parts.push(`is ${Math.round(d.b.r[2])}x${Math.round(d.b.r[3])} (Chrome ${Math.round(d.a.r[2])}x${Math.round(d.a.r[3])})`);
  return `${named(d.a)} ${parts.filter(Boolean).join(", ")} in ${engine}${d.carries ? ", and everything below it moves with it" : ""}`;
}

/**
 * Everything that fails for one page and row, from both readings. A reading is
 * { vw, items: boxes, findings: widths walk lines }. Lines found by the widths checks in both
 * browsers are the widths walk's to report, not this one's.
 */
export function compareReadings(chrome, other, { engine, tol = tolerance(chrome.vw) } = {}) {
  const fails = [], info = [];
  if (Math.abs(chrome.vw - other.vw) > 1) info.push(`the page is ${other.vw}px wide inside ${engine}, ${chrome.vw}px in Chrome (a scroll bar takes room)`);
  const { pairs, onlyA, onlyB } = matchBoxes(chrome.items, other.items);
  const diffs = differences(pairs, { tol });
  for (const d of diffs) fails.push({ text: describe(d, engine), boxes: [d.a, d.b] });
  for (const [a, b] of pairs) if (b.over && !a.over) fails.push({ text: `${named(a)} runs out of its box in ${engine} only`, boxes: [a, b] });
  for (const a of onlyA) {
    const line = `${named(a)} is shown in Chrome but not in ${engine}`;
    if (a.k === "header" || a.k === "nav" || a.k === "h1") fails.push({ text: line, boxes: [a, null] }); else info.push(line);
  }
  for (const b of onlyB) info.push(`${named(b)} is shown in ${engine} but not in Chrome`);
  // A widths finding fails here only when Chrome has none of that kind on the page. When Chrome
  // has the same kind (on another card of a carousel that rotates on its own, say), the widths
  // walk already fails the page for it, and this one lists the engine's lines as information.
  const kinds = new Set(chrome.findings.map(findingKind));
  for (const f of other.findings) {
    if (!kinds.has(findingKind(f))) fails.push({ text: `${f} in ${engine} only`, boxes: [] });
    else info.push(`${f} in ${engine} (Chrome has this kind too, so npm run widths reports it)`);
  }
  return { fails: grouped(fails), info: [...new Set(info)], matched: pairs.length };
}

/** The same line for several boxes (four "Add to cart" buttons) becomes one line with a count. */
export function grouped(fails) {
  const m = new Map();
  for (const f of fails) {
    if (!m.has(f.text)) m.set(f.text, { text: f.text, boxes: [], n: 0 });
    const g = m.get(f.text); g.n++; g.all = [...(g.all || []), f.boxes];
  }
  return [...m.values()].map((g) => ({ text: g.n > 1 ? `${g.text} (${g.n} of them)` : g.text, boxes: g.all[0], all: g.all }));
}

export function slug(path) {
  return path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "home";
}

// ------------------------------------------------------------------------------ in the page

// Runs in the page: the box of the header, the main menu, every h1 and h2, every button and every
// price that a visitor sees, in page order. A box is { k, t, r: [x, y, w, h], over }: over is true
// when its text runs more than 2px past the box. Text is textContent, so CSS capitals do not
// change the match.
export function layoutBoxes() {
  const W = document.documentElement.clientWidth;
  const hdr = document.querySelector("#header-component") || document.querySelector("header") || document.querySelector("[data-header]");
  const shown = (e) => {
    if (!e.getClientRects().length) return false;
    for (let x = e; x && x !== document.documentElement; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
      if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) return false;
      // a fixed layer (a chat button, a cookie bar) is not the page, unless it is the header
      if (cs.position === "fixed" && !(hdr && (x === hdr || hdr.contains(x) || x.contains(hdr)))) return false;
    }
    const r = e.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || r.right <= 0 || r.left >= W) return false;
    // clipped away by a box that hides its overflow (a slide off to the side of a carousel)
    for (let x = e.parentElement; x && x !== document.documentElement; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (!/hidden|clip/.test(cs.overflowX + cs.overflowY)) continue;
      const c = x.getBoundingClientRect();
      if (/hidden|clip/.test(cs.overflowX) && (r.right <= c.left + 1 || r.left >= c.right - 1)) return false;
      if (/hidden|clip/.test(cs.overflowY) && (r.bottom <= c.top + 1 || r.top >= c.bottom - 1)) return false;
    }
    return true;
  };
  const text = (e) => (e.matches("input") ? e.value || "" : e.textContent.trim() || e.getAttribute("aria-label") || e.getAttribute("title") || "").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const overflows = (e) => {
    const r = e.getBoundingClientRect();
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const q of range.getClientRects()) { if (q.width < 1) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom); }
    }
    if (l === Infinity) return false;
    return l < r.left - 2 || rr > r.right + 2 || t < r.top - 2 || b > r.bottom + 2;
  };
  const found = [];
  const add = (k, e) => { if (e && shown(e)) found.push({ k, e }); };
  if (hdr) {
    add("header", hdr);
    const navs = [...hdr.querySelectorAll("nav")].filter(shown);
    add("nav", navs.sort((a, b) => b.querySelectorAll("a").length - a.querySelectorAll("a").length)[0]);
  }
  for (const h of document.querySelectorAll("h1, h2")) add(h.tagName.toLowerCase(), h);
  const buttons = [...document.querySelectorAll('button, input[type="submit"], .button, .button-secondary, :is(a, button)[class*="btn"], :is(a, button, [role="button"])[class*="button"]')];
  for (const b of buttons) if (!buttons.some((o) => o !== b && o.contains(b))) add("button", b);
  const prices = [...document.querySelectorAll('[class*="price"], .money')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /\d/.test(n.textContent)));
  for (const p of prices) if (!prices.some((o) => o !== p && o.contains(p))) add("price", p);
  const order = (a, b) => (a.e === b.e ? 0 : a.e.compareDocumentPosition(b.e) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const items = found.sort(order).map(({ k, e }) => {
    const r = e.getBoundingClientRect();
    return { k, t: k === "header" || k === "nav" ? "" : text(e), r: [r.left + scrollX, r.top + scrollY, r.width, r.height].map((v) => Math.round(v * 10) / 10), over: k === "header" || k === "nav" ? false : overflows(e) };
  });
  return { vw: W, dpr: devicePixelRatio, height: document.documentElement.scrollHeight, items };
}

// ------------------------------------------------------------------------------ the browsers

// Runs fn in the page with plain JSON arguments. Puppeteer (Chrome and Firefox) and Playwright
// (WebKit) take a function differently, so it goes over as source text, which both run the same.
const runner = (page) => (fn, ...args) => page.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);

function cookiesFor(url) {
  const raw = cookieHeader();
  if (!raw || !/^https?:/.test(String(url))) return [];
  const domain = new URL(url).hostname;
  return raw.split(/;\s*/).filter((p) => p.includes("=")).map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i), value: p.slice(i + 1), domain, path: "/", secure: url.startsWith("https") };
  });
}

// A puppeteer page (Chrome, or Firefox over BiDi) set to a screen.
async function puppeteerLoad(browser, url, s, { emulate = true } = {}) {
  const page = await browser.newPage();
  const close = () => page.close().catch(() => {});
  try {
    if (emulate) await page.emulate({ viewport: { width: s.width, height: s.height, deviceScaleFactor: s.dpr, isMobile: s.mobile, hasTouch: s.touch }, userAgent: s.ua || (await browser.userAgent()) });
    else await page.setViewport({ width: s.width, height: s.height });
    const cookies = cookiesFor(url);
    if (cookies.length) await page.setCookie(...cookies);
    const res = await pacedGoto(page, url, { waitUntil: "load", timeout: 90000 }).catch((e) => ({ error: e.message }));
    return {
      status: res?.status?.() ?? (res?.error ? 0 : 200), error: res?.error, url: page.url(),
      evaluate: runner(page),
      idle: () => page.waitForNetworkIdle({ idleTime: 700, timeout: 8000 }).catch(() => {}),
      shot: (h) => page.screenshot({ clip: { x: 0, y: 0, width: s.width, height: h }, captureBeyondViewport: true }),
      close,
    };
  } catch (e) { await close(); throw e; }
}

export const DRIVERS = {
  // Chrome: the reference for every row, and the Android row.
  async chrome() {
    const puppeteer = (await import("puppeteer-core")).default;
    const { Launcher } = await import("chrome-launcher");
    const exe = Launcher.getInstallations()[0];
    if (!exe) throw new Error("no Chrome found on this machine");
    const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 120000 });
    return {
      load: (url, s) => puppeteerLoad(browser, url, s),
      close: () => browser.close().catch(() => {}),
    };
  },

  async webkit() {
    let pw;
    try { pw = await import("playwright"); } catch { throw new Error("run npm i -D playwright@1.64.0"); }
    const webkit = pw.webkit || pw.default?.webkit;
    const devices = pw.devices || pw.default?.devices || {};
    if (!existsSync(webkit.executablePath())) {
      throw new Error(`Playwright's WebKit is not on this computer (${webkit.executablePath()}). Pin playwright to the version whose browsers.json names the WebKit build that is in ~/Library/Caches/ms-playwright; never npx playwright install`);
    }
    const browser = await webkit.launch();
    return {
      async load(url, s, row) {
        const device = row?.device && devices[row.device];
        const ctx = await browser.newContext(device ? { ...device } : { viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dpr, isMobile: s.mobile, hasTouch: s.touch });
        const cookies = cookiesFor(url).map(({ domain, ...c }) => ({ ...c, url: new URL(url).origin }));
        if (cookies.length) await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        const res = await pacedGoto(page, url, { waitUntil: "load", timeout: 90000 }).catch((e) => ({ error: e.message }));
        return {
          status: res?.status?.() ?? (res?.error ? 0 : 200), error: res?.error, url: page.url(),
          evaluate: runner(page),
          idle: () => page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}),
          shot: (h) => page.screenshot({ clip: { x: 0, y: 0, width: page.viewportSize().width, height: h }, fullPage: true, scale: "css" }),
          close: () => ctx.close().catch(() => {}),
        };
      },
      close: () => browser.close().catch(() => {}),
    };
  },

  async firefox() {
    const puppeteer = (await import("puppeteer-core")).default;
    const exe = await firefoxExecutable();
    if (process.platform !== "darwin") {
      const browser = await puppeteer.launch({ browser: "firefox", executablePath: exe, headless: true, protocolTimeout: 120000, extraPrefsFirefox: Object.fromEntries(FIREFOX_PREFS) });
      return { load: (url, s) => puppeteerLoad(browser, url, s, { emulate: false }), close: () => browser.close().catch(() => {}) };
    }
    // macOS 27: Firefox started from a shell cannot find its profile, so Launch Services starts it
    const app = exe.replace(/\/Contents\/MacOS\/firefox$/, "");
    const profile = mkdtempSync(join(tmpdir(), "devote-kit-firefox-"));
    writeFileSync(join(profile, "user.js"), FIREFOX_PREFS.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n");
    const port = await freePort();
    execFileSync("open", ["-n", "-a", app, "--args", "-no-remote", "-headless", "-profile", profile, "--remote-debugging-port", String(port), "--remote-allow-hosts", "localhost,127.0.0.1", "about:blank"]);
    let browser, last;
    for (let i = 0; i < 60 && !browser; i++) {
      try { browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/session`, protocol: "webDriverBiDi", protocolTimeout: 120000 }); }
      catch (e) { last = e; await new Promise((r) => setTimeout(r, 500)); }
    }
    const cleanup = () => { killPort(port); rmSync(profile, { recursive: true, force: true }); };
    if (!browser) { cleanup(); throw new Error(`Firefox did not start (${last?.message || "no answer on its port"})`); }
    return {
      load: (url, s) => puppeteerLoad(browser, url, s, { emulate: false }),
      async close() { await browser.close().catch(() => {}); await new Promise((r) => setTimeout(r, 800)); cleanup(); },
    };
  },
};

const FIREFOX_PREFS = [
  ["remote.active-protocols", 1],
  // scroll bars over the page, as on a Mac with a trackpad and in headless Chrome: a classic 15px
  // bar narrows the page and moves every box
  ["ui.useOverlayScrollbars", 1],
  ["browser.shell.checkDefaultBrowser", false],
  ["browser.aboutwelcome.enabled", false],
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["toolkit.telemetry.reportingpolicy.firstRun", false],
  ["browser.startup.homepage_override.mstone", "ignore"],
];

// Firefox from ~/.cache/devote-kit/browsers, downloaded there the first time.
async function firefoxExecutable() {
  const B = await import("@puppeteer/browsers");
  const have = (await B.getInstalledBrowsers({ cacheDir: FIREFOX_CACHE })).filter((b) => b.browser === "firefox" && existsSync(b.executablePath));
  if (have.length) return have.sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))[0].executablePath;
  mkdirSync(FIREFOX_CACHE, { recursive: true });
  console.log(`Firefox is not in ${FIREFOX_CACHE} yet: downloading it once (about 100 MB).`);
  const platform = B.detectBrowserPlatform();
  const buildId = await B.resolveBuildId(B.Browser.FIREFOX, platform, "stable");
  return (await B.install({ browser: B.Browser.FIREFOX, buildId, cacheDir: FIREFOX_CACHE })).executablePath;
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

// Whatever still listens on the port (Firefox started through `open` is not our child process).
function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(+pid, "SIGTERM"); } catch {} }
  } catch {}
}

// ------------------------------------------------------------------------------ the walk

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Loads one page in one browser and reads it: the boxes first, then a picture, then the widths
// checks (which open hidden form steps, so they come last).
async function read(driver, url, s, row, cfg) {
  let p = await driver.load(url, s, row);
  // Shopify answers 429 for a while after a computer asks too often, and a connection drops now and
  // then: back off once, then give up
  if (p.status === 429 || (p.error && /net::|NS_ERROR|timeout/i.test(p.error))) {
    await p.close();
    await pause(+(process.env.BROWSERS_RETRY_MS ?? 30000));
    p = await driver.load(url, s, row);
  }
  try {
    const problem = loadProblem(p);
    if (problem) return { error: problem };
    await p.evaluate(settle, [], "");
    await p.idle();
    await p.evaluate(imagesDone);
    const boxes = await p.evaluate(layoutBoxes);
    const shot = await p.shot(Math.min(MAX_SHOT, boxes.height)).catch(() => null);
    const findings = await pageFindings(p.evaluate, cfg);
    return { ...boxes, findings, shot };
  } finally { await p.close(); }
}

// The two pictures with each failing box outlined in red, when pngjs is there; plain otherwise.
async function savePictures(name, row, chrome, other, fails) {
  mkdirSync(OUT, { recursive: true });
  let PNG = null;
  try { ({ PNG } = await import("pngjs")); } catch {}
  const files = [];
  for (const [side, reading, idx] of [["chrome", chrome, 0], [row.engine, other, 1]]) {
    if (!reading.shot) continue;
    const file = join(OUT, `${name}@${row.id}-${side}.png`);
    let buf = Buffer.from(reading.shot);
    if (PNG) {
      try {
        const img = PNG.sync.read(buf);
        const k = img.width / reading.vw;
        for (const f of fails) for (const boxes of f.all || [f.boxes]) {
          const b = boxes[idx];
          if (!b) continue;
          const [x, y, w, h] = b.r.map((v) => Math.round(v * k));
          for (let t = 0; t < 3; t++) outline(img, x - t, y - t, w + 2 * t, h + 2 * t);
        }
        buf = PNG.sync.write(img);
      } catch {}
    }
    writeFileSync(file, buf);
    files.push(file.slice(ROOT.length + 1));
  }
  return files;
}

function outline(img, x, y, w, h) {
  const set = (px, py) => {
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return;
    const i = (py * img.width + px) * 4;
    img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
  };
  for (let i = x; i <= x + w; i++) { set(i, y); set(i, y + h); }
  for (let j = y; j <= y + h; j++) { set(x, j); set(x + w, j); }
}

function reportMd(results, { preview, at = new Date().toISOString() }) {
  const out = ["# Browsers", "", `Preview: ${preview}`, `Run: ${at}`, ""];
  for (const r of results) {
    out.push(`## ${r.page} in ${r.where}`, "");
    if (r.error) { out.push(`NOT CHECKED: ${r.error}`, ""); continue; }
    if (!r.fails.length) out.push(`Same as Chrome (${r.matched} boxes compared).`, "");
    if (r.fails.length) out.push("### Different From Chrome (Fails)", "", ...r.fails.map((f) => `- ${f.text}`), "");
    if (r.pictures?.length) out.push(`Pictures: ${r.pictures.join(", ")}`, "");
    if (r.info.length) out.push("### Information (Not Failed)", "", ...r.info.map((t) => `- ${t}`), "");
  }
  return out.join("\n");
}

async function main() {
  const RAW = process.env.PREVIEW_URL || process.argv.find((a) => a.startsWith("http"));
  if (!RAW) { console.log("Nothing checked. Give it the preview URL:\n  PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run browsers"); process.exit(1); }
  try { await import("puppeteer-core"); await import("chrome-launcher"); }
  catch { console.log("NOT CHECKED: run npm i -D puppeteer-core chrome-launcher playwright@1.64.0"); process.exit(1); }
  let rows;
  try { rows = rowsToRun(process.env.BROWSERS_ENGINES); } catch (e) { console.log(e.message); process.exit(1); }
  const base = new URL(RAW);
  const cfg = widthsConfig();
  const gap = +(process.env.BROWSERS_PAUSE_MS ?? 3000);
  // one page per type only, to keep the number of loads down (scripts/qa/pace.mjs)
  const pages = pageList("BROWSERS_PAGES", { states: false });
  const results = [];
  let chrome;
  try { chrome = await DRIVERS.chrome(); }
  catch (e) { console.log(`NOT CHECKED: Chrome, the reference, did not start: ${e.message}`); process.exit(1); }
  // one engine at a time: every page in it, then the next engine, so only two browsers are ever open
  const engines = [...new Set(rows.map((r) => r.engine))];
  const refs = new Map(); // page + reference size: Chrome's reading, shared by rows of the same size
  try {
    for (const engine of engines) {
      const mine = rows.filter((r) => r.engine === engine);
      let driver = engine === "chrome" ? chrome : null, startError = null;
      if (!driver) {
        try { driver = await DRIVERS[engine](); } catch (e) { startError = e.message; }
      }
      try {
        for (const path of pages) {
          for (const row of mine) {
            const at = where(row);
            if (/FILL-IN/.test(path)) { results.push({ page: path, where: at, error: "fill in a real URL in design/seo-pages.json" }); console.log(`NOT CHECKED ${path} in ${at}: fill in a real URL in design/seo-pages.json`); continue; }
            if (startError) { results.push({ page: path, where: at, error: `${row.label} did not start: ${startError}` }); console.log(`NOT CHECKED ${path} in ${at}: ${row.label} did not start: ${startError}`); continue; }
            const url = withPreview(path, base);
            const ref = referenceFor(row);
            const refKey = `${path} ${ref.key}`;
            try {
              if (!refs.has(refKey)) { refs.set(refKey, await read(chrome, url, ref, null, cfg)); await pause(gap); }
              const a = refs.get(refKey);
              if (a.error) throw new Error(a.error === loadProblem({ status: 429 }) ? a.error : `Chrome: ${a.error}`);
              const b = await read(driver, url, SCREENS[row.screen], row, cfg);
              await pause(gap);
              if (b.error) throw new Error(b.error);
              const r = { page: path, where: at, ...compareReadings(a, b, { engine: row.label }) };
              if (r.fails.length) r.pictures = await savePictures(slug(path), row, a, b, r.fails);
              // BROWSERS_DEBUG=1 keeps both readings, to tune the tolerance or the matching
              if (process.env.BROWSERS_DEBUG) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, `${slug(path)}@${row.id}.json`), JSON.stringify({ chrome: { ...a, shot: undefined }, other: { ...b, shot: undefined } }, null, 1)); }
              results.push(r);
              console.log(r.fails.length
                ? `FAIL ${path} in ${at}: different in ${row.label} at ${row.size}\n${r.fails.slice(0, 6).map((f) => `     ${f.text}`).join("\n")}${r.fails.length > 6 ? `\n     ...and ${r.fails.length - 6} more in the report` : ""}${r.pictures?.length ? `\n     look: ${r.pictures.join(" beside ")} (red = different)` : ""}`
                : `ok   ${path} in ${at} (${r.matched} boxes the same as Chrome)`);
            } catch (e) {
              results.push({ page: path, where: at, error: e.message });
              console.log(`NOT CHECKED ${path} in ${at}: ${e.message}`);
            }
          }
        }
      } finally { if (driver && driver !== chrome) await driver.close(); }
    }
  } finally { await chrome.close(); }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.md"), reportMd(results, { preview: RAW }) + "\n");
  const fails = results.filter((r) => r.fails?.length).length, unchecked = results.filter((r) => r.error).length;
  console.log(`\n${fails} FAIL, ${unchecked} not checked, ${results.length - fails - unchecked} the same as Chrome. Full report: parity/browsers/report.md`);
  process.exit(fails || unchecked ? 1 : 0);
}

if (isMain(import.meta.url)) main();
