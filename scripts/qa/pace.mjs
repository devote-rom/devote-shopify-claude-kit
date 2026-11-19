// Pace: every walk loads store pages through here, so a deploy never hammers a store.
//
// Exists because on 19 Nov 2026 a day of walk runs got this computer limited by Shopify on several
// client stores for hours: HTTP 429 on product, collection and search pages, then Shopify's bot
// check ("Just a moment"). One full run of the journeys walk alone loads about 100 pages. While a
// store limits an address, everyone at that address (the whole office) gets the same pages.
//
//   - page loads and fetches to one host are spaced at least WALK_PACE_MS apart (1500 by default)
//   - the first 429 or bot check writes parity/.shopify-throttled; from then on every walk stops
//     loading that store's pages and reports NOT CHECKED, and deploy runs no more walks. It clears
//     itself after 30 minutes.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const THROTTLE_FILE = join(ROOT, "parity", ".shopify-throttled");
export const THROTTLE_MINUTES = 30;
export const THROTTLED_MESSAGE = "Shopify is limiting requests from this computer; wait 30 minutes and run again";
const GAP = () => Number(process.env.WALK_PACE_MS ?? 1500);
const next = new Map();

/** The time to wait before the next request to this host, and the slot it takes. */
export function slot(host, now, gap, book = next) {
  const at = Math.max(now, book.get(host) || 0);
  book.set(host, at + gap);
  return at - now;
}

/** When the store last limited this computer, if within the last 30 minutes. */
export function throttled({ file = THROTTLE_FILE, now = Date.now() } = {}) {
  if (!existsSync(file)) return null;
  if (now - statSync(file).mtimeMs > THROTTLE_MINUTES * 60000) { rmSync(file, { force: true }); return null; }
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { url: "" }; }
}

export function noteThrottle(url, why, { file = THROTTLE_FILE } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), url: String(url), why }) + "\n");
}

export class Throttled extends Error {
  constructor() { super(THROTTLED_MESSAGE); this.status = 429; this.throttled = true; }
}

/** Wait for this host's turn. Throws Throttled if the store is limiting this computer. */
export async function pace(url) {
  if (throttled()) throw new Throttled();
  let host = "";
  try { host = new URL(url).host; } catch { return; }
  const wait = slot(host, Date.now(), GAP());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Whether a loaded page is Shopify's bot check rather than the page. */
export function isBotCheck(status, title = "") {
  return status === 429 || (status === 503 && /just a moment/i.test(title)) || /^just a moment/i.test(title.trim());
}

/** page.goto, paced, noting a 429 or bot check. Returns what page.goto returns, or { error }. */
export async function pacedGoto(page, url, opts) {
  await pace(url);
  const res = await page.goto(url, opts);
  const status = res?.status?.();
  let title = "";
  if (status === 429 || status === 503 || status === 200) title = await page.title().catch(() => "");
  if (isBotCheck(status, title)) { noteThrottle(url, status === 429 ? "429" : "bot check"); throw new Throttled(); }
  return res;
}

/** fetch, paced, noting a 429. */
export async function pacedFetch(url, opts) {
  await pace(String(url));
  const r = await fetch(url, opts);
  if (r.status === 429) { noteThrottle(url, "429"); throw new Throttled(); }
  return r;
}
