// The fast lane (npm run deploy -- --small --page <path>) takes small changes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_LINES, lineChanges, smallNotRun, smallVerdict } from "../scripts/small-change.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const edit = (path, added, removed = []) => ({ path, added, removed });

test("copy and a few lines in one file the theme already runs take the fast lane", () => {
  assert.equal(smallVerdict([{ path: "locales/en.default.json" }]).ok, true);
  assert.equal(smallVerdict([{ path: "locales/en.default.json" }, { path: "locales/fr.json" }]).ok, true);
  assert.equal(smallVerdict([edit("sections/hero.liquid", ["  <h2>{{ 'hero.title' | t }}</h2>"], ["  <h2>Title</h2>"]), { path: "locales/en.default.json" }]).ok, true);
  assert.equal(smallVerdict([edit("assets/base.css", [".card { border-radius: 4px; }"], [".card { border-radius: 2px; }"])]).ok, true, "border is not order");
});

test("anything bigger, newer or near money takes the full deploy", () => {
  const cases = [
    [[], /nothing differs/],
    [[{ path: "templates/index.json" }], /template or settings JSON/],
    [[{ path: "config/settings_data.json" }], /template or settings JSON/],
    [[{ path: "config/settings_schema.json" }], /template or settings JSON/],
    [[{ path: "sections/header-group.json" }], /template or settings JSON/],
    [[edit("sections/main-cart-items.liquid", ["x"])], /money, the cart or checkout/],
    [[edit("snippets/price.liquid", ["x"])], /money, the cart or checkout/],
    [[edit("sections/a.liquid", ["x"]), edit("snippets/b.liquid", ["y"])], /2 code files/],
    [[{ path: "snippets/new.liquid", isNew: true }], /is new/],
    [[{ path: "assets/logo.png", binary: true }], /not a text file/],
    [[edit("sections/a.liquid", Array(MAX_LINES + 1).fill("x"))], /changed lines/],
    [[edit("sections/a.liquid", ["{{ product.compare_at_price | money }}"])], /touches money/],
    [[edit("snippets/card.liquid", ["{% if cart.item_count > 0 %}"])], /touches money/],
    [[{ path: "sections/a.liquid", error: "git missing" }], /could not be compared/],
  ];
  for (const [changes, why] of cases) {
    const v = smallVerdict(changes);
    assert.equal(v.ok, false, JSON.stringify(changes));
    assert.match(v.why, why);
  }
});

test("changed lines are read from the two copies", () => {
  const dir = mkdtempSync(join(tmpdir(), "small-"));
  try {
    writeFileSync(join(dir, "theme.liquid"), "a\nb\nc\n");
    writeFileSync(join(dir, "repo.liquid"), "a\nB\nc\nd\n");
    const c = lineChanges(join(dir, "theme.liquid"), join(dir, "repo.liquid"));
    assert.deepEqual(c.added, ["B", "d"]);
    assert.deepEqual(c.removed, ["b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the QA pass names every walk the fast lane skipped", () => {
  const n = smallNotRun(["/products/a"]);
  for (const w of ["carry-over", "forms", "SEO", "widths", "live comparison", "journeys", "speed"]) assert.ok(n.includes(w), w);
  assert.match(n.at(-1), /every page except \/products\/a/);
});

test("--small without a page, or with --with-json, stops before anything runs", () => {
  const deploy = (...a) => spawnSync(process.execPath, [join(KIT, "scripts", "deploy.mjs"), "--store", "acme.myshopify.com", "--theme", "2", ...a], { encoding: "utf8" });
  const noPage = deploy("--small");
  assert.equal(noPage.status, 1);
  assert.match(noPage.stdout, /needs the page/);
  const json = deploy("--small", "--page", "/", "--with-json");
  assert.equal(json.status, 1);
  assert.match(json.stdout, /cannot go with --with-json/);
});
