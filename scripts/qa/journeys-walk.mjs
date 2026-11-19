// Walk: the things a shopper uses, clicked and typed through on the live site and on the preview,
// at 1440px and on a 390px phone, and compared. Menus open, the phone menu opens and closes, search
// suggests and finds, filters, sort and page 2 work, a variant change moves the URL and the price,
// add to cart, quantity and remove work, and the checkout button reaches checkout.
//
// Exists because every other walk only loads pages: nothing in the kit ever clicked or typed. A QA
// tester's findings over one year held about 580 in things you have to use (menus and the phone
// drawer, search, filters, sort and pagination, variant pickers and prices, add to cart and the
// slide cart, checkout, forms, back in stock), and a page can look right while none of them work.
//
//   LIVE_URL='https://<domain>/' PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run journeys
//
// Verdicts, step by step:
//   passes on live, fails on the preview      FAIL: the build broke it
//   fails on both                             "fails on live too": listed, not a failure of the build
//   on live, missing on the preview           FAIL
//   a JS error, or a 4xx/5xx from the store's own domain, during a journey on the preview that never
//   happened on live                          FAIL
//   no element found on either site           NOT FOUND: add it to design/journeys.json (selectors or skip)
//   a page that would not load                NOT CHECKED
// NOT FOUND and NOT CHECKED exit 1 like a FAIL: they are never a pass. "nothing to check" (no sold
// out variant, one page of products) is said and is not a failure. When the live site is not on
// Shopify yet, the preview is judged on its own. A picture of the preview at every failed step
// goes to parity/journeys/.
//
// Safety, on the live store as much as the preview: nothing is ever typed into checkout and nothing
// goes past its first step, so no order is ever placed. Every cart the walk makes is cleared
// (POST /cart/clear.js). No form is sent: posts to /contact, /account and email platform sign-ups
// are blocked unless the journey says "submit": true, and analytics and ad pixel beacons are
// blocked so the walk's add to carts and checkouts never reach the client's reports.
//
// Built-in journeys (ids for "skip"): menu, drawer (phone only), search, collection, product, cart,
// checkout. They find elements by meaning and Shopify convention (aria labels, /cart/add forms,
// filter.* inputs, sort_by), trying several selectors in order; design/journeys.json "selectors"
// puts a brand's own first. The collection is the first /collections/ page in design/seo-pages.json.
//
// design/journeys.json (optional):
//   { "skip": { "drawer": "the theme has no phone menu; the nav is always shown" },
//     "selectors": { "addToCart": "#buy-now", "cartCount": ".bag-count" },
//     "journeys": [ { "name": "Size guide opens", "at": "both", "steps": [ ... ] } ] }
//   "at" is desktop, phone or both (default). Steps, one action each:
//     { "goto": "/pages/contact" }                 { "click": "<css>" }       { "hover": "<css>" }
//     { "type": "<css>", "text": "words" }         { "press": "Enter" }       { "select": "<css>", "value": "v" }
//     { "wait": 500 } or { "wait": "<css>" }       { "expectVisible": "<css>" }   { "expectHidden": "<css>" }
//     { "expectUrl": "/search" } (or "/regex/")    { "expectText": "<css>", "text": "words" } or { "expectText": "words" }
//     { "expectCartCount": 1 }                     { "submit": "<css of the form>" }
//   "submit" steps only run in a journey with "submit": true, and then the form really sends on the
//   live site and the preview at both widths: point it at a test inbox or test list, never a real one.
//   Selector roles: see STRATEGIES below.
//   "customers": [ { "name": "VIP", "login": "op://<vault>/<item>/username", "password": "op://<vault>/<item>/password",
//                    "expect": { "priceDiffersFromGuest": true } } ] logs each test customer in on live and the
//   preview and runs the product and cart journeys, every journey with "customers": true, and a price check
//   on each product page as that customer. Any difference between live and the preview FAILS. Logins are
//   1Password references read with `op read`, or JOURNEYS_<NAME>_LOGIN and _PASSWORD in CI; a plain value
//   in the file is refused. See scripts/qa/customers.mjs. JOURNEYS_ONLY=customers runs just that part.
// JOURNEYS_TRY_JS='<script>' runs a script on every preview page before the theme's own, to prove the
// walk catches a break (stop the add to cart click, hide the submenus) without deploying one.
// JOURNEYS_ONLY=cart,checkout runs just those journeys.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCookies, cookieHeader, onPasswordPage } from "./preview-session.mjs";
import {
  afterLogin, compareWithGuest, comparePrices, customerVerdict, loginKind, maskOnPage, NEW_ACCOUNTS, newAccountsAt,
  readShownPrice, redact, resolveCredentials, validateCustomers,
} from "./customers.mjs";
import { pageList } from "./page-list.mjs";
import { withPreview } from "./seo-walk.mjs";
import { isMain } from "../platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "parity", "journeys");
const UA = "Mozilla/5.0 (Devote journeys walk)";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, userAgent: null },
  phone: { viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: PHONE_UA },
};
export const BUILT_INS = {
  menu: { name: "header menu", at: ["desktop", "phone"] },
  drawer: { name: "phone menu drawer", at: ["phone"] },
  search: { name: "search", at: ["desktop", "phone"] },
  collection: { name: "collection", at: ["desktop", "phone"] },
  product: { name: "product", at: ["desktop", "phone"] },
  cart: { name: "cart", at: ["desktop", "phone"] },
  checkout: { name: "checkout", at: ["desktop", "phone"] },
};

// Where each thing is looked for, in order. A brand's own "selectors" go first. TEXT is the last
// resort: a visible button, link or summary whose label matches.
export const STRATEGIES = {
  header: ["#header-component", "header-component", "header", "[data-header]", "#shopify-section-header", ".header"],
  menuToggle: ["header-drawer summary", ".header__icon--menu", '[aria-controls*="menu-drawer" i]', '[aria-controls*="menudrawer" i]', 'summary[aria-label*="menu" i]', 'button[aria-label*="menu" i]:not([aria-label*="close" i])', "[data-menu-toggle]", "[data-drawer-toggle]", '[class*="hamburger" i]', '[class*="menu-toggle" i]', '[class*="nav-toggle" i]'],
  menuClose: ['[aria-label*="close" i]', 'button[class*="close" i]', '[class*="drawer__close" i]', "[data-drawer-close]"],
  searchInput: ['input[type="search"]', 'input[name="q"]'],
  searchOpen: ['summary[aria-label*="search" i]', 'button[aria-label*="search" i]', 'a[aria-label*="search" i]', "search-button", 'a[href$="/search"]', "[data-search-toggle]", '[aria-controls*="search" i]', '[class*="search" i]:is(button, summary, a)'],
  filterOpen: ['[aria-controls*="filter" i]', '[aria-controls*="facet" i]', 'facet-drawer summary', '[class*="facets" i] summary[class*="drawer" i]', "[data-filter-toggle]"],
  filterOption: ['input[type="checkbox"][name^="filter."]:not([disabled])', 'input[type="radio"][name^="filter."]:not([disabled])', 'a[href*="filter.v."]', 'a[href*="filter.p."]'],
  sort: ['input[name="sort_by"]', 'select[name="sort_by"]', 'a[href*="sort_by="]'],
  nextPage: ['a[href*="page=2"]', '[class*="pagination" i] a[rel="next"]', 'a[rel="next"]'],
  price: ['[id^="price-"]', "product-price", ".price__container", ".price", '[class*="product-price" i]', '[class*="price" i]'],
  addToCart: ['form[action*="/cart/add"] [name="add"]', 'form[action*="/cart/add"] [type="submit"]', 'button[name="add"]', "[data-add-to-cart]", 'add-to-cart-component button'],
  cartCount: ["cart-count", ".cart-count-bubble", '[class*="cart-bubble" i]', '[id*="cart-count" i]', '[class*="cart-count" i]', "[data-cart-count]", 'a[href$="/cart"] [class*="count" i]', '[aria-label*="cart" i] [class*="count" i]'],
  cartDrawer: ["cart-drawer", "cart-drawer-component dialog", 'dialog[open][class*="cart" i]', '[id*="cart-drawer" i]', '[id*="cartdrawer" i]', '[class*="cart-drawer" i]', '[class*="mini-cart" i]', '[id*="mini-cart" i]', '[class*="side-cart" i]', '[role="dialog"][aria-label*="cart" i]', "dialog[open]"],
  quantityPlus: ['button[name="plus"]', '[aria-label*="increase" i]', '[aria-label*="add one" i]', '[aria-label*="plus" i]', '[data-action="increase"]', '[data-quantity-action="increase"]', 'button[class*="plus" i]'],
  quantityInput: ['input[name="updates[]"]', 'input[name^="updates"]', 'input[name*="quantity" i]', 'input[type="number"]'],
  cartRemove: ['[aria-label*="remove" i]', "cart-remove-button button", "cart-remove-button", 'a[href*="/cart/change"][href*="quantity=0"]', '[data-action="remove"]', '[class*="remove" i]:is(button, a)'],
  checkoutButton: ['[name="checkout"]', "#checkout", 'a[href*="/checkout"]', '[class*="checkout" i]:is(button, a, input[type="submit"])'],
  checkoutStep: ['input[name="email"]', 'input[autocomplete*="email"]', "#email", 'input[name="emailOrPhone"]', 'select[name="countryCode"]', 'input[autocomplete*="shipping"]'],
};
export const TEXT = {
  menuToggle: "^(menu|open menu|navigation|open navigation)$",
  menuClose: "^(close|close menu|×|x)$",
  searchOpen: "^(search|open search)$",
  filterOpen: "^(filter|filters|filter and sort|filter & sort|filter by|refine|show filters)\\b",
  loadMore: "^(load|show|view|see) more",
  quantityPlus: "^\\+$",
  cartRemove: "^(remove|delete)$",
  checkoutButton: "^check\\s*out\\b",
  addToCart: "^(add to (cart|bag|basket)|buy now)",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------ pure functions

/** The selectors for a role, a brand's own first, then the kit's, each once. */
export function strategiesFor(role, overrides = {}) {
  const own = [].concat(overrides?.[role] ?? []).filter((s) => typeof s === "string" && s.trim());
  return [...new Set([...own, ...(STRATEGIES[role] || [])])];
}

export const STEP_KINDS = ["goto", "click", "hover", "type", "press", "select", "wait", "expectVisible", "expectHidden", "expectUrl", "expectText", "expectCartCount", "submit"];
const EXTRA_KEYS = { type: ["text"], select: ["value"], expectText: ["text"] };

/** One step of design/journeys.json as { kind, arg, text?, value? }, or { error }. */
export function parseStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return { error: "a step must be an object such as { \"click\": \"<css>\" }" };
  const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
  if (kinds.length !== 1) return { error: kinds.length ? `one action per step, this one has ${kinds.join(" and ")}` : `no action: use one of ${STEP_KINDS.join(", ")}` };
  const kind = kinds[0], arg = step[kind];
  const extra = Object.keys(step).filter((k) => k !== kind && k !== "name" && !(EXTRA_KEYS[kind] || []).includes(k));
  if (extra.length) return { error: `${kind} does not take ${extra.join(", ")}` };
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (kind === "goto" && !(str(arg) && arg.startsWith("/"))) return { error: "goto takes a path on the store, starting with /" };
  if (["click", "hover", "type", "select", "expectVisible", "expectHidden", "submit", "press", "expectUrl", "expectText"].includes(kind) && !str(arg)) return { error: `${kind} takes a non-empty string` };
  if (kind === "type" && typeof step.text !== "string") return { error: "type needs \"text\": the words to type" };
  if (kind === "select" && typeof step.value !== "string") return { error: "select needs \"value\": the option to choose" };
  if (kind === "wait" && !((typeof arg === "number" && arg >= 0 && arg <= 30000) || str(arg))) return { error: "wait takes milliseconds (up to 30000) or a selector to wait for" };
  if (kind === "expectCartCount" && !(Number.isInteger(arg) && arg >= 0)) return { error: "expectCartCount takes a whole number" };
  if (kind === "expectText" && step.text !== undefined && typeof step.text !== "string") return { error: "expectText's \"text\" must be a string" };
  const out = { kind, arg };
  if (step.text !== undefined) out.text = step.text;
  if (step.value !== undefined) out.value = step.value;
  if (step.name) out.name = String(step.name);
  return out;
}

/** How a step reads in the output: "click .size-guide", "type \"shorts\" into input[name=q]". */
export function stepLabel(s) {
  if (s.name) return s.name;
  switch (s.kind) {
    case "type": return `type "${s.text}" into ${s.arg}`;
    case "select": return `choose "${s.value}" in ${s.arg}`;
    case "wait": return typeof s.arg === "number" ? `wait ${s.arg}ms` : `wait for ${s.arg}`;
    case "expectVisible": return `${s.arg} is visible`;
    case "expectHidden": return `${s.arg} is hidden`;
    case "expectUrl": return `the address has ${s.arg}`;
    case "expectText": return s.text === undefined ? `the page says "${s.arg}"` : `${s.arg} says "${s.text}"`;
    case "expectCartCount": return `the cart holds ${s.arg}`;
    default: return `${s.kind} ${s.arg}`;
  }
}

/** design/journeys.json, checked. { errors: [], journeys, skip, selectors }. Any error means nothing runs. */
export function validateJourneys(cfg) {
  const errors = [];
  if (cfg === undefined || cfg === null) return { errors, journeys: [], skip: {}, selectors: {}, customers: [] };
  if (typeof cfg !== "object" || Array.isArray(cfg)) return { errors: ["design/journeys.json must be an object with journeys, skip, selectors or customers"], journeys: [], skip: {}, selectors: {}, customers: [] };
  for (const k of Object.keys(cfg)) if (!["journeys", "skip", "selectors", "customers", "$comment"].includes(k)) errors.push(`unknown key "${k}" (use journeys, skip, selectors or customers)`);
  const skip = cfg.skip ?? {};
  if (typeof skip !== "object" || Array.isArray(skip)) errors.push("skip must be an object: { \"<built-in id>\": \"<reason>\" }");
  else for (const [id, why] of Object.entries(skip)) {
    if (!BUILT_INS[id]) errors.push(`skip: "${id}" is not a built-in journey (${Object.keys(BUILT_INS).join(", ")})`);
    if (typeof why !== "string" || why.trim().length < 5) errors.push(`skip: "${id}" needs a reason a person can check`);
  }
  const selectors = cfg.selectors ?? {};
  if (typeof selectors !== "object" || Array.isArray(selectors)) errors.push("selectors must be an object: { \"<role>\": \"<css>\" }");
  else for (const [role, v] of Object.entries(selectors)) {
    if (!STRATEGIES[role]) errors.push(`selectors: "${role}" is not a role (${Object.keys(STRATEGIES).join(", ")})`);
    if (![].concat(v).every((s) => typeof s === "string" && s.trim())) errors.push(`selectors: "${role}" takes a selector or a list of them`);
  }
  const journeys = [];
  const list = cfg.journeys ?? [];
  if (!Array.isArray(list)) errors.push("journeys must be a list");
  else list.forEach((j, i) => {
    const where = `journeys[${i}]${j?.name ? ` "${j.name}"` : ""}`;
    if (!j || typeof j !== "object") { errors.push(`${where}: must be an object`); return; }
    if (typeof j.name !== "string" || !j.name.trim()) errors.push(`${where}: needs a name`);
    else if (journeys.some((x) => x.name === j.name) || Object.values(BUILT_INS).some((b) => b.name === j.name)) errors.push(`${where}: the name is already used`);
    const at = j.at ?? "both";
    if (!["desktop", "phone", "both"].includes(at)) errors.push(`${where}: at must be desktop, phone or both`);
    if (j.submit !== undefined && typeof j.submit !== "boolean") errors.push(`${where}: submit must be true or false`);
    if (j.customers !== undefined && typeof j.customers !== "boolean") errors.push(`${where}: customers must be true or false`);
    if (!Array.isArray(j.steps) || !j.steps.length) { errors.push(`${where}: needs a list of steps`); return; }
    const steps = j.steps.map((s, k) => {
      const p = parseStep(s);
      if (p.error) errors.push(`${where} step ${k + 1}: ${p.error}`);
      else if (p.kind === "submit" && j.submit !== true) errors.push(`${where} step ${k + 1}: a submit step needs "submit": true on the journey, and a test inbox`);
      return p;
    });
    journeys.push({ name: j.name, at: at === "both" ? ["desktop", "phone"] : [at], submit: j.submit === true, customers: j.customers === true, steps });
  });
  const c = validateCustomers(cfg.customers);
  errors.push(...c.errors);
  return { errors, journeys, skip: errors.length ? {} : skip, selectors: errors.length ? {} : selectors, customers: errors.length ? [] : c.customers };
}

/** A word to search for from a product title: the first real word of three letters or more. */
export function searchWord(title) {
  const stop = new Set(["the", "and", "for", "with", "new", "our", "your", "mens", "womens", "kids", "pack", "set"]);
  const words = String(title || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/);
  return words.find((w) => w.length >= 3 && !stop.has(w)) || words.find((w) => w.length >= 3) || null;
}

const opts = (v) => [v.option1, v.option2, v.option3];
const diff = (a, b) => opts(a).reduce((n, x, i) => n + (x !== opts(b)[i] ? 1 : 0), 0);

/**
 * From a product's JSON (/products.json shape), the variant change to make from the one shown:
 * { from, to, soldOut } where to is an available variant as close as possible (fewest options
 * changed, a different price preferred) and soldOut the nearest unavailable one, or null.
 */
export function pickVariantChange(product, currentId) {
  const vs = product?.variants || [];
  const from = vs.find((v) => String(v.id) === String(currentId)) || vs.find((v) => v.available) || vs[0];
  if (!from) return { from: null, to: null, soldOut: null };
  const rank = (list) => list.sort((a, b) => diff(a, from) - diff(b, from) || (b.price !== from.price) - (a.price !== from.price));
  const to = rank(vs.filter((v) => v.available && v.id !== from.id))[0] || null;
  const soldOut = rank(vs.filter((v) => !v.available && v.id !== from.id))[0] || null;
  return { from, to, soldOut };
}

/** The products worth testing: one with two available variants (a sold-out one too, if any has it), and one to buy. */
export function pickProducts(products) {
  const multi = (products || []).filter((p) => (p.variants || []).length > 1 && p.variants.filter((v) => v.available).length >= 2);
  const variantProduct = multi.find((p) => p.variants.some((v) => !v.available)) || multi[0] || null;
  const buy = (products || []).find((p) => (p.variants || []).some((v) => v.available)) || null;
  return { variantProduct, buy, buyVariant: buy?.variants.find((v) => v.available) || null };
}

/** True when a price shown on the page (any currency format) includes this amount in cents. */
export function moneyMatches(text, cents) {
  const want = Math.round(Number(cents));
  for (const m of String(text || "").matchAll(/\d[\d.,\s  ']*/g)) {
    const raw = m[0].replace(/[\s  ']+$/, "").replace(/[.,]$/, "");
    const dec = raw.match(/^(.*)[.,](\d{2})$/);
    const whole = (dec ? dec[1] : raw).replace(/[^\d]/g, "");
    if (!whole) continue;
    const value = Number(whole) * 100 + (dec ? Number(dec[2]) : 0);
    if (value === want) return true;
  }
  return false;
}

/** A shown cart count as a number: "3", "(3)", "Cart, 3 items"; empty is 0. */
export function cartCountFrom(text) {
  const m = String(text ?? "").match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/** A form being sent somewhere that emails the client or adds a profile: blocked unless the journey says submit. */
export function isFormSend({ url, method = "GET", postData = "" }) {
  if (String(method).toUpperCase() !== "POST") return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (/^\/(contact|account|customer|challenge)(\/|$)/i.test(u.pathname)) return true;
  if (/(^|\.)klaviyo\.com$/i.test(u.hostname) && /\/(subscriptions|profiles|back-in-stock|push-token)/i.test(u.pathname)) return true;
  if (/back.?in.?stock|restock|notify.?me|newsletter|subscribe/i.test(u.pathname)) return true;
  if (/(^|&)form_type=(contact|customer|create_customer|customer_login|recover_customer_password)(&|$)/.test(String(postData))) return true;
  return false;
}

/** Analytics and ad pixel beacons: blocked, so the walk's add to carts never reach the client's reports. */
export function isTracking(url) {
  let u; try { u = new URL(url); } catch { return false; }
  const hp = u.hostname + u.pathname;
  return /(google-analytics\.com|analytics\.google\.com|googleadservices\.com|doubleclick\.net|facebook\.com\/tr|analytics\.tiktok\.com|ct\.pinterest\.com|bat\.bing\.com|monorail-edge\.shopifysvc\.com|clarity\.ms\/collect|hotjar\.(com|io))/i.test(hp)
    || /\/g\/collect$|\/\.well-known\/shopify\/monorail|\/api\/collect$|\/client\/events\/?$/i.test(u.pathname);
}

/** A problem as a key that is the same on live and the preview: no domains, query strings, ids or line numbers. */
export function problemKey({ kind, text }, origins = []) {
  let t = String(text || "").split("\n")[0];
  for (const o of origins.filter(Boolean)) t = t.split(o).join("");
  t = t.replace(/https?:\/\/[^\s)'"]+/g, (u) => u.replace(/[?#].*$/, ""))
    .replace(/\?[^\s)'"]*/g, "").replace(/:\d+:\d+/g, "").replace(/\d{4,}/g, "#").replace(/\s+/g, " ").trim();
  return `${kind}: ${t}`;
}

/** Problems on the preview that never happened on live, each once. */
export function newProblems(live, preview, origins = []) {
  const seen = new Set(live.map((p) => problemKey(p, origins)));
  const out = new Map();
  for (const p of preview) { const k = problemKey(p, origins); if (!seen.has(k) && !out.has(k)) out.set(k, p); }
  return [...out.keys()];
}

/**
 * One step's outcome from its live and preview status (pass, fail, notfound, none, skipped, error).
 * liveComparable is false when the live site is not on Shopify or the live run could not be checked:
 * the preview is judged on its own.
 */
export function stepVerdict(live, preview, { liveComparable = true } = {}) {
  const l = liveComparable && live !== "error" ? live : undefined;
  if (preview === "error") return "notchecked";
  if (preview === undefined || preview === "skipped") return "notreached";
  if (preview === "pass") return "pass";
  if (preview === "fail") return l === "fail" ? "live-too" : "FAIL";
  if (preview === "none") return l === "pass" ? "FAIL" : l === "fail" ? "live-too" : "none";
  if (preview === "notfound") return l === "pass" ? "FAIL" : l === "fail" ? "live-too" : "notfound";
  return "notchecked";
}

/** Lines up a journey's live and preview steps by name and gives each its verdict. */
export function compareJourney(live, preview, { liveComparable = true } = {}) {
  const ls = live?.steps || [], ps = preview?.steps || [];
  const stopped = ps.some((s) => s.status !== "pass" && s.status !== "none");
  const liveOk = liveComparable && !(ls.length === 1 && ls[0].status === "error");
  const names = ps.map((s) => s.name);
  ls.forEach((s, i) => { if (!names.includes(s.name)) names.splice(Math.min(names.length, i), 0, s.name); });
  return names.map((name) => {
    const l = ls.find((s) => s.name === name), p = ps.find((s) => s.name === name);
    let outcome;
    if (!p) outcome = stopped ? "notreached" : !liveOk ? "notreached" : l.status === "pass" ? "FAIL" : stepVerdict(l.status, l.status, { liveComparable: true }) === "live-too" ? "live-too" : l.status === "notfound" ? "notfound" : "none";
    else outcome = stepVerdict(l?.status, p.status, { liveComparable: liveOk });
    return { name, live: l?.status, preview: p?.status, outcome, detail: p?.detail || l?.detail || (p ? "" : "on live, not on the preview"), liveDetail: l?.detail, shot: p?.shot };
  });
}

export function slugOf(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "step";
}

// ------------------------------------------------------------------------- in the page: helpers

// Installed on every page before its own scripts. "laid": drawn with a size and not hidden;
// "seen": laid, its centre on the screen and nothing else drawn on top of it.
function installHelpers() {
  const laid = (e) => {
    if (!e || !e.isConnected || !e.getClientRects().length) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement || x.getRootNode()?.host) {
      const cs = getComputedStyle(x);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || +cs.opacity < 0.05 || x.inert) return false;
    }
    return true;
  };
  const seen = (e) => {
    if (!laid(e)) return false;
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 12);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    return hit === e || e.contains(hit) || hit.contains(e) || (hit.shadowRoot && hit.shadowRoot.contains(e)) || e.getRootNode()?.host === hit;
  };
  const ok = (mode) => (mode === "seen" ? seen : mode === "laid" ? laid : () => true);
  const label = (e) => (e.getAttribute("aria-label") || e.textContent || e.value || "").replace(/\s+/g, " ").trim();
  const main = () => document.querySelector("main, #MainContent, [role=main]") || document.body;
  window.__dj = {
    laid, seen, label, main,
    find(selectors, { root = document, mode = "seen", text = null } = {}) {
      const r = typeof root === "string" ? document.querySelector(root) : root;
      if (!r) return null;
      for (const s of selectors) {
        let list = [];
        try { list = [...r.querySelectorAll(s)]; } catch { continue; }
        const hit = list.find(ok(mode));
        if (hit) return hit;
      }
      if (text) {
        const re = new RegExp(text, "i");
        return [...r.querySelectorAll('button, a, summary, [role="button"], input[type="submit"], input[type="button"]')].find((e) => ok(mode)(e) && re.test(label(e))) || null;
      }
      return null;
    },
    links: (root = document, mode = "seen") => [...root.querySelectorAll("a[href]")].filter(ok(mode)),
    snap() { window.__dj.before = new Set(window.__dj.links()); },
    fresh() {
      const b = window.__dj.before || new Set();
      return window.__dj.links().filter((a) => !b.has(a) && !/^(javascript:|#|mailto:|tel:)/.test(a.getAttribute("href") || ""));
    },
    products(root) {
      const r = root || main();
      return [...new Set([...r.querySelectorAll('a[href*="/products/"]')].filter(laid).map((a) => new URL(a.href).pathname.replace(/^\/[a-z]{2}(-[a-z]{2})?\//i, "/")))];
    },
    scrollers() {
      const out = [document.scrollingElement];
      for (let e = document.elementFromPoint(innerWidth / 2, innerHeight * 0.6); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 4) out.push(e);
      return out;
    },
  };
}

// --------------------------------------------------------------------------------- the runner

function makeCtx({ page, base, target, viewport, data, selectors }) {
  const ctx = {
    page, base, target, viewport, data, selectors, steps: [],
    url: (path) => withPreview(path, base),
    async goto(path) {
      let res;
      for (let t = 0; ; t++) {
        res = await page.goto(ctx.url(path), { waitUntil: "load", timeout: 60000 }).catch((e) => ({ error: e.message }));
        if (res?.error || res?.status() !== 429) break;
        // the store is slowing the walk down: wait as long as it asks, twice, then say so
        if (t === 2) throw Object.assign(new Error(`${path}: the store kept answering 429 (too many requests); run the walk again in a few minutes`), { notChecked: true });
        await sleep(Math.min(60, Number(res.headers()["retry-after"]) || 20) * 1000);
      }
      if (res?.error) throw Object.assign(new Error(`${path} would not load: ${res.error}`), { notChecked: true });
      if (onPasswordPage(page.url())) throw Object.assign(new Error(`${path}: the store password page came back (set .storefront-password or STOREFRONT_PASSWORD)`), { notChecked: true });
      if (res && res.status() >= 400) throw Object.assign(new Error(`${path} returned ${res.status()}`), { status: res.status() });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
      await page.mouse.move(2, innerHeightOf(viewport) - 2).catch(() => {});
    },
    async find(role, { root, mode = "seen", text } = {}) {
      const h = await page.evaluateHandle((sels, root, mode, text) => window.__dj.find(sels, { root: root || document, mode, text }),
        strategiesFor(role, selectors), root || null, mode, text === undefined ? (TEXT[role] || null) : text);
      return h.asElement() || (await h.dispose(), null);
    },
    async css(selector, mode = "laid") {
      const h = await page.evaluateHandle((s, mode) => window.__dj.find([s], { mode }), selector, mode);
      return h.asElement() || (await h.dispose(), null);
    },
    async waitFor(fn, ms = 6000, every = 250) {
      const end = Date.now() + ms;
      for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(every); }
    },
    cartCount: () => page.evaluate(() => fetch("/cart.js", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((j) => j.item_count)),
    clearCart: () => page.evaluate(() => fetch("/cart/clear.js", { method: "POST", credentials: "same-origin" }).then((r) => r.ok)).catch(() => false),
    async loads(href) {
      const u = new URL(href, page.url());
      const once = () => (u.origin === new URL(page.url()).origin
        ? page.evaluate((h) => fetch(h, { credentials: "same-origin", headers: { accept: "text/html" } }).then((r) => r.status, () => 0), u.toString())
        : fetch(u, { headers: { "user-agent": UA } }).then((r) => r.status, () => 0));
      let status = await once();
      for (let t = 0; t < 2 && status === 429; t++) { await sleep(20000); status = await once(); }
      return status;
    },
    async click(h) {
      try { await h.click(); } catch { await h.evaluate((e) => e.click()); }
    },
    // Records a step. fn returns { status, detail }; a thrown page that would not load is a fail with its status.
    async step(name, fn) {
      let r;
      try { r = await fn(); } catch (e) {
        if (e.notChecked) throw e;
        r = { status: "fail", detail: e.status ? e.message : `stopped: ${e.message.split("\n")[0]}` };
      }
      const rec = { name, status: r.status, detail: r.detail || "" };
      if (target === "preview" && ["fail", "notfound"].includes(r.status)) {
        rec.shot = join("parity", "journeys", `${slugOf(ctx.journey)}-${viewport}-${slugOf(name)}.png`);
        // logged in as a test customer: their email or name may be on the page, and never goes into a picture
        if (ctx.secrets?.length) await page.evaluate(maskOnPage, ctx.secrets).catch(() => {});
        await page.screenshot({ path: join(ROOT, rec.shot) }).catch(() => { rec.shot = undefined; });
      }
      ctx.steps.push(rec);
      return r.status === "pass";
    },
  };
  return ctx;
}
const innerHeightOf = (vp) => VIEWPORTS[vp].viewport.height;
const notFound = (what, role) => ({ status: "notfound", detail: `NOT FOUND on this theme: ${what}. Add it to design/journeys.json${role ? ` ("selectors": { "${role}": "<css>" })` : ""}, or skip the journey with a reason` });

// --------------------------------------------------------------------------- built-in journeys

async function openDrawer(ctx) {
  const { page } = ctx;
  const toggle = await ctx.find("menuToggle");
  if (!toggle) return { result: notFound("no menu button in the header", "menuToggle") };
  await page.evaluate(() => window.__dj.snap());
  await ctx.click(toggle);
  const fresh = await ctx.waitFor(() => page.evaluate(() => { const f = window.__dj.fresh(); return f.length >= 3 ? f.length : null; }), 3000);
  if (!fresh) return { toggle, result: { status: "fail", detail: "the menu button was pressed and no menu links came on screen" } };
  await sleep(500); // let a sliding drawer finish
  const drawer = await page.evaluateHandle(() => {
    const f = window.__dj.fresh();
    // the drawer: the smallest element holding every link that came on screen
    let box = f[0]?.parentElement;
    while (box && !f.every((a) => box.contains(a))) box = box.parentElement;
    window.__dj.drawerLinks = f;
    return box;
  });
  return { toggle, drawer: drawer.asElement(), result: { status: "pass", detail: `${fresh} links came on screen` } };
}

async function drawerJourney(ctx) {
  const { page } = ctx;
  await ctx.goto("/");
  let opened;
  if (!(await ctx.step("the menu button opens the drawer with its links", async () => (opened = await openDrawer(ctx)).result))) return;
  if (!(await ctx.step("the drawer closes", async () => {
    let close = opened.drawer && await ctx.find("menuClose", { root: opened.drawer });
    if (!close) close = await ctx.find("menuClose");
    if (close) await ctx.click(close);
    else if (await opened.toggle.evaluate((e) => window.__dj.seen(e))) await ctx.click(opened.toggle);
    else await page.keyboard.press("Escape");
    const shut = await ctx.waitFor(() => page.evaluate(() => (window.__dj.drawerLinks || []).every((a) => !window.__dj.seen(a)) || null), 3000);
    return shut ? { status: "pass", detail: close ? "with its close button" : "with the menu button or Escape" } : { status: "fail", detail: "its links are still on screen after pressing close" };
  }))) return;
  await ctx.step("the page scrolls again", async () => {
    await sleep(400);
    const tall = await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 200);
    if (!tall) return { status: "none", detail: "the home page is not taller than the screen" };
    const before = await page.evaluate(() => window.__dj.scrollers().map((e) => e.scrollTop));
    await page.mouse.move(195, 600);
    await page.mouse.wheel({ deltaY: 600 });
    await sleep(700);
    const after = await page.evaluate(() => window.__dj.scrollers().map((e) => e.scrollTop));
    const moved = after.some((t, i) => t > (before[i] || 0) + 20);
    const locked = await page.evaluate(() => [document.documentElement, document.body].some((e) => /hidden|clip/.test(getComputedStyle(e).overflowY)) || getComputedStyle(document.body).position === "fixed");
    return moved && !locked ? { status: "pass" } : { status: "fail", detail: locked ? "the page is still locked (overflow hidden or position fixed on html or body)" : "a scroll did not move the page" };
  });
}

async function menuJourney(ctx) {
  const { page } = ctx;
  await ctx.goto("/");
  const phone = ctx.viewport === "phone";
  // the items that have a submenu: their own hidden links, or a control that says it opens one
  const listItems = async () => page.evaluate((headerSels, phone) => {
    const dj = window.__dj;
    let root;
    if (phone) root = dj.drawerRoot;
    else {
      const hdr = dj.find(headerSels, { mode: "laid" });
      if (!hdr) return null;
      const navs = [...hdr.querySelectorAll("nav")].filter(dj.laid).sort((a, b) => b.querySelectorAll("a").length - a.querySelectorAll("a").length);
      root = navs[0] || hdr;
    }
    if (!root) return null;
    // top-level items: list items not inside another list item (Horizon has no ul, only an overflow-list)
    const lis = [...root.querySelectorAll("li")].filter((li) => { const up = li.parentElement?.closest("li"); return !up || !root.contains(up); });
    const items = lis.length ? lis : [...root.querySelectorAll("details")].filter((d) => !d.parentElement?.closest("details"));
    dj.items = [];
    return items.map((li) => {
      const trigger = [...li.querySelectorAll("summary, a, button")].find(dj.seen);
      if (!trigger) return null;
      const control = li.querySelector('summary, [aria-expanded], [aria-haspopup="true"], button[aria-controls]');
      const hasSub = li.querySelectorAll("a[href]").length > 1 || !!control;
      if (!hasSub) return null;
      dj.items.push({ trigger, control, li });
      return dj.label(trigger).slice(0, 40) || "(no label)";
    }).filter(Boolean);
  }, strategiesFor("header", ctx.selectors), phone);

  if (phone) {
    let opened;
    if (!(await ctx.step("the menu drawer opens", async () => (opened = await openDrawer(ctx)).result))) return;
    await page.evaluate((d) => { window.__dj.drawerRoot = d; }, opened.drawer);
  }
  const labels = await listItems();
  if (labels === null) { await ctx.step("the header menu is there", async () => notFound(phone ? "no menu list in the drawer" : "no header or menu", "header")); return; }
  if (!labels.length) { await ctx.step("a menu item has a submenu", async () => ({ status: "none", detail: "no menu item has a submenu" })); return; }
  for (let i = 0; i < Math.min(labels.length, 8); i++) {
    const name = `${labels[i]}: its submenu opens and its first link loads`;
    await ctx.step(name, async () => {
      const item = await page.evaluateHandle((i) => window.__dj.items[i], i);
      const trigger = await item.getProperty("trigger").then((h) => h.asElement());
      const control = await item.getProperty("control").then((h) => h.asElement());
      if (!trigger || !(await trigger.evaluate((e) => window.__dj.seen(e)))) return { status: "fail", detail: "the menu item is not on screen" };
      await page.evaluate(() => window.__dj.snap());
      let how = phone ? "tapped" : "hovered";
      if (phone) await ctx.click(control || trigger); else await trigger.hover();
      let fresh = await ctx.waitFor(() => page.evaluate(() => window.__dj.fresh().length || null), 1500);
      if (!fresh && !phone && control) { await ctx.click(control); how = "clicked"; fresh = await ctx.waitFor(() => page.evaluate(() => window.__dj.fresh().length || null), 1500); }
      if (!fresh) return { status: "fail", detail: `${how}, and no submenu links came on screen` };
      const href = await page.evaluate(() => window.__dj.fresh()[0].href);
      const status = await ctx.loads(href);
      if (status === 429) throw Object.assign(new Error(`the store kept answering 429 (too many requests) for ${href}`), { notChecked: true });
      return status === 200 ? { status: "pass", detail: `${how}: ${fresh} links, first ${new URL(href).pathname} loads` } : { status: "fail", detail: `the first link, ${href}, returned ${status || "nothing"}` };
    });
    if (i + 1 >= Math.min(labels.length, 8)) break;
    // close it before the next one
    await page.keyboard.press("Escape").catch(() => {});
    if (phone) {
      // the drawer is opened afresh for the next item: back buttons differ on every theme
      await ctx.goto("/");
      const again = await openDrawer(ctx);
      if (again.result.status !== "pass") return;
      await page.evaluate((d) => { window.__dj.drawerRoot = d; }, again.drawer);
      const relabel = await listItems();
      if (!relabel || relabel[i + 1] !== labels[i + 1]) return;
    } else {
      await page.mouse.move(720, 880);
      await page.evaluate(() => document.querySelectorAll("header details[open], #header-component details[open]").forEach((d) => d.removeAttribute("open")));
      await sleep(600);
    }
  }
}

async function searchJourney(ctx) {
  const { page, data } = ctx;
  await ctx.goto("/");
  const word = data.searchWord;
  let input;
  if (!(await ctx.step("the search box opens", async () => {
    input = await ctx.find("searchInput", { text: null });
    if (input) return { status: "pass", detail: "already on screen" };
    const open = await ctx.find("searchOpen");
    if (!open) return notFound("no search button or search box", "searchOpen");
    await ctx.click(open);
    input = await ctx.waitFor(() => ctx.find("searchInput", { text: null }), 4000);
    return input ? { status: "pass" } : { status: "fail", detail: "the search button was pressed and no search box came on screen" };
  }))) return;
  if (!word) { await ctx.step("typing shows suggestions", async () => ({ status: "notfound", detail: "no product title on /collections/all to take a word from" })); return; }
  await ctx.step(`typing "${word}" shows suggestions`, async () => {
    const asked = ctx.requests.length;
    await page.evaluate(() => window.__dj.snap());
    await ctx.click(input);
    await page.keyboard.type(word, { delay: 70 });
    const fresh = await ctx.waitFor(() => page.evaluate(() => window.__dj.fresh().filter((a) => /\/(products|collections|search|pages|blogs)\//.test(a.href)).length || null), 6000);
    const suggest = ctx.requests.slice(asked).some((u) => u.includes("/search/suggest"));
    if (fresh) return { status: "pass", detail: `${fresh} suggestions` };
    return suggest ? { status: "fail", detail: "suggestions were asked for and none came on screen" } : { status: "none", detail: "this theme has no suggestions while typing" };
  });
  await ctx.step("Enter shows results on /search", async () => {
    await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 20000 }).catch(() => null), page.keyboard.press("Enter")]);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
    const u = new URL(page.url());
    if (!/\/search/.test(u.pathname)) return { status: "fail", detail: `Enter went to ${u.pathname}, not /search` };
    const n = await page.evaluate(() => window.__dj.products().length);
    return n ? { status: "pass", detail: `${n} products` } : { status: "fail", detail: `/search?q=${u.searchParams.get("q")} shows no products` };
  });
  await ctx.step("a nonsense word shows the no-results page", async () => {
    await ctx.goto("/search?q=zqxvjwkplm");
    const r = await page.evaluate(() => ({ n: window.__dj.products().length, text: window.__dj.main().innerText.trim().length }));
    if (r.n) return { status: "fail", detail: `${r.n} products for a word no product has` };
    return r.text > 10 ? { status: "pass" } : { status: "fail", detail: "the results area is empty: no message" };
  });
}

// Make a hidden control clickable the way a shopper would: open its closed details, the phone
// filter drawer, then use its label if the input itself is drawn as something else.
async function reveal(ctx, h) {
  const { page } = ctx;
  for (let t = 0; t < 3 && !(await h.evaluate((e) => window.__dj.laid(e))); t++) {
    const summary = await h.evaluateHandle((e) => { const d = [...(function* () { for (let x = e.parentElement; x; x = x.parentElement) if (x.tagName === "DETAILS" && !x.open) yield x; })()].pop(); return d ? d.querySelector(":scope > summary") : null; });
    const s = summary.asElement();
    if (s && (await s.evaluate((e) => window.__dj.laid(e)))) { await ctx.click(s); await sleep(500); continue; }
    const open = await ctx.find("filterOpen");
    if (open && t === 0) { await ctx.click(open); await sleep(700); continue; }
    break;
  }
  if (await h.evaluate((e) => window.__dj.laid(e))) return h;
  const lab = await h.evaluateHandle((e) => (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest("label"));
  const l = lab.asElement();
  return l && (await l.evaluate((e) => window.__dj.laid(e))) ? l : null;
}

async function collectionJourney(ctx) {
  const { page, data } = ctx;
  const path = data.collection;
  const first = async () => { await ctx.goto(path); return page.evaluate(() => window.__dj.products()); };
  let start;
  if (!(await ctx.step(`${path} shows products`, async () => { start = await first(); return start.length ? { status: "pass", detail: `${start.length} products` } : { status: "fail", detail: "no product links on the page" }; }))) return;

  await ctx.step("the first filter option changes the list", async () => {
    // a drawn one first: themes often hold a second, hidden copy of the filters for phones
    const h = await ctx.find("filterOption", { mode: "laid", text: null }) || await ctx.find("filterOption", { mode: "any", text: null });
    if (!h) return notFound("no filter options (filter.* inputs or links)", "filterOption");
    const target = await reveal(ctx, h);
    if (!target) return { status: "fail", detail: "a filter option exists but could not be opened on screen" };
    const name = await h.evaluate((e) => `${e.name || ""}=${e.value || e.textContent.trim()}`.slice(0, 60));
    const url = page.url();
    await ctx.click(target);
    const changed = await ctx.waitFor(async () => page.url() !== url || (await page.evaluate((s) => window.__dj.products().join() !== s, start.join())), 8000);
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
    const now = await page.evaluate(() => window.__dj.products());
    if (!changed) return { status: "fail", detail: `${name} was picked and neither the address nor the products changed` };
    return now.length ? { status: "pass", detail: `${name}: ${start.length} products, then ${now.length}` } : { status: "fail", detail: `${name} left no products on screen` };
  });

  await ctx.step("sort changes the order", async () => {
    await first();
    const h = await ctx.find("sort", { mode: "laid", text: null }) || await ctx.find("sort", { mode: "any", text: null });
    if (!h) return notFound("no sort control (sort_by)", "sort");
    const kind = await h.evaluate((e) => e.tagName === "SELECT" ? "select" : e.tagName === "A" ? "link" : "radio");
    const values = await page.evaluate(() => {
      const sel = document.querySelector('select[name="sort_by"]');
      const radios = [...document.querySelectorAll('input[name="sort_by"]')];
      return { all: sel ? [...sel.options].map((o) => o.value) : radios.map((r) => r.value), current: sel ? sel.value : (radios.find((r) => r.checked) || {}).value || new URLSearchParams(location.search).get("sort_by") };
    });
    const pick = ["price-descending", "price-ascending", "title-ascending", "created-descending"].find((v) => v !== values.current && (values.all.includes(v) || kind === "link")) || values.all.find((v) => v !== values.current);
    const url = page.url();
    let how = kind;
    if (kind === "select") {
      if (await h.evaluate((e) => window.__dj.laid(e))) await h.select(pick); else { await h.select(pick); how = "select (hidden, set directly)"; }
    } else if (kind === "link") {
      const link = await ctx.css(`a[href*="sort_by=${pick}"]`) || await ctx.css(`a[href*="sort_by=${pick}"]`, "any") || h;
      const t = await reveal(ctx, link); if (!t) return { status: "fail", detail: "the sort links could not be opened on screen" };
      await ctx.click(t);
    } else {
      const radio = await ctx.css(`input[name="sort_by"][value="${pick}"]`) || await ctx.css(`input[name="sort_by"][value="${pick}"]`, "any");
      const t = radio && await reveal(ctx, radio);
      if (!t) return { status: "fail", detail: "the sort options could not be opened on screen" };
      await ctx.click(t);
    }
    const changed = await ctx.waitFor(async () => /sort_by=/.test(page.url()) && page.url() !== url ? "url" : (await page.evaluate((s) => window.__dj.products()[0] !== s, start[0])) ? "order" : null, 8000);
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
    return changed ? { status: "pass", detail: `${pick} (${how})` } : { status: "fail", detail: `${pick} was chosen and neither the address nor the first product changed` };
  });

  await ctx.step("page 2 or load more brings new products", async () => {
    const one = await first();
    const next = await ctx.find("nextPage", { mode: "laid", text: null }) || await ctx.find("nextPage", { mode: "laid", text: TEXT.loadMore });
    if (next) {
      const isLink = await next.evaluate((e) => e.tagName === "A" && /page=2|rel/.test(e.outerHTML));
      await ctx.click(next);
      const more = await ctx.waitFor(() => page.evaluate((s) => { const now = window.__dj.products(); return now.some((p) => !s.includes(p)) ? now.length : null; }, one), 10000);
      return more ? { status: "pass", detail: isLink ? "page 2 has new products" : `load more: ${one.length}, then ${more}` } : { status: "fail", detail: "pressed, and no new products came" };
    }
    if (data.collectionTotal !== null && data.collectionTotal <= one.length) return { status: "none", detail: `all ${data.collectionTotal} products show on one page` };
    for (let t = 0; t < 4; t++) { await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(1500); }
    const now = await page.evaluate(() => window.__dj.products());
    if (now.some((p) => !one.includes(p))) return { status: "pass", detail: `scrolling loads more: ${one.length}, then ${now.length}` };
    return notFound(`${one.length} of ${data.collectionTotal ?? "more"} products show and no page 2 link, load more button or infinite scroll was found`, "nextPage");
  });
}

// Pick the option values of a variant on the page: radios or swatches by value, else a select.
async function chooseVariant(ctx, from, to, optionNames) {
  const { page } = ctx;
  const done = [];
  for (let i = 0; i < 3; i++) {
    const v = [to.option1, to.option2, to.option3][i];
    if (v == null || v === [from.option1, from.option2, from.option3][i]) continue;
    const h = await page.evaluateHandle((v, optName) => {
      const m = window.__dj.main();
      const scope = [...m.querySelectorAll("variant-picker, variant-selects, [class*=variant-picker i], [class*=variant i], form[action*='/cart/add'], product-form, [class*=product-form i]")];
      const roots = scope.length ? scope : [m];
      const inRoot = (sel) => roots.flatMap((r) => [...r.querySelectorAll(sel)]);
      const radios = inRoot('input[type="radio"]').filter((r) => r.value === v || r.dataset.value === v || r.dataset.optionValue === v);
      const radio = radios.find((r) => (r.closest("fieldset")?.textContent || r.name || "").toLowerCase().includes(String(optName).toLowerCase())) || radios[0];
      if (radio) return { el: radio, kind: "radio" };
      const sel = inRoot("select").find((s) => [...s.options].some((o) => o.value === v || o.textContent.trim() === v));
      if (sel) return { el: sel, kind: "select", value: [...sel.options].find((o) => o.value === v || o.textContent.trim() === v).value };
      const sw = inRoot("button, label, [role=radio], [data-value]").find((b) => (b.dataset.value === v || b.textContent.trim() === v) && window.__dj.laid(b));
      return sw ? { el: sw, kind: "swatch" } : null;
    }, v, optionNames[i] || "");
    const kind = await h.evaluate((x) => x?.kind || null);
    if (!kind) return { ok: false, detail: `no picker for "${v}"` };
    const el = (await h.getProperty("el")).asElement();
    if (kind === "select") await el.select(await h.evaluate((x) => x.value));
    else {
      if (kind === "radio" && await el.evaluate((e) => e.disabled)) return { ok: false, disabled: true, detail: `"${v}" cannot be picked` };
      const t = kind === "radio" ? await reveal(ctx, el) : el;
      if (!t) return { ok: false, detail: `the "${v}" option is not on screen` };
      await ctx.click(t);
    }
    done.push(v);
    await sleep(600);
  }
  return { ok: true, detail: done.join(" / ") };
}

async function productJourney(ctx) {
  const { page, data } = ctx;
  const p = data.variantProduct;
  if (!p) { await ctx.step("a product with more than one variant", async () => ({ status: "none", detail: "none of the first 50 products has two variants in stock" })); return; }
  await ctx.goto(`/products/${p.handle}`);
  const shownId = async () => page.evaluate(() => (document.querySelector('form[action*="/cart/add"] [name="id"]') || {}).value || new URLSearchParams(location.search).get("variant"));
  const pick = pickVariantChange(p, await shownId());
  const names = (p.options || []).map((o) => o.name || o);
  let js;
  if (!(await ctx.step(`changing the variant of ${p.handle} updates the address and the price`, async () => {
    const r = await chooseVariant(ctx, pick.from, pick.to, names);
    if (!r.ok) return r.disabled ? { status: "fail", detail: r.detail } : notFound(`${r.detail} on /products/${p.handle}`, null);
    js = await page.evaluate((h) => fetch(`/products/${h}.js`).then((x) => x.json()), p.handle);
    const want = js.variants.find((v) => v.id === pick.to.id);
    const okUrl = await ctx.waitFor(() => page.evaluate((id) => new URLSearchParams(location.search).get("variant") === String(id) || null, pick.to.id), 5000);
    const priceText = async () => { const h = await ctx.find("price", { root: await page.evaluateHandle(() => window.__dj.main()), mode: "laid", text: null }); return h ? h.evaluate((e) => e.innerText) : ""; };
    const okPrice = await ctx.waitFor(async () => moneyMatches(await priceText(), want.price) || null, 4000);
    const idNow = await shownId();
    const problems = [];
    if (!okUrl) problems.push(`the address has variant=${new URL(page.url()).searchParams.get("variant") || "nothing"}, not ${pick.to.id}`);
    if (String(idNow) !== String(pick.to.id)) problems.push(`the form would add variant ${idNow}, not ${pick.to.id}`);
    if (!okPrice) problems.push(`the price shown, "${(await priceText()).replace(/\s+/g, " ").slice(0, 60)}", is not ${(want.price / 100).toFixed(2)}`);
    return problems.length ? { status: "fail", detail: `${r.detail}: ${problems.join("; ")}` } : { status: "pass", detail: `${r.detail}: variant ${pick.to.id} at ${(want.price / 100).toFixed(2)}` };
  }))) return;
  await ctx.step("a sold-out variant cannot be added", async () => {
    if (!pick.soldOut) return { status: "none", detail: `${p.handle} has no sold-out variant` };
    const r = await chooseVariant(ctx, pick.to, pick.soldOut, names);
    if (!r.ok && r.disabled) return { status: "pass", detail: r.detail };
    if (!r.ok) return notFound(r.detail, null);
    const btn = await ctx.find("addToCart", { mode: "laid" });
    if (!btn) return notFound("no add to cart button", "addToCart");
    const off = await ctx.waitFor(() => btn.evaluate((b) => b.disabled || b.getAttribute("aria-disabled") === "true" || /sold out|unavailable|out of stock/i.test(b.textContent) || null), 3000);
    return off ? { status: "pass", detail: `${r.detail}: the button says "${(await btn.evaluate((b) => b.textContent)).replace(/\s+/g, " ").trim().slice(0, 30)}"` } : { status: "fail", detail: `${r.detail} is sold out and the add to cart button still works` };
  });
}

async function cartJourney(ctx) {
  const { page, data } = ctx;
  if (!data.buy) { await ctx.step("a product in stock", async () => ({ status: "none", detail: "none of the first 50 products is in stock" })); return; }
  const handle = data.buy.handle;
  await ctx.goto(`/products/${handle}?variant=${data.buyVariant.id}`);
  const countShown = async () => { const h = await ctx.find("cartCount", { mode: "laid", text: null }); return h ? h.evaluate((e) => e.dataset.cartCount ?? e.textContent) : null; };
  const shownBefore = cartCountFrom(await countShown());
  if (!(await ctx.step("add to cart puts it in the cart", async () => {
    const btn = await ctx.find("addToCart", { mode: "laid" });
    if (!btn) return notFound("no add to cart button", "addToCart");
    await ctx.click(btn);
    const n = await ctx.waitFor(async () => ((await ctx.cartCount()) >= 1 ? await ctx.cartCount() : null), 8000);
    return n ? { status: "pass", detail: `/cart.js holds ${n}` } : { status: "fail", detail: "pressed, and /cart.js still holds nothing" };
  }))) return;
  await ctx.step("the header cart count goes up", async () => {
    const after = await ctx.waitFor(async () => { const t = await countShown(); return t !== null && cartCountFrom(t) > shownBefore ? cartCountFrom(t) : null; }, 5000);
    if (after) return { status: "pass", detail: `${shownBefore}, then ${after}` };
    return (await countShown()) === null ? notFound("no cart count in the header", "cartCount") : { status: "fail", detail: `the header still shows ${cartCountFrom(await countShown())}` };
  });
  let box = null;
  if (!(await ctx.step("a cart drawer opens, or /cart shows the item", async () => {
    const drawer = await ctx.waitFor(async () => { const d = await ctx.find("cartDrawer", { mode: "seen", text: null }); return d && (await d.evaluate((e, h) => !!e.querySelector(`a[href*="/products/${h}"]`), handle)) ? d : null; }, 4000);
    if (drawer) { box = drawer; return { status: "pass", detail: "the cart drawer opened with it" }; }
    if (!/\/cart\b/.test(new URL(page.url()).pathname)) await ctx.goto("/cart");
    box = await page.evaluateHandle(() => window.__dj.main());
    const has = await box.evaluate((e, h) => !!e.querySelector(`a[href*="/products/${h}"]`), handle);
    return has ? { status: "pass", detail: "no drawer; /cart shows it" } : { status: "fail", detail: "no drawer opened and /cart does not show it" };
  }))) return;
  if (!(await ctx.step("more quantity updates the cart", async () => {
    const plus = await ctx.find("quantityPlus", { root: box, mode: "laid" });
    if (plus) await ctx.click(plus);
    else {
      const input = await ctx.find("quantityInput", { root: box, mode: "laid", text: null });
      if (!input) return notFound("no quantity + button or quantity box in the cart", "quantityPlus");
      await input.click({ clickCount: 3 }); await page.keyboard.type("2"); await page.keyboard.press("Tab");
    }
    const n = await ctx.waitFor(async () => ((await ctx.cartCount()) === 2 ? 2 : null), 8000);
    return n ? { status: "pass", detail: "/cart.js holds 2" } : { status: "fail", detail: `/cart.js holds ${await ctx.cartCount()}, not 2` };
  }))) return;
  await ctx.step("remove empties the cart", async () => {
    const rm = await ctx.find("cartRemove", { root: box, mode: "laid" });
    if (!rm) return notFound("no remove button in the cart", "cartRemove");
    await ctx.click(rm);
    const empty = await ctx.waitFor(async () => ((await ctx.cartCount()) === 0 ? "empty" : null), 8000);
    return empty ? { status: "pass" } : { status: "fail", detail: `/cart.js still holds ${await ctx.cartCount()}` };
  });
}

async function checkoutJourney(ctx) {
  const { page, data } = ctx;
  if (!data.buy) { await ctx.step("a product in stock", async () => ({ status: "none", detail: "none of the first 50 products is in stock" })); return; }
  await ctx.goto("/cart");
  await page.evaluate((id) => fetch("/cart/add.js", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ id, quantity: 1 }] }) }), data.buyVariant.id);
  await ctx.goto("/cart");
  if (!(await ctx.step("the checkout button on /cart goes to checkout", async () => {
    const btn = await ctx.find("checkoutButton", { mode: "laid" });
    if (!btn) return notFound("no checkout button on /cart", "checkoutButton");
    await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 40000 }).catch(() => null), ctx.click(btn)]);
    const ok = await ctx.waitFor(() => page.evaluate(() => /\/checkouts?\b/.test(location.pathname) || null), 10000);
    return ok ? { status: "pass" } : { status: "fail", detail: `pressed, and the page is ${new URL(page.url()).pathname}` };
  }))) return;
  await ctx.step("checkout shows its first step (contact or delivery)", async () => {
    const el = await ctx.waitFor(() => ctx.find("checkoutStep", { mode: "laid", text: null }), 25000, 500);
    if (el) return { status: "pass" };
    const said = await page.evaluate(() => /\b(contact|delivery|shipping)\b/i.test(document.body.innerText));
    return said ? { status: "pass", detail: "the contact or delivery heading shows" } : { status: "fail", detail: "no contact or delivery step came" };
  });
}

async function customJourney(ctx, j) {
  const { page } = ctx;
  await ctx.goto("/");
  for (const s of j.steps) {
    const ok = await ctx.step(stepLabel(s), async () => {
      const el = async (sel, mode = "laid", ms = 5000) => ctx.waitFor(() => ctx.css(sel, mode), ms);
      switch (s.kind) {
        case "goto": await ctx.goto(s.arg); return { status: "pass" };
        case "click": case "hover": case "type": case "select": case "submit": {
          const h = await el(s.arg);
          if (!h) return { status: "fail", detail: `nothing visible matches ${s.arg}` };
          if (s.kind === "click") await ctx.click(h);
          if (s.kind === "hover") await h.hover();
          if (s.kind === "type") { await h.click({ clickCount: 3 }).catch(() => {}); await page.keyboard.type(s.text, { delay: 40 }); }
          if (s.kind === "select") { const got = await h.select(s.value); if (!got.length) return { status: "fail", detail: `no option "${s.value}"` }; }
          if (s.kind === "submit") { await h.evaluate((e) => { const f = e.tagName === "FORM" ? e : e.closest("form"); if (f) f.requestSubmit(); else e.click(); }); await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => {}); }
          await sleep(400);
          return { status: "pass" };
        }
        case "press": await page.keyboard.press(s.arg); await sleep(400); return { status: "pass" };
        case "wait":
          if (typeof s.arg === "number") { await sleep(s.arg); return { status: "pass" }; }
          return (await el(s.arg, "laid", 10000)) ? { status: "pass" } : { status: "fail", detail: `${s.arg} never came` };
        case "expectVisible": return (await el(s.arg)) ? { status: "pass" } : { status: "fail", detail: `${s.arg} is not visible` };
        case "expectHidden": return (await ctx.waitFor(async () => !(await ctx.css(s.arg)), 5000)) ? { status: "pass" } : { status: "fail", detail: `${s.arg} is still visible` };
        case "expectUrl": {
          const re = /^\/.+\/[a-z]*$/.test(s.arg) && s.arg.length > 2 ? new RegExp(s.arg.slice(1, s.arg.lastIndexOf("/")), s.arg.slice(s.arg.lastIndexOf("/") + 1)) : null;
          const hit = await ctx.waitFor(async () => (re ? re.test(page.url()) : page.url().includes(s.arg)) || null, 5000);
          return hit ? { status: "pass" } : { status: "fail", detail: `the address is ${page.url()}` };
        }
        case "expectText": {
          const hit = await ctx.waitFor(() => page.evaluate((sel, text) => {
            const els = text === null ? [document.body] : [...document.querySelectorAll(sel)].filter(window.__dj.laid);
            const want = text === null ? sel : text;
            return els.some((e) => e.innerText.includes(want)) || null;
          }, s.arg, s.text ?? null), 5000);
          return hit ? { status: "pass" } : { status: "fail", detail: "the words are not on the page" };
        }
        case "expectCartCount": {
          const n = await ctx.waitFor(async () => ((await ctx.cartCount()) === s.arg ? "yes" : null), 6000);
          return n ? { status: "pass" } : { status: "fail", detail: `/cart.js holds ${await ctx.cartCount()}` };
        }
      }
      return { status: "error", detail: `unknown step ${s.kind}` };
    });
    if (!ok) return;
  }
}

// --------------------------------------------------------------------------------- one run

// session: a logged-in customer's own browser context, kept open between journeys ({ context, name, secrets })
async function runOne({ browser, journey, target, base, viewport, data, selectors, tryJs, session }) {
  const context = session?.context || await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [], blocked = [], requests = [];
  const ctx = makeCtx({ page, base, target, viewport, data, selectors });
  ctx.journey = session ? `${session.name} ${journey.name}` : journey.name;
  ctx.secrets = session?.secrets || [];
  ctx.requests = requests;
  const host = base.hostname;
  try {
    page.setDefaultTimeout(20000);
    // Shopify answers 429 to fetches from a browser that calls itself HeadlessChrome
    await page.emulate({ ...VIEWPORTS[viewport], userAgent: VIEWPORTS[viewport].userAgent || (await browser.userAgent()).replace("HeadlessChrome", "Chrome") });
    await page.evaluateOnNewDocument(installHelpers);
    if (target === "preview" && tryJs) await page.evaluateOnNewDocument(tryJs);
    if (target === "preview") await applyCookies(page, base.toString());
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const url = r.url();
      requests.push(url);
      if (isTracking(url) || (!journey.submit && isFormSend({ url, method: r.method(), postData: r.postData() || "" }))) {
        if (!isTracking(url)) blocked.push(url);
        return r.abort("blockedbyclient").catch(() => {});
      }
      return r.continue().catch(() => {});
    });
    page.on("pageerror", (e) => problems.push({ kind: "JS error", text: e.message }));
    page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) problems.push({ kind: "console error", text: m.text() }); });
    page.on("response", (r) => {
      try {
        const u = new URL(r.url());
        // 429 is the store slowing a busy visitor down, not the theme
        if (u.hostname === host && r.status() >= 400 && r.status() !== 429 && !/preview_bar|\/_t\//.test(u.pathname)) problems.push({ kind: `${r.status()} from`, text: `${r.request().method()} ${u.pathname}` });
      } catch {}
    });
    const fn = { menu: menuJourney, drawer: drawerJourney, search: searchJourney, collection: collectionJourney, product: productJourney, cart: cartJourney, checkout: checkoutJourney }[journey.id];
    await Promise.race([
      fn ? fn(ctx) : customJourney(ctx, journey),
      sleep(240000).then(() => { throw Object.assign(new Error("took over 4 minutes"), { notChecked: true }); }),
    ]);
  } catch (e) {
    ctx.steps.push({ name: ctx.steps.length ? "the rest of the journey" : "the journey", status: "error", detail: `NOT CHECKED: ${e.message.split("\n")[0]}` });
  } finally {
    // every cart the walk made is emptied, on the store's own domain
    try {
      if (!new URL(page.url()).hostname.endsWith(host)) await page.goto(ctx.url("/cart.js"), { timeout: 30000 }).catch(() => {});
      await ctx.clearCart();
    } catch {}
    if (session) await page.close().catch(() => {});
    else await context.close().catch(() => {});
  }
  return { steps: ctx.steps, problems, blocked };
}


// ------------------------------------------------------------------------- logged-in customers
//
// Each customer in design/journeys.json "customers" is logged in on live and on the preview, each in
// a browser context of its own (the preview's password cookie never reaches live, and two customers
// never share a session). As that customer: the product and cart journeys, every journey marked
// "customers": true, and the price, compare-at price, price labels and add to cart of each product
// page in design/seo-pages.json and design/state-pages.json. Any difference between live and the
// preview for the same customer FAILS. How the customer's prices differ from a guest's on live is
// said as information; with "expect": { "priceDiffersFromGuest": true } guest prices on live FAIL.
// Then the cart is cleared and the customer logged out on both sites. See scripts/qa/customers.mjs.

async function plainPage({ browser, context, base, target }) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.emulate({ ...VIEWPORTS.desktop, userAgent: (await browser.userAgent()).replace("HeadlessChrome", "Chrome") });
  await page.evaluateOnNewDocument(installHelpers);
  if (target === "preview") await applyCookies(page, base.toString());
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const url = r.url();
    // analytics stay blocked, and a sign-in is never followed onto Shopify's own account pages
    if (isTracking(url) || (url !== base.toString() && newAccountsAt(url, base.origin))) return r.abort("blockedbyclient").catch(() => {});
    return r.continue().catch(() => {});
  });
  return page;
}

/** Logs a customer in with Shopify's classic /account/login form. { status: ok | new | error, detail } */
async function logIn({ browser, context, base, target, creds }) {
  const headers = { "user-agent": UA, ...(target === "preview" && cookieHeader() ? { cookie: cookieHeader() } : {}) };
  const kind = await loginKind(withPreview("/account/login", base), { headers });
  if (kind.kind === "new") return { status: "new", detail: NEW_ACCOUNTS };
  if (kind.kind === "error") return { status: "error", detail: `NOT CHECKED: ${kind.detail}` };
  const page = await plainPage({ browser, context, base, target });
  try {
    await page.goto(withPreview("/account/login", base), { waitUntil: "load", timeout: 60000 });
    if (newAccountsAt(page.url(), base.origin)) return { status: "new", detail: NEW_ACCOUNTS };
    if (onPasswordPage(page.url())) return { status: "error", detail: "NOT CHECKED: the store password page came back (set .storefront-password or STOREFRONT_PASSWORD)" };
    const field = async (name) => (await page.$(`form[action*="/account/login"] input[name="customer[${name}]"]`)) || page.$(`input[name="customer[${name}]"]`);
    const email = await field("email"), password = await field("password");
    if (!email || !password) {
      const toNew = await page.evaluate(() => !!document.querySelector('a[href*="shopify.com/"][href*="/account"], a[href*="/customer_authentication"]'));
      return toNew ? { status: "new", detail: NEW_ACCOUNTS } : { status: "error", detail: "NOT CHECKED: no classic login form (customer[email] and customer[password]) on /account/login" };
    }
    await email.click({ clickCount: 3 }).catch(() => {}); await email.type(creds.login);
    await password.click({ clickCount: 3 }).catch(() => {}); await password.type(creds.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 30000 }).catch(() => null),
      password.evaluate((e) => (e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit())),
    ]);
    let where = afterLogin(page.url(), base.origin);
    if (where.status === "ok") {
      await page.goto(withPreview("/account", base), { waitUntil: "load", timeout: 60000 });
      where = afterLogin(page.url(), base.origin);
    }
    if (where.status === "new") return { status: "new", detail: NEW_ACCOUNTS };
    return where.status === "ok" ? { status: "ok" } : { status: "error", detail: `NOT CHECKED: ${where.detail}` };
  } catch (e) {
    return { status: "error", detail: `NOT CHECKED: logging in stopped: ${e.message.split("\n")[0]}` };
  } finally { await page.close().catch(() => {}); }
}

/** Empties the customer's cart (POST /cart/clear.js) and logs them out. { cleared, out } */
async function logOut({ browser, context, base, target }) {
  const page = await plainPage({ browser, context, base, target });
  let cleared = false, out = false;
  try {
    await page.goto(withPreview("/cart.js", base), { timeout: 60000 }).catch(() => {});
    cleared = await page.evaluate(() => fetch("/cart/clear.js", { method: "POST", credentials: "same-origin" }).then((r) => r.ok).then((ok) => ok && fetch("/cart.js", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((j) => j.item_count === 0))).catch(() => false);
    await page.goto(withPreview("/account/logout", base), { waitUntil: "load", timeout: 60000 }).catch(() => {});
    await page.goto(withPreview("/account", base), { waitUntil: "load", timeout: 60000 }).catch(() => {});
    out = /^\/account\/login/.test(new URL(page.url()).pathname);
  } finally { await page.close().catch(() => {}); }
  return { cleared, out };
}

/** The product pages to read prices on: design/seo-pages.json and design/state-pages.json, else the walk's own two. */
export function pricePaths(pages = [], data = {}) {
  const own = pages.map((p) => String(p).split("#")[0]).filter((p) => /^\/products\/[^/?]+/.test(p) && !/FILL-IN/.test(p));
  const found = [data.variantProduct?.handle, data.buy?.handle].filter(Boolean).map((h) => `/products/${h}`);
  return [...new Set(own.length ? own : found)].slice(0, 12);
}

async function readPrices({ browser, context, base, target, paths, selectors }) {
  const page = await plainPage({ browser, context, base, target });
  const out = {};
  try {
    for (const path of paths) {
      try {
        let res;
        for (let t = 0; ; t++) {
          res = await page.goto(withPreview(path, base), { waitUntil: "load", timeout: 60000 });
          if (res?.status() !== 429 || t === 2) break;
          await sleep(Math.min(60, Number(res.headers()["retry-after"]) || 20) * 1000);
        }
        if (onPasswordPage(page.url())) { out[path] = { error: "the store password page came back" }; continue; }
        if (!res || res.status() >= 400) { out[path] = { error: res?.status() === 429 ? "the store kept answering 429 (too many requests)" : `returned ${res?.status() ?? "nothing"}` }; continue; }
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
        out[path] = await page.evaluate(readShownPrice, strategiesFor("price", selectors), strategiesFor("addToCart", selectors));
      } catch (e) { out[path] = { error: `would not load: ${e.message.split("\n")[0]}` }; }
    }
  } finally { await page.close().catch(() => {}); }
  return out;
}

export async function runCustomers({ puppeteer, chrome, cfg, liveBase, previewBase, data, tryJs, only = [], liveComparable = true, log = console.log, resolve = resolveCredentials }) {
  const count = { FAIL: 0, notchecked: 0, pass: 0, "live-too": 0, notfound: 0, none: 0, notreached: 0, problems: 0 };
  if (!liveComparable) {
    log("\nCustomers NOT CHECKED: the live site is not on Shopify yet, so there is no live login to compare with.");
    count.notchecked += cfg.customers.length;
    return count;
  }
  const narrow = only.filter((x) => x !== "customers");
  const journeys = [
    ...["product", "cart"].filter((id) => !cfg.skip[id]).map((id) => ({ id, ...BUILT_INS[id], submit: false })),
    ...cfg.journeys.filter((j) => j.customers).map((j) => ({ ...j, id: null })),
  ].filter((j) => !narrow.length || narrow.includes(j.id) || narrow.includes(j.name));
  const paths = pricePaths(pageList(null, { root: ROOT }), data);
  const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 120000 });
  const browsers = { live: await launch(), preview: await launch() };
  const bases = { live: liveBase, preview: previewBase };
  try {
    const guestContext = await browsers.live.createBrowserContext();
    const guestPrices = await readPrices({ browser: browsers.live, context: guestContext, base: liveBase, target: "live", paths, selectors: cfg.selectors });
    await guestContext.close().catch(() => {});
    for (const c of cfg.customers) {
      log(`\nCustomer ${c.name}, logged in on live and the preview`);
      const creds = await resolve(c);
      if (creds.error) { log(`  NOT CHECKED       ${c.name}: ${creds.error}`); count.notchecked++; continue; }
      const secrets = [creds.login, creds.password];
      const say = (line) => log(redact(line, secrets));
      const sides = {};
      await Promise.all(["live", "preview"].map(async (target) => {
        const browser = browsers[target], base = bases[target];
        const context = await browser.createBrowserContext();
        const side = (sides[target] = { journeys: {}, prices: {}, login: null, logout: null });
        try {
          side.login = await logIn({ browser, context, base, target, creds });
          if (side.login.status !== "ok") return;
          for (const viewport of ["desktop", "phone"]) {
            for (const j of journeys.filter((j) => j.at.includes(viewport))) {
              const run = await runOne({ browser, journey: j, target, base, viewport, data, selectors: cfg.selectors, tryJs, session: { context, name: c.name, secrets } });
              (side.journeys[j.name] ||= {})[viewport] = run;
            }
          }
          side.prices = await readPrices({ browser, context, base, target, paths, selectors: cfg.selectors });
        } catch (e) {
          side.error = e.message.split("\n")[0];
        } finally {
          if (side.login?.status === "ok") side.logout = await logOut({ browser, context, base, target }).catch(() => ({ cleared: false, out: false }));
          await context.close().catch(() => {});
        }
      }));
      const { live, preview } = sides;
      const failedLogin = ["live", "preview"].filter((t) => sides[t].login?.status !== "ok");
      if (failedLogin.length) {
        if (failedLogin.some((t) => sides[t].login?.status === "new")) say(`  ${NEW_ACCOUNTS}`);
        else for (const t of failedLogin) say(`  NOT CHECKED       could not log in on ${t}: ${(sides[t].login?.detail || sides[t].error || "unknown").replace(/^NOT CHECKED: /, "")}`);
        count.notchecked++;
      } else {
        const liveProblems = Object.values(live.journeys).flatMap((r) => Object.values(r).flatMap((v) => v.problems || []));
        for (const j of journeys) for (const viewport of j.at) {
          const l = live.journeys[j.name]?.[viewport], p = preview.journeys[j.name]?.[viewport];
          if (!l && !p) continue;
          say(`  ${j.name} as ${c.name} at ${viewport === "desktop" ? "1440px" : "390px (phone)"}`);
          for (const row of compareJourney(l, p, { liveComparable: true })) {
            count[row.outcome]++;
            const why = row.outcome === "live-too" && row.liveDetail ? row.liveDetail : row.detail;
            say(`    ${SAY[row.outcome].padEnd(17)} ${row.name}  (live ${STATUS[row.live] || "-"}, preview ${STATUS[row.preview] || "-"})${why ? `: ${why}` : ""}`);
            if (row.shot && ["FAIL", "notfound"].includes(row.outcome)) say(`    ${"".padEnd(17)} look: ${row.shot}`);
          }
          for (const pr of newProblems(liveProblems, p?.problems || [], [liveBase.origin, previewBase.origin])) { count.problems++; say(`    ${"FAIL".padEnd(17)} new on the preview, never on live: ${pr}`); }
        }
        const priceRows = comparePrices(live.prices, preview.prices);
        say(`  prices as ${c.name}, live against the preview`);
        for (const r of priceRows) {
          if (r.outcome === "pass") count.pass++;
          say(`    ${(r.outcome === "pass" ? "ok" : r.outcome === "FAIL" ? "FAIL" : "NOT CHECKED").padEnd(17)} ${r.path}: ${r.detail}`);
        }
        const guestRows = compareWithGuest(live.prices, guestPrices, c.name);
        say(`  ${c.name} against a guest on live (information)`);
        for (const r of guestRows) say(`    ${"".padEnd(17)} ${r.path}: ${r.detail}`);
        const v = customerVerdict({ priceRows, guestRows, expect: c.expect, name: c.name });
        count.FAIL += v.fails.length;
        count.notchecked += v.notChecked.length;
        for (const f of v.fails.filter((f) => !f.includes("live and the preview differ"))) say(`    ${"FAIL".padEnd(17)} ${f}`);
        for (const n of v.notChecked.filter((n) => !priceRows.some((r) => n.startsWith(`${r.path}:`)))) say(`    ${"NOT CHECKED".padEnd(17)} ${n}`);
      }
      for (const t of ["live", "preview"]) {
        const o = sides[t].logout;
        if (!o) continue;
        if (o.cleared && o.out) say(`  ${t}: cart cleared and logged out`);
        else { count.notchecked++; say(`  NOT CHECKED       ${t}: ${!o.cleared ? "could not confirm the cart was cleared" : ""}${!o.cleared && !o.out ? " and " : ""}${!o.out ? "could not confirm the log out" : ""}: check the test account by hand`); }
      }
    }
  } finally {
    await Promise.all(Object.values(browsers).map((b) => b.close().catch(() => {})));
  }
  return count;
}

// ------------------------------------------------------------------------------------ the walk

async function json(url, headers = {}) {
  let r;
  for (let t = 0; t < 3; t++) {
    r = await fetch(url, { headers: { "user-agent": UA, ...headers } });
    if (r.status !== 429) break;
    await sleep(Math.min(60, Number(r.headers.get("retry-after")) || 20) * 1000);
  }
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

async function storeData(liveBase, previewBase) {
  const tries = [[liveBase, {}], [previewBase, cookieHeader() ? { cookie: cookieHeader() } : {}]];
  let lastErr;
  for (const [b, headers] of tries) {
    try {
      const { products } = await json(new URL("/products.json?limit=50", b.origin), headers);
      const all = await json(new URL("/collections/all/products.json?limit=1", b.origin), headers).catch(() => ({ products }));
      const seoFile = join(ROOT, "design", "seo-pages.json");
      const pages = existsSync(seoFile) ? JSON.parse(readFileSync(seoFile, "utf8")).pages || [] : [];
      const collection = pages.find((p) => /^\/collections\/[^/?]+/.test(p) && !/FILL-IN/.test(p))?.split("?")[0] || "/collections/all";
      const handle = collection.split("/")[2];
      const inColl = await json(new URL(`/collections/${handle}/products.json?limit=250`, b.origin), headers).then((j) => j.products.length, () => null);
      return { from: b.origin, ...pickProducts(products), searchWord: searchWord(all.products?.[0]?.title), collection, collectionTotal: inColl, liveIsShopify: b === liveBase };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function loadConfig() {
  const file = join(ROOT, "design", "journeys.json");
  if (!existsSync(file)) return validateJourneys(undefined);
  try { return validateJourneys(JSON.parse(readFileSync(file, "utf8"))); } catch (e) { return { errors: [`design/journeys.json is not valid JSON: ${e.message}`] }; }
}

const SAY = { pass: "ok", FAIL: "FAIL", "live-too": "fails on live too", none: "nothing to check", notfound: "NOT FOUND", notchecked: "NOT CHECKED", notreached: "not reached" };
const STATUS = { pass: "pass", fail: "FAIL", notfound: "not found", none: "none", skipped: "-", error: "not checked" };

async function main() {
  const RAW = process.env.PREVIEW_URL || process.argv.find((a) => a.startsWith("http"));
  const LIVE = process.env.LIVE_URL;
  if (!RAW || !LIVE) {
    console.log("Nothing checked. Give it the live site and the preview:");
    console.log("  LIVE_URL='https://<domain>/' PREVIEW_URL='https://<domain>/?preview_theme_id=<id>' npm run journeys");
    process.exit(1);
  }
  const cfg = loadConfig();
  if (cfg.errors.length) { console.log("NOT CHECKED: design/journeys.json has problems, so nothing ran:"); for (const e of cfg.errors) console.log(`  ${e}`); process.exit(1); }
  let puppeteer, Launcher;
  try {
    puppeteer = (await import("puppeteer-core")).default;
    ({ Launcher } = await import("chrome-launcher"));
  } catch { console.log("NOT CHECKED: run npm i -D puppeteer-core chrome-launcher"); process.exit(1); }
  const chrome = Launcher.getInstallations()[0];
  if (!chrome) { console.log("NOT CHECKED: no Chrome found on this machine."); process.exit(1); }
  const previewBase = new URL(RAW), liveBase = new URL(LIVE);
  const tryJs = process.env.JOURNEYS_TRY_JS || "";
  if (tryJs) console.log("JOURNEYS_TRY_JS is set: the preview runs a planted script. This run proves the walk; it does not check the build.\n");
  let data;
  try { data = await storeData(liveBase, previewBase); } catch (e) { console.log(`NOT CHECKED: could not read the store's products (${e.message})`); process.exit(1); }
  const liveComparable = data.liveIsShopify;
  if (!liveComparable) console.log("The live site is not on Shopify yet: the preview is judged on its own.\n");

  const only = (process.env.JOURNEYS_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const journeys = [
    ...Object.entries(BUILT_INS).map(([id, b]) => ({ id, ...b, submit: false })),
    ...cfg.journeys.map((j) => ({ ...j, id: null })),
  ].filter((j) => !only.length || only.includes(j.id) || only.includes(j.name));
  for (const [id, why] of Object.entries(cfg.skip)) console.log(`left out by design/journeys.json: ${BUILT_INS[id].name} (${why})`);
  const todo = journeys.filter((j) => !(j.id && cfg.skip[j.id]));

  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  const origins = [liveBase.origin, previewBase.origin];
  const lanes = [["live", "desktop"], ["live", "phone"], ["preview", "desktop"], ["preview", "phone"]];
  const results = {};
  // One browser per lane, one tab at a time: headless Chrome only renders the front tab. Two
  // lanes at once (live and preview side by side), because four at once had the store answer 429.
  const lane = async ([target, viewport]) => {
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 120000 });
    try {
      for (const j of todo.filter((j) => j.at.includes(viewport))) {
        const run = await runOne({ browser, journey: j, target, base: target === "live" ? liveBase : previewBase, viewport, data, selectors: cfg.selectors, tryJs });
        ((results[j.name] ||= {})[viewport] ||= {})[target] = run;
      }
    } finally { await browser.close().catch(() => {}); }
  };
  for (const viewport of ["desktop", "phone"]) await Promise.all(lanes.filter((l) => l[1] === viewport).map(lane));

  const liveProblems = Object.values(results).flatMap((r) => Object.values(r).flatMap((v) => v.live?.problems || []));
  const count = { FAIL: 0, "live-too": 0, notfound: 0, notchecked: 0, none: 0, pass: 0, notreached: 0, problems: 0 };
  const blockedAll = new Set();
  for (const j of todo) {
    for (const viewport of j.at) {
      const r = results[j.name]?.[viewport];
      if (!r) continue;
      console.log(`\n${j.name} at ${viewport === "desktop" ? "1440px" : "390px (phone)"}`);
      for (const row of compareJourney(r.live, r.preview, { liveComparable })) {
        count[row.outcome]++;
        const sides = liveComparable ? `live ${STATUS[row.live] || "-"}, preview ${STATUS[row.preview] || "-"}` : `preview ${STATUS[row.preview] || "-"}`;
        const why = row.outcome === "live-too" && row.liveDetail ? row.liveDetail : row.detail;
        console.log(`  ${SAY[row.outcome].padEnd(17)} ${row.name}  (${sides})${why ? `: ${why}` : ""}`);
        if (row.shot && ["FAIL", "notfound"].includes(row.outcome)) console.log(`  ${"".padEnd(17)} look: ${row.shot}`);
      }
      for (const p of newProblems(liveProblems, r.preview?.problems || [], origins)) { count.problems++; console.log(`  ${"FAIL".padEnd(17)} new on the preview, never on live: ${p}`); }
      for (const b of r.preview?.blocked || []) blockedAll.add(b);
    }
  }
  if (blockedAll.size) console.log(`\nForm sends blocked (no "submit": true): ${[...blockedAll].slice(0, 5).join(", ")}`);
  if (cfg.customers.length && (!only.length || only.includes("customers"))) {
    const c = await runCustomers({ puppeteer, chrome, cfg, liveBase, previewBase, data, tryJs, only, liveComparable });
    for (const k of Object.keys(count)) count[k] += c[k] || 0;
  }
  const fails = count.FAIL + count.problems;
  console.log(`\n${fails} FAIL, ${count["live-too"]} fail on live too, ${count.notfound} NOT FOUND, ${count.notchecked} not checked, ${count.none} with nothing to check, ${count.pass} ok.`);
  if (count.notfound) console.log("NOT FOUND is never a pass: give the theme's selector in design/journeys.json, or skip that journey there with the reason.");
  if (count["live-too"]) console.log("\"fails on live too\" is not a failure of this build, but the store has it: tell the person.");
  process.exit(fails || count.notfound || count.notchecked ? 1 : 0);
}

if (isMain(import.meta.url)) main();
