// Every walk checks the same pages, and the state pages where layout bugs hide are among them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_PATH, FIXED_STATE_PAGES, pageList, pickStatePages, speedPages, statusOk } from "../scripts/qa/page-list.mjs";

const v = (o = {}) => ({ available: true, price: "10.00", compare_at_price: null, ...o });

test("state pages: sold out, on sale, most variants, longest title, empty collection, then the fixed ones", () => {
  const products = [
    { handle: "plain", title: "Cap", variants: [v()] },
    { handle: "gone", title: "Hat", variants: [v({ available: false }), v({ available: false })] },
    { handle: "cheap", title: "Shirt", variants: [v({ compare_at_price: "20.00" })] },
    { handle: "sizes", title: "Jacket", variants: [v(), v(), v(), v()] },
    { handle: "wordy", title: "A very long product title that wraps over several lines on a phone", variants: [v()] },
  ];
  const pages = pickStatePages(products, [{ handle: "full", products_count: 3 }, { handle: "empty", products_count: 0 }]);
  assert.deepEqual(pages.slice(0, 5).map((p) => p.path), ["/products/gone", "/products/cheap", "/products/sizes", "/products/wordy", "/collections/empty"]);
  assert.deepEqual(pages.slice(5).map((p) => p.path), FIXED_STATE_PAGES.map((p) => p.path));
  assert.ok(pages.every((p) => p.why));
});

test("state pages: nothing to find leaves only the fixed pages, never a guess", () => {
  assert.deepEqual(pickStatePages([], []).map((p) => p.path), FIXED_STATE_PAGES.map((p) => p.path));
  const one = pickStatePages([{ handle: "only", title: "x", variants: [v()] }], []);
  assert.equal(one.filter((p) => p.path === "/products/only").length, 1);
});

test("page list: seo pages then state pages, no repeats; an env override wins", () => {
  const root = mkdtempSync(join(tmpdir(), "pages-"));
  mkdirSync(join(root, "design"));
  writeFileSync(join(root, "design", "seo-pages.json"), JSON.stringify({ pages: ["/", "/cart"] }));
  writeFileSync(join(root, "design", "state-pages.json"), JSON.stringify({ pages: [{ path: "/cart" }, { path: "/products/gone" }] }));
  assert.deepEqual(pageList("X_PAGES", { root, env: {} }), ["/", "/cart", "/products/gone"]);
  assert.deepEqual(pageList("X_PAGES", { root, env: { X_PAGES: "/a, /b" } }), ["/a", "/b"]);
  assert.deepEqual(pageList("X_PAGES", { root, env: {}, states: false }), ["/", "/cart"]);
});

test("status: the 404 page must be a 404, every other page under 400", () => {
  assert.equal(statusOk(MISSING_PATH, 404), true);
  assert.equal(statusOk(MISSING_PATH, 200), false);
  assert.equal(statusOk("/products/x", 200), true);
  assert.equal(statusOk("/products/x", 404), false);
  assert.equal(statusOk("/products/x", 429), false);
});

test("speed: home, the first collection and the first product, skipping FILL-IN", () => {
  assert.deepEqual(speedPages(["/", "/collections/FILL-IN", "/collections/all", "/products/a", "/products/b", "/blogs/news"]), ["/", "/collections/all", "/products/a"]);
  assert.deepEqual(speedPages([], "/x,/y"), ["/x", "/y"]);
  assert.deepEqual(speedPages([]), ["/"]);
});
