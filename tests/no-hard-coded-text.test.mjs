// The hard-coded text guard's rules, and the proof: a section with typed-in copy fails, and the
// same section with its copy in settings passes. Run with: node --test tests/
//
// If you change a rule in scripts/qa/no-hard-coded-text.mjs, change its case here in the same commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findHardCoded, addedFindings, countKeys, isAllowed } from "../scripts/qa/no-hard-coded-text.mjs";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "qa", "no-hard-coded-text.mjs");
const texts = (src) => findHardCoded(src).map((f) => f.text);

test("flags what one build shipped: text, labels and store details typed into Liquid", () => {
  const src = [
    '<p class="note">Order by 2pm for same-day dispatch</p>',
    "<address>12 Example St, Cairns QLD 4870</address>",
    "<a href=\"tel:0700000000\">07 0000 0000</a>",
    "<button>Remove</button>",
    "<span>{{ cart.item_count }} items</span>",
    '<input type="search" placeholder="Search products">',
    '<img src="{{ img | image_url: width: 400 }}" alt="Store front">',
    '<button aria-label="Close">{% render "icon-close" %}</button>',
    '<input type="submit" value="Subscribe">',
    "{{ 'Shop now' }}",
    "{{ section.settings.heading | default: 'Our story' }}",
    "{% render 'button', label: 'Shop now', style: 'primary' %}",
    "{% liquid\n  assign button_text = 'Add to cart'\n  echo 'Free shipping'\n%}",
  ].join("\n");
  const got = texts(src);
  for (const t of ["Order by 2pm for same-day dispatch", "12 Example St, Cairns QLD 4870", "Remove", "items",
    "Search products", "Store front", "Close", "Subscribe", "Shop now", "Our story", "Add to cart", "Free shipping"]) {
    assert.ok(got.includes(t), `missed "${t}" (got ${JSON.stringify(got)})`);
  }
  assert.ok(!got.includes("primary"), "a style name is not a label");
  assert.equal(findHardCoded(src).find((f) => f.text === "Remove").line, 4);
  assert.equal(findHardCoded(src).find((f) => f.text === "Add to cart").line, 14);
});

test("passes settings, translations, schema, code and punctuation", () => {
  const src = [
    "<h2>{{ section.settings.heading | escape }}</h2>",
    "<p>{{ settings.store_phone | escape }}</p>",
    "<button>{{ 'products.product.add_to_cart' | t }}</button>",
    "<span>{{ 'cart.items_left' | t: count: cart.item_count }}</span>",
    '<img alt="{{ image.alt | escape }}" src="{{ image | image_url: width: 400 }}">',
    '<button aria-label="{{ \'accessibility.close\' | t }}">&times;</button>',
    "<span>&nbsp;|&nbsp;</span> <span>/</span> <span>{{ a }} &ndash; {{ b }}</span> <span>(12)</span> <span>{{ w }} x {{ h }}</span>",
    "{{ 'component-cart.css' | asset_url | stylesheet_tag }} {{ 'icon-close.svg' | inline_asset_content }}",
    "<div class=\"{% if x %}is-active{% endif %} grid--{{ n }}\"></div>",
    "{% capture css %}.a { color: {{ c }}; } width: 100%;{% endcapture %}",
    "{%- if a -%}true{%- else -%}false{%- endif -%}",
    "{% assign heading_tag = 'h2' %}{% if product.type == 'Fishing Rods' %}{% endif %}",
    "<script>const label = 'Added to cart';</script>",
    "<style>.x::after { content: 'New'; }</style>",
    "{% comment %}Shown under the price{% endcomment %}<!-- old banner -->",
    '{% schema %}{ "name": "Promo", "settings": [{ "type": "text", "id": "heading", "default": "Big sale" }] }{% endschema %}',
  ].join("\n");
  assert.deepEqual(findHardCoded(src), []);
});

test("an exception passes only with the marker and a reason", () => {
  assert.deepEqual(texts("{% # hard-coded-ok: brand name, never changes %}\n<span>Devote</span>"), []);
  assert.deepEqual(texts("<span>Devote</span>{% # hard-coded-ok: brand name %}"), []);
  assert.deepEqual(texts("{% # hard-coded-ok %}\n<span>Devote</span>"), ["Devote"]);
});

test("allowlist: punctuation, entities, numbers and separators carry no words", () => {
  for (const t of ["&nbsp;", " | ", "/", "&mdash;", "(3)", "4.5", "x", "•", "&#10095;", "100%"]) assert.ok(isAllowed(t), t);
  for (const t of ["Free shipping", "or", "Filter", "QLD"]) assert.ok(!isAllowed(t), t);
});

test("text the theme already had is inherited; only what the build adds fails", () => {
  const before = "<p>Sold out</p><p>Sold out</p>";
  const after = "<p>Sold out</p><p>Sold out</p><p>Sold out</p><p>Ships today</p>";
  const added = addedFindings(findHardCoded(after), countKeys(findHardCoded(before)));
  assert.deepEqual(added.map((f) => f.text), ["Sold out", "Ships today"]);
});

test("the guard fails a new section with typed-in copy, then passes once the copy is in settings", () => {
  const repo = mkdtempSync(join(tmpdir(), "hard-coded-"));
  try {
    // A git hook sets GIT_DIR and GIT_INDEX_FILE. Inherited, `git init` here re-initialises the
    // kit's own repo as bare (it did, the first time this ran from the pre-commit hook).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const sh = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env });
    for (const d of ["sections", "snippets", "blocks", "scripts/qa"]) mkdirSync(join(repo, d), { recursive: true });
    copyFileSync(GUARD, join(repo, "scripts", "qa", "no-hard-coded-text.mjs"));
    // The theme as first pulled already has some typed-in text. That is inherited, not this build's.
    writeFileSync(join(repo, "sections", "old-footer.liquid"), "<p>Copyright</p>\n");
    sh("init", "-q"); sh("add", "-A");
    sh("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "The live theme as it stood");
    const run = () => spawnSync(process.execPath, [join(repo, "scripts", "qa", "no-hard-coded-text.mjs")], { encoding: "utf8", env });

    assert.equal(run().status, 0, "the theme as pulled passes");

    writeFileSync(join(repo, "sections", "store-info.liquid"), [
      "<div class=\"store-info\">",
      "  <h2>Visit Us</h2>",
      "  <p>Open 7 days, 8am to 5pm</p>",
      "  <a href=\"tel:0700000000\">Call 07 0000 0000</a>",
      "</div>",
      '{% schema %}{ "name": "Store info", "settings": [] }{% endschema %}',
    ].join("\n"));
    let r = run();
    assert.equal(r.status, 1, "hard-coded copy fails");
    assert.match(r.stdout, /sections\/store-info\.liquid:2: text "Visit Us"/);
    assert.match(r.stdout, /sections\/store-info\.liquid:3: text "Open 7 days, 8am to 5pm"/);
    assert.match(r.stdout, /sections\/store-info\.liquid:4: text "Call 07 0000 0000"/);
    assert.doesNotMatch(r.stdout, /old-footer/, "inherited text is not this build's");

    writeFileSync(join(repo, "sections", "store-info.liquid"), [
      "<div class=\"store-info\">",
      "  <h2>{{ section.settings.heading | escape }}</h2>",
      "  <p>{{ settings.store_hours | escape }}</p>",
      "  <a href=\"tel:{{ settings.store_phone | remove: ' ' }}\">{{ section.settings.call_label | replace: '[phone]', settings.store_phone | escape }}</a>",
      "</div>",
      '{% schema %}{ "name": "Store info", "settings": [',
      '  { "type": "text", "id": "heading", "label": "Heading", "default": "Visit Us" },',
      '  { "type": "text", "id": "call_label", "label": "Call label", "default": "Call [phone]" }',
      "] }{% endschema %}",
    ].join("\n"));
    r = run();
    assert.equal(r.status, 0, `copy in settings passes (got: ${r.stdout})`);

    // An inherited file the build edits: only the new line fails.
    writeFileSync(join(repo, "sections", "old-footer.liquid"), "<p>Copyright</p>\n<p>Made in Cairns</p>\n");
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /sections\/old-footer\.liquid:2: text "Made in Cairns"/);
    assert.doesNotMatch(r.stdout, /Copyright/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
