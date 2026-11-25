// npm run pages: find the brand's state pages (sold out, on sale, most variants, longest title, an
// empty collection) from the live store and write design/state-pages.json. See page-list.mjs.
//   SHOP_DOMAIN=www.acme.com.au npm run pages     (deploy passes its --domain)
// Two public requests. A store that refuses them (password page, 429) gets the fixed pages only,
// and the run says so: it never claims it found what it could not look for.
//
// A 429 here does not mark the store as limiting this computer (pace.mjs). Shopify limits the
// catalogue .json reads far sooner than ordinary pages, and on 25 Nov 2026 one refused read here
// wrote the 30-minute throttle mark, so every walk after it was skipped and the deploy failed while
// the store's pages were loading fine. The walks still stop on a 429 from a real page.
// A failed look keeps the list already there; with none, the fixed pages are written and marked
// incomplete so the next deploy looks again instead of waiting a month.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FIXED_STATE_PAGES, STATE_FILE, pickStatePages } from "./page-list.mjs";
import { deployTarget } from "../approval.mjs";
import { isMain } from "../platform.mjs";
import { pace } from "./pace.mjs";

async function getJson(url) {
  await pace(url);
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (devote-kit pages)" }, redirect: "follow" });
  if (r.status === 429) throw new Error("Shopify refused the catalogue read (429); the walks still run");
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

export async function findStatePages(domain) {
  const base = `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const problems = [];
  let products = [], collections = [];
  try { products = (await getJson(`${base}/products.json?limit=250`)).products || []; } catch (e) { problems.push(`products: ${e.message}`); }
  try { collections = (await getJson(`${base}/collections.json?limit=250`)).collections || []; } catch (e) { problems.push(`collections: ${e.message}`); }
  return { pages: pickStatePages(products, collections), problems };
}

if (isMain(import.meta.url)) {
  const domain = process.env.SHOP_DOMAIN || deployTarget().domain;
  if (!domain) { console.log("NOT CHECKED: no domain. Set SHOP_DOMAIN or --domain in package.json's deploy script."); process.exit(1); }
  const { pages, problems } = await findStatePages(domain);
  if (problems.length && existsSync(STATE_FILE)) {
    console.log(`\nCould not look for sold-out, sale and other product states: ${problems.join("; ")}. Kept the list already in design/state-pages.json.`);
    process.exit(1);
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ found: new Date().toISOString().slice(0, 10), from: domain, ...(problems.length ? { incomplete: true } : {}), pages }, null, 2) + "\n");
  for (const p of pages) console.log(`  ${p.path}  (${p.why})`);
  const found = pages.length - FIXED_STATE_PAGES.length;
  if (problems.length) {
    console.log(`\nCould not look for sold-out, sale and other product states: ${problems.join("; ")}. Only the fixed pages were written; the next deploy looks again.`);
    process.exit(1);
  }
  console.log(`\n${found} product or collection state page(s) found, plus ${FIXED_STATE_PAGES.length} fixed ones, in design/state-pages.json. Commit it.`);
}
