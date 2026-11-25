// The pages the walks check: one source for all of them.
//
// design/seo-pages.json lists one page per type (home, a collection, a product, the blog...). That
// alone left out the states where most layout bugs hide: a sold-out product, a product on sale, a
// product with many variants, the longest product title, an empty collection, search with no
// results, the 404 page, the cart and the login page. A QA tester's findings over a year had about
// 115 on exactly those pages, which the walks never opened.
//
// design/state-pages.json holds those state pages for the brand. `npm run pages` finds them from the
// live store's public products.json and collections.json (two requests) and writes the file; deploy
// runs it when the file is missing or more than 30 days old. Commit it, and edit it by hand when a
// better example exists (each entry says why it is there).
//
// Walks that open the state pages: visual, accessibility and live comparison. Widths (24 widths) and
// browsers (six engines) keep to one page per type, so a deploy stays within what Shopify allows. The SEO walk keeps to
// seo-pages.json (the 404, cart and login pages are not for search engines).
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_FILE = join(ROOT, "design", "state-pages.json");
export const MISSING_PATH = "/pages/devote-qa-page-that-does-not-exist";
export const NO_RESULTS_PATH = "/search?q=qqzzxxvvkk";
export const FIXED_STATE_PAGES = [
  { path: "/cart", why: "the cart page" },
  { path: "/account/login", why: "the login page" },
  { path: NO_RESULTS_PATH, why: "search with no results" },
  { path: MISSING_PATH, why: "the 404 page" },
];

/** Pages from an env override, else seo-pages.json plus the state pages. Same order every run. */
export function pageList(envVar, { root = ROOT, env = process.env, states = true } = {}) {
  if (envVar && env[envVar]) return env[envVar].split(",").map((s) => s.trim()).filter(Boolean);
  const seoFile = join(root, "design", "seo-pages.json");
  const seo = existsSync(seoFile) ? JSON.parse(readFileSync(seoFile, "utf8")).pages || [] : ["/"];
  const stateFile = join(root, "design", "state-pages.json");
  const extra = states && existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")).pages || []).map((p) => p.path) : [];
  return [...new Set([...(seo.length ? seo : ["/"]), ...extra])];
}

/** Whether a page's HTTP status is the one it should have: the 404 page is meant to be a 404. */
export function statusOk(path, status) {
  if (!status) return true;
  if (String(path).startsWith(MISSING_PATH)) return status === 404;
  return status < 400;
}

/** Whether the state pages file holds the fixed pages only, because the last look was refused. */
export function stateIncomplete({ file = STATE_FILE } = {}) {
  if (!existsSync(file)) return false;
  try { return JSON.parse(readFileSync(file, "utf8")).incomplete === true; } catch { return true; }
}

/** How old the state pages file is, in days, or null when there is none. */
export function stateAgeDays({ file = STATE_FILE, now = Date.now() } = {}) {
  if (!existsSync(file)) return null;
  return (now - statSync(file).mtimeMs) / 86400000;
}

/**
 * The state pages worth checking, picked from the store's public products.json and collections.json.
 * Each pick says why, so a person can swap it for a better one.
 */
export function pickStatePages(products = [], collections = []) {
  const out = [];
  const add = (path, why) => { if (path && !out.some((p) => p.path === path)) out.push({ path, why }); };
  const visible = products.filter((p) => p.handle && p.variants?.length);
  const soldOut = visible.find((p) => p.variants.every((v) => v.available === false));
  add(soldOut && `/products/${soldOut.handle}`, "a sold-out product");
  const onSale = visible.find((p) => p.variants.some((v) => v.compare_at_price && Number(v.compare_at_price) > Number(v.price)));
  add(onSale && `/products/${onSale.handle}`, "a product on sale (compare-at price)");
  const many = [...visible].sort((a, b) => b.variants.length - a.variants.length)[0];
  if (many && many.variants.length > 1) add(`/products/${many.handle}`, `the product with the most variants (${many.variants.length})`);
  const long = [...visible].sort((a, b) => (b.title || "").length - (a.title || "").length)[0];
  if (long) add(`/products/${long.handle}`, `the longest product title (${(long.title || "").length} characters)`);
  const empty = collections.find((c) => c.handle && Number(c.products_count) === 0);
  add(empty && `/collections/${empty.handle}`, "an empty collection");
  for (const f of FIXED_STATE_PAGES) add(f.path, f.why);
  return out;
}

/** The speed walk's pages: one of each main type (home, the first collection, the first product). */
export function speedPages(seoPages = [], env = "") {
  if (env) return env.split(",").map((x) => x.trim()).filter(Boolean);
  const real = seoPages.filter((p) => !/FILL-IN/.test(p));
  const first = (re) => real.find((p) => re.test(p.split("?")[0]));
  return [...new Set(["/", first(/^\/collections\/[^/]+$/), first(/^\/products\/[^/]+$/)].filter(Boolean))];
}
