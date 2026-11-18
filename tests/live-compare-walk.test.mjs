// The live compare walk's rules, without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunks, compare, expectedFor, mode, norm, report, sameValue, sectionType, summarise } from "../scripts/qa/live-compare-walk.mjs";

const look = (over = {}) => ({ "font-family": "inter", "font-size": "28px", "font-weight": "700", color: "rgb(0, 0, 0)", "letter-spacing": "normal", "text-transform": "none", "line-height": "34px", ...over });
// a page reading as the browser returns it: sections with their innerText, style samples per role
const page = ({ sections = [["header", "Shop\nAbout"], ["image_banner", "Big Sale\nShop now"], ["footer", "Contact us"]], h2 = [look()] } = {}) =>
  summarise({ sections: sections.map(([type, text]) => ({ type, text })), styles: { h2 } });

test("text is compared with spaces made one, invisible characters dropped and case kept", () => {
  assert.equal(norm("  Free  shipping​\n over $99 "), "Free shipping over $99");
  assert.deepEqual(chunks("Big Sale\n\n  Shop   now \nx"), ["Big Sale", "Shop now"]);
  assert.notEqual(norm("SHOP NOW"), norm("Shop now"));
});

test("a section's type is its key without Shopify's instance suffix", () => {
  assert.equal(sectionType("shopify-section-template--123__image_banner_AbC123"), "image_banner");
  assert.equal(sectionType("shopify-section-sections--99__header"), "header");
  assert.equal(sectionType("shopify-section-template--123__slideshow_banner"), "slideshow_banner");
  assert.equal(sectionType("shopify-section-template--123__1741736678bdf55c5b", "cc-apps"), "cc-apps");
});

test("the most common value wins, so one odd element does not decide a role", () => {
  assert.equal(mode(["28px", "28px", "40px"]), "28px");
  assert.equal(summarise({ sections: [], styles: { h2: [look(), look(), look({ "font-size": "40px" })] } }).styles.h2.props["font-size"], "28px");
});

test("half a pixel is rounding, not a change", () => {
  assert.ok(sameValue("28px", "28.4px"));
  assert.ok(!sameValue("28px", "31px"));
  assert.ok(!sameValue("700", "400"));
});

test("the same page twice is the same", () => {
  const r = compare(page(), page(), page());
  assert.deepEqual(r.fails, []);
});

test("text on live that is missing on the preview fails, and text the preview adds is information", () => {
  const preview = page({ sections: [["header", "Shop\nAbout"], ["image_banner", "Big Sale\nShop the range"], ["footer", "Contact us"]] });
  const r = compare(page(), page(), preview);
  assert.deepEqual(r.fails.map((f) => [f.kind, f.subject]), [["text", "Shop now"]]);
  assert.ok(r.info.some((t) => /Shop the range/.test(t)));
});

test("text moved into another section or onto two lines is not missing", () => {
  const preview = page({ sections: [["header", "Shop\nAbout\nContact us"], ["image_banner", "Big\nSale\nShop now"]] });
  const r = compare(page(), page(), preview);
  assert.deepEqual(r.fails.filter((f) => f.kind === "text"), []);
});

test("a section gone fails once, with its text counted under it", () => {
  const preview = page({ sections: [["header", "Shop\nAbout"], ["footer", "Contact us"]] });
  const r = compare(page(), page(), preview);
  assert.deepEqual(r.fails.map((f) => [f.kind, f.subject]), [["section", "image_banner"]]);
  assert.match(r.fails[0].text, /2 lines of text/);
});

test("sections in a different order fail", () => {
  const preview = page({ sections: [["image_banner", "Big Sale\nShop now"], ["header", "Shop\nAbout"], ["footer", "Contact us"]] });
  const r = compare(page(), page(), preview);
  assert.deepEqual(r.fails.map((f) => [f.kind, f.subject]), [["section", "order"]]);
});

test("a style role that differs fails, property by property", () => {
  const preview = page({ h2: [look({ "font-size": "31px", color: "rgb(255, 0, 0)" })] });
  const r = compare(page(), page(), preview);
  assert.deepEqual(r.fails.map((f) => f.subject), ["h2 font-size", "h2 color"]);
  assert.match(r.fails[0].text, /live 28px, preview 31px/);
});

test("an entry in design/live-compare.json turns a difference into an expected one, with its reason", () => {
  const preview = page({ sections: [["header", "Shop\nAbout"], ["footer", "Contact us"]], h2: [look({ "font-size": "31px" })] });
  const expected = [
    { page: "/", kind: "section", match: "image_banner", why: "brief drops the banner" },
    { page: "*", kind: "style", match: "h2", why: "new type scale" },
  ];
  const r = compare(page(), page(), preview, { expected, page: "/", width: 390 });
  assert.deepEqual(r.fails, []);
  assert.deepEqual(r.expected.map((e) => e.why), ["brief drops the banner", "new type scale"]);
  // on another page the section entry does not apply
  assert.equal(compare(page(), page(), preview, { expected, page: "/pages/about", width: 390 }).fails.length, 1);
});

test("an expected entry matches by page, prefix, width, kind and role", () => {
  const list = [{ page: "/products/*", kind: "style", match: "price color", width: 1440 }];
  assert.ok(expectedFor(list, { page: "/products/reel", width: 1440, kind: "style", subject: "price color" }));
  assert.ok(!expectedFor(list, { page: "/products/reel", width: 390, kind: "style", subject: "price color" }));
  assert.ok(!expectedFor(list, { page: "/collections/all", width: 1440, kind: "style", subject: "price color" }));
  assert.ok(!expectedFor(list, { page: "/products/reel", width: 1440, kind: "text", subject: "price color" }));
  assert.ok(expectedFor([{ kind: "style", match: "h2" }], { page: "/", width: 390, kind: "style", subject: "h2 font-size" }));
  assert.ok(!expectedFor([{ kind: "style", match: "h2" }], { page: "/", width: 390, kind: "style", subject: "h22 font-size" }));
});

test("what changed between two loads of live is dynamic: left out and listed, never failed", () => {
  const a = page({ sections: [["header", "Shop\nAbout"], ["image_banner", "Big Sale\nEnds in 03:12:45\n27 reviews"], ["footer", "Contact us"]] });
  const b = page({ sections: [["header", "Shop\nAbout"], ["image_banner", "Big Sale\nEnds in 03:12:40\n28 reviews"], ["footer", "Contact us"]] });
  const preview = page({ sections: [["header", "Shop\nAbout"], ["image_banner", "Big Sale\nEnds in 03:12:38\n28 reviews"], ["footer", "Contact us"]] });
  const r = compare(a, b, preview);
  assert.deepEqual(r.fails, []);
  assert.ok(r.dynamic.includes('text: "Ends in 03:12:45"'));
  assert.ok(r.dynamic.includes('text: "27 reviews"'));
});

test("a real difference still fails beside dynamic text", () => {
  const a = page({ sections: [["image_banner", "Big Sale\n27 reviews"]] });
  const b = page({ sections: [["image_banner", "Big Sale\n28 reviews"]] });
  const preview = page({ sections: [["image_banner", "Huge Sale\n29 reviews"]] });
  assert.deepEqual(compare(a, b, preview).fails.map((f) => f.subject), ["Big Sale"]);
});

test("the report names every page and width, and a page not checked says so", () => {
  const md = report([
    { page: "/", width: 390, ...compare(page(), page(), page({ h2: [look({ "font-size": "31px" })] })) },
    { page: "/cart", width: 1440, error: "gave 500" },
  ], { live: "https://x/", preview: "https://x/?preview_theme_id=1" });
  assert.match(md, /## \/ at 390px/);
  assert.match(md, /h2 font-size: live 28px, preview 31px/);
  assert.match(md, /## \/cart at 1440px\n\nNOT CHECKED: gave 500/);
  assert.doesNotMatch(md, /—/);
});
