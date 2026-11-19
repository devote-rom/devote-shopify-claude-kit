// Logged-in customer types for the journeys walk: the list in design/journeys.json, where each
// customer's login comes from, how the walk logs in and out, and how a customer's prices are read
// and judged. journeys-walk.mjs runs it after the guest journeys.
//
// Exists because about 75 findings in a year from a QA tester only showed when logged in as a
// particular customer type, mostly on wholesale and trade stores where customer tags (VIP, trade,
// a country) change prices, labels, what can be bought and what the cart allows. The kit never
// logged in, so none of that was ever checked.
//
// design/journeys.json:
//   "customers": [ { "name": "VIP", "login": "op://<vault>/<item>/username",
//                    "password": "op://<vault>/<item>/password",
//                    "expect": { "priceDiffersFromGuest": true } } ]
// login and password are 1Password references, read at run time with `op read`. A value that is
// not an op:// reference is refused: the file is committed. For CI, JOURNEYS_<NAME>_LOGIN and
// JOURNEYS_<NAME>_PASSWORD (VIP, TRADE_AU) win over the file; they hold the value itself, or an
// op:// reference, and come from the CI's secret store, never from a committed file.
// No credential value is ever printed, logged, written to disk or put into a screenshot or its
// file name: everything said about a customer goes through redact(), and screenshots taken while
// logged in have the login masked on the page first.
//
// The walk never creates an account, never changes account details, addresses or orders, never
// goes past the first checkout step and never places an order. Each customer is logged out and
// their cart cleared (POST /cart/clear.js) on both sites at the end.
import { execFile } from "node:child_process";

export const OP_REF = /^op:\/\/[^/\n]+\/[^/\n]+\/[^\n]+$/;
export const EXPECT_KEYS = ["priceDiffersFromGuest"];
export const NEW_ACCOUNTS = "NOT CHECKED: this store uses Shopify's new customer accounts, which sign in with an emailed code; the walk can't log in";
const KEYS = ["name", "login", "password", "expect", "$comment"];

/** The CI env vars for a customer: VIP gives JOURNEYS_VIP_LOGIN and JOURNEYS_VIP_PASSWORD. */
export function envNames(name) {
  const key = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return { login: `JOURNEYS_${key}_LOGIN`, password: `JOURNEYS_${key}_PASSWORD` };
}

/**
 * design/journeys.json "customers", checked. { errors, customers }. An error never repeats the
 * value it is about: a plain password in the file would otherwise be printed by the walk too.
 */
export function validateCustomers(list) {
  const errors = [], customers = [];
  if (list === undefined) return { errors, customers };
  if (!Array.isArray(list)) return { errors: ["customers must be a list"], customers };
  const keys = new Set();
  list.forEach((c, i) => {
    const where = `customers[${i}]${typeof c?.name === "string" && c.name.trim() ? ` "${c.name}"` : ""}`;
    if (!c || typeof c !== "object" || Array.isArray(c)) { errors.push(`${where}: must be an object`); return; }
    for (const k of Object.keys(c)) if (!KEYS.includes(k)) errors.push(`${where}: unknown key "${k}" (use name, login, password, expect)`);
    if (typeof c.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(c.name)) errors.push(`${where}: needs a name of letters, numbers, spaces, _ or - (it names the env vars and the pictures)`);
    else {
      const k = envNames(c.name).login;
      if (keys.has(k)) errors.push(`${where}: the name is already used`);
      keys.add(k);
    }
    for (const field of ["login", "password"]) {
      if (c[field] === undefined) continue;
      if (typeof c[field] !== "string" || !OP_REF.test(c[field].trim())) {
        errors.push(`${where}: ${field} is not a 1Password reference. Save it in 1Password and put its reference here (op://<vault>/<item>/${field === "login" ? "username" : "password"}), or set ${envNames(c.name || "NAME")[field]} in CI. This file is committed, so a plain value in it is a leak; the value was not printed.`);
      }
    }
    if (c.expect !== undefined) {
      if (!c.expect || typeof c.expect !== "object" || Array.isArray(c.expect)) errors.push(`${where}: expect must be an object such as { "priceDiffersFromGuest": true }`);
      else for (const [k, v] of Object.entries(c.expect)) {
        if (!EXPECT_KEYS.includes(k)) errors.push(`${where}: expect "${k}" is not known (${EXPECT_KEYS.join(", ")})`);
        else if (typeof v !== "boolean") errors.push(`${where}: expect "${k}" must be true or false`);
      }
    }
    customers.push({ name: c.name, login: c.login?.trim?.(), password: c.password?.trim?.(), expect: { ...(c.expect || {}) } });
  });
  return { errors, customers: errors.length ? [] : customers };
}

/** Why `op read` failed, in words, from its error and stderr. Never includes stderr itself. */
export function opProblem(err, stderr = "") {
  if (err?.code === "ENOENT") return "the 1Password CLI (op) is not installed on this machine";
  if (err?.killed || err?.signal === "SIGTERM") return "op read did not answer in time (a 1Password unlock prompt left waiting?)";
  const s = String(stderr);
  if (/not signed in|no accounts? (are )?(configured|found)|session (has )?expired|session is invalid|authori[sz]ation (timeout|prompt dismissed|denied)|sign ?in/i.test(s)) return "op is not signed in to 1Password (open the 1Password app and unlock it, or run op signin)";
  if (/isn't a vault|isn't an item|isn't a field|could not find|no item|not found|does not exist|invalid secret reference/i.test(s)) return "1Password has no vault, item or field for that reference";
  return "op read failed";
}

/** Reads one op:// reference. { value } or { error }. Nothing from op is printed. */
export function opRead(ref, { bin = process.env.JOURNEYS_OP_BIN || "op", timeout = 120000, run = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      run(bin, ["read", "--no-newline", ref], { timeout, encoding: "utf8", maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve({ error: opProblem(err, stderr) });
        const value = String(stdout ?? "");
        resolve(value ? { value } : { error: "1Password gave back an empty value" });
      });
    } catch (e) { resolve({ error: opProblem(e) }); }
  });
}

/**
 * A customer's login and password, from the env vars first (CI), then the file's op:// references.
 * { login, password } or { error }: an error is NOT CHECKED for that customer, never a skip.
 */
export async function resolveCredentials(customer, { env = process.env, read = opRead } = {}) {
  const names = envNames(customer.name);
  const out = {};
  for (const field of ["login", "password"]) {
    const fromEnv = env[names[field]];
    const source = fromEnv ? fromEnv : customer[field];
    if (!source) return { error: `no ${field}: give "${field}" as an op:// reference in design/journeys.json, or set ${names[field]}` };
    if (OP_REF.test(source)) {
      const r = await read(source);
      if (r.error) return { error: `could not read the ${field} from 1Password: ${r.error}` };
      out[field] = r.value;
    } else if (fromEnv) out[field] = fromEnv;
    else return { error: `${field} is not a 1Password reference` };
  }
  return out;
}

/** Text with every credential value (and its URL-encoded form) replaced by [hidden]. */
export function redact(text, secrets = []) {
  let t = String(text ?? "");
  for (const s of secrets) {
    if (typeof s !== "string" || !s) continue;
    for (const form of new Set([s, encodeURIComponent(s), s.replace(/@/g, "%40")])) t = t.split(form).join("[hidden]");
  }
  return t;
}

/**
 * True when a login address or redirect points at Shopify's new customer accounts: the
 * shopify.com/<shop id>/account sign-in, its /authentication pages, or the store's own
 * /customer_authentication hop that leads there.
 */
export function newAccountsAt(location, origin) {
  let u;
  try { u = new URL(location, origin); } catch { return false; }
  if (/(^|\.)shopify\.com$/i.test(u.hostname) && /^\/(\d+\/account|authentication)(\/|$)/i.test(u.pathname)) return true;
  return /^\/customer_authentication(\/|$)/i.test(u.pathname);
}

/**
 * Follows /account/login's redirects without leaving the store's own address, to tell classic
 * customer accounts (a form) from new ones (a code by email). { kind: "classic" | "new" | "error", detail }
 */
export async function loginKind(loginUrl, { headers = {}, fetchFn = fetch, maxHops = 5 } = {}) {
  let url = loginUrl;
  const origin = new URL(loginUrl).origin;
  for (let hop = 0; hop <= maxHops; hop++) {
    let r;
    try { r = await fetchFn(url, { redirect: "manual", headers }); } catch (e) { return { kind: "error", detail: `/account/login would not load: ${e.message}` }; }
    await r.arrayBuffer?.().catch(() => {});
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      if (newAccountsAt(loc, url)) return { kind: "new" };
      const next = new URL(loc, url);
      if (next.origin !== origin) return { kind: "error", detail: `/account/login sends visitors to ${next.origin}` };
      url = next.toString();
      continue;
    }
    if (r.status === 429) return { kind: "error", detail: "the store answered 429 (too many requests) for /account/login; run the walk again in a few minutes" };
    if (r.status >= 400) return { kind: "error", detail: `/account/login returned ${r.status}` };
    return { kind: "classic" };
  }
  return { kind: "error", detail: "/account/login redirects too many times" };
}

/** Where a page went after the login form was sent: ok, refused, captcha, new accounts or the password page. */
export function afterLogin(url, origin) {
  if (newAccountsAt(url, origin)) return { status: "new" };
  let u;
  try { u = new URL(url); } catch { return { status: "refused" }; }
  if (/^\/challenge(\/|$)/.test(u.pathname)) return { status: "captcha", detail: "Shopify asked for a captcha at login; the walk does not get around it. Run it again later" };
  if (/^\/password\/?$/.test(u.pathname)) return { status: "password", detail: "the store password page came back (set .storefront-password or STOREFRONT_PASSWORD)" };
  if (/^\/account\/login/.test(u.pathname)) return { status: "refused", detail: "the store refused the login: check the 1Password item, and that the account was activated on the store" };
  return { status: "ok" };
}

// ------------------------------------------------------------------------------- prices

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** One product page as a customer sees it, in words: "$80.00, compare at $100.00, labels VIP price, can be bought". */
export function describePrice(r) {
  if (!r || r.error) return r?.error || "not read";
  const parts = [r.price || "no price shown"];
  if (r.compareAt) parts.push(`compare at ${r.compareAt}`);
  if (r.labels?.length) parts.push(`labels ${r.labels.map((l) => `"${l}"`).join(", ")}`);
  parts.push(r.buyable === true ? "can be added to the cart" : r.buyable === false ? "cannot be added to the cart" : "no add to cart button");
  return parts.join(", ");
}

/** The fields that differ between two readings of the same page, in words, or []. */
export function priceDifferences(a, b, [nameA, nameB] = ["live", "preview"]) {
  const out = [];
  const say = (v) => (v === undefined || v === null || v === "" ? "nothing" : `"${v}"`);
  if (norm(a.price) !== norm(b.price)) out.push(`price: ${nameA} ${say(a.price)}, ${nameB} ${say(b.price)}`);
  if (norm(a.compareAt) !== norm(b.compareAt)) out.push(`compare at: ${nameA} ${say(a.compareAt)}, ${nameB} ${say(b.compareAt)}`);
  const la = (a.labels || []).map(norm).join(" | "), lb = (b.labels || []).map(norm).join(" | ");
  if (la !== lb) out.push(`labels: ${nameA} ${say(la)}, ${nameB} ${say(lb)}`);
  if (a.buyable !== b.buyable) out.push(`add to cart: ${nameA} ${a.buyable === true ? "works" : a.buyable === false ? "off" : "missing"}, ${nameB} ${b.buyable === true ? "works" : b.buyable === false ? "off" : "missing"}`);
  return out;
}

/** Live against the preview for one customer, page by page: pass, FAIL or notchecked. */
export function comparePrices(live = {}, preview = {}) {
  const paths = [...new Set([...Object.keys(live), ...Object.keys(preview)])];
  return paths.map((path) => {
    const l = live[path], p = preview[path];
    if (!l || l.error || !p || p.error) return { path, outcome: "notchecked", detail: `NOT CHECKED: ${(!l || l.error) ? `live: ${l?.error || "not read"}` : `preview: ${p?.error || "not read"}`}` };
    const d = priceDifferences(l, p);
    return d.length ? { path, outcome: "FAIL", detail: d.join("; ") } : { path, outcome: "pass", detail: describePrice(p) };
  });
}

/** The customer against a guest on live, page by page: information, and the evidence for priceDiffersFromGuest. */
export function compareWithGuest(customerLive = {}, guestLive = {}, name = "the customer") {
  return Object.keys(customerLive).map((path) => {
    const c = customerLive[path], g = guestLive[path];
    if (!c || c.error || !g || g.error) return { path, readable: false, same: null, detail: "could not compare with a guest" };
    const d = priceDifferences(g, c, ["guest", name]);
    return { path, readable: true, same: d.length === 0, detail: d.length ? d.join("; ") : "the same as a guest" };
  });
}

/**
 * The customer's price verdict: FAIL on any live/preview difference, FAIL when a difference from
 * guests is expected and live shows guest prices on every page, NOT CHECKED when nothing could be read.
 */
export function customerVerdict({ priceRows = [], guestRows = [], expect = {}, name = "the customer" }) {
  const fails = [], notChecked = [];
  for (const r of priceRows) if (r.outcome === "FAIL") fails.push(`${r.path}: live and the preview differ for ${name}: ${r.detail}`);
  for (const r of priceRows) if (r.outcome === "notchecked") notChecked.push(`${r.path}: ${r.detail}`);
  if (!priceRows.length) notChecked.push("no product pages to read prices on (design/seo-pages.json or design/state-pages.json)");
  if (expect.priceDiffersFromGuest) {
    const readable = guestRows.filter((r) => r.readable);
    if (!readable.length) notChecked.push(`could not compare ${name}'s prices with a guest's on live`);
    else if (readable.every((r) => r.same)) fails.push(`live shows ${name} the same prices as a guest on every page read, and design/journeys.json expects them to differ. The test account is probably missing its tag on the store, which makes every check as ${name} meaningless`);
  }
  return { fails, notChecked };
}

// --------------------------------------------------------------------------- in the browser

/** Runs in the page: the shown price, compare-at price, price labels and whether it can be bought. */
export function readShownPrice(priceSelectors, addSelectors) {
  const dj = window.__dj;
  const main = dj.main();
  const text = (e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
  let box = null;
  for (const s of priceSelectors) { try { box = [...main.querySelectorAll(s)].find(dj.laid); } catch {} if (box) break; }
  let add = null;
  for (const s of addSelectors) { try { add = [...main.querySelectorAll(s)].find(dj.laid); } catch {} if (add) break; }
  // the product's own area: the nearest parent of the price that also holds the add to cart button
  let area = box || main;
  while (area && area !== main && add && !area.contains(add)) area = area.parentElement;
  area = area || main;
  const cmp = box && [...box.querySelectorAll('s, del, [class*="compare" i], [class*="regular" i], [class*="was" i]')].find((e) => dj.laid(e) && /\d/.test(text(e)));
  const compareAt = cmp ? text(cmp) : "";
  const price = box ? text(box).split(compareAt || "\u0000").join(" ").replace(/\s+/g, " ").trim() : "";
  const words = /(price|save|off\b|%|member|vip|trade|wholesale|rrp|was\b|incl|excl|gst|tax|sale|login to|log in to|sign in to)/i;
  const labels = new Set();
  for (const e of area.querySelectorAll('[class*="badge" i], [class*="sticker" i], [class*="label" i]:not(label):not(input), [class*="tag" i]:not(a), [class*="unit-price" i], [class*="tax" i], [class*="note" i]')) {
    if (!dj.laid(e) || (box && box.contains(e)) || (add && (e.contains(add) || add.contains(e)))) continue;
    const t = text(e);
    if (t && t.length <= 60) labels.add(t);
  }
  for (const e of area.querySelectorAll("p, span, small, div, strong, em")) {
    if (e.children.length || !dj.laid(e) || (box && box.contains(e)) || (add && add.contains(e))) continue;
    const t = text(e);
    if (t && t.length <= 60 && words.test(t)) labels.add(t);
  }
  const buyable = add ? !(add.disabled || add.getAttribute("aria-disabled") === "true" || /sold out|unavailable|out of stock/i.test(text(add))) : null;
  return { price, compareAt, labels: [...labels].sort(), buyable };
}

/** Runs in the page: every place the credentials show (text, input values) masked before a picture. */
export function maskOnPage(secrets) {
  const hide = (s) => { let t = s; for (const v of secrets) if (v) t = t.split(v).join("••••"); return t; };
  const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (secrets.some((v) => v && n.nodeValue.includes(v))) n.nodeValue = hide(n.nodeValue);
  for (const i of document.querySelectorAll("input, textarea")) if (secrets.some((v) => v && String(i.value).includes(v))) i.value = hide(i.value);
}
