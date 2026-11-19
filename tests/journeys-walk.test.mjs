// The journeys walk's rules, without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cartCountFrom, compareJourney, isFormSend, isTracking, moneyMatches, newProblems, parseStep, pickProducts,
  pickVariantChange, problemKey, searchWord, stepLabel, stepVerdict, strategiesFor, STRATEGIES, validateJourneys,
} from "../scripts/qa/journeys-walk.mjs";

test("steps: one action each, with what that action needs", () => {
  assert.deepEqual(parseStep({ click: ".size-guide" }), { kind: "click", arg: ".size-guide" });
  assert.deepEqual(parseStep({ type: "input[name=q]", text: "shorts" }), { kind: "type", arg: "input[name=q]", text: "shorts" });
  assert.deepEqual(parseStep({ wait: 500 }), { kind: "wait", arg: 500 });
  assert.deepEqual(parseStep({ expectCartCount: 0 }), { kind: "expectCartCount", arg: 0 });
  assert.match(parseStep({ click: "a", hover: "b" }).error, /one action per step/);
  assert.match(parseStep({ tap: "a" }).error, /no action/);
  assert.match(parseStep({ type: "input" }).error, /needs "text"/);
  assert.match(parseStep({ select: "select" }).error, /needs "value"/);
  assert.match(parseStep({ goto: "https://elsewhere.com" }).error, /starting with \//);
  assert.match(parseStep({ wait: 60000 }).error, /up to 30000/);
  assert.match(parseStep({ expectCartCount: 1.5 }).error, /whole number/);
  assert.match(parseStep({ click: "a", text: "x" }).error, /does not take text/);
  assert.match(parseStep("click a").error, /must be an object/);
});

test("step labels read as plain English", () => {
  assert.equal(stepLabel(parseStep({ type: "#q", text: "fins" })), 'type "fins" into #q');
  assert.equal(stepLabel(parseStep({ expectText: "Thanks" })), 'the page says "Thanks"');
  assert.equal(stepLabel(parseStep({ expectCartCount: 2 })), "the cart holds 2");
  assert.equal(stepLabel({ ...parseStep({ click: ".x" }), name: "open the size guide" }), "open the size guide");
});

test("journeys.json: a good file passes and fills in the defaults", () => {
  const v = validateJourneys({
    skip: { drawer: "the nav is always shown, there is no phone menu" },
    selectors: { addToCart: "#buy", cartCount: [".bag-count", ".bag"] },
    journeys: [{ name: "Size guide opens", steps: [{ goto: "/products/a" }, { click: ".size-guide" }, { expectVisible: ".size-guide-modal" }] }],
  });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.journeys[0].at, ["desktop", "phone"]);
  assert.equal(v.journeys[0].submit, false);
  assert.equal(v.skip.drawer.length > 5, true);
  assert.deepEqual(validateJourneys(undefined), { errors: [], journeys: [], skip: {}, selectors: {}, customers: [] });
});

test("journeys.json: every mistake is named, and nothing runs", () => {
  const v = validateJourneys({
    skips: {},
    skip: { search: "", basket: "it has none at all" },
    selectors: { buyButton: "#buy", addToCart: 3 },
    journeys: [
      { name: "A", at: "tablet", steps: [{ click: "a" }] },
      { name: "A", steps: [{ click: "a" }] },
      { name: "cart", steps: [{ click: "a" }] },
      { steps: [] },
      { name: "Newsletter", steps: [{ type: "#email", text: "test@example.com" }, { submit: "#newsletter" }] },
    ],
  });
  const all = v.errors.join("\n");
  for (const re of [/unknown key "skips"/, /"search" needs a reason/, /"basket" is not a built-in/, /"buyButton" is not a role/, /"addToCart" takes a selector/,
    /at must be desktop, phone or both/, /the name is already used/, /needs a name/, /needs a list of steps/, /a submit step needs "submit": true/]) assert.match(all, re);
  assert.deepEqual(v.skip, {});
  assert.deepEqual(v.selectors, {});
});

test("journeys.json: submit is allowed only on a journey that says so", () => {
  const v = validateJourneys({ journeys: [{ name: "Test sign-up", submit: true, at: "desktop", steps: [{ type: "#email", text: "test@example.com" }, { submit: "#newsletter" }] }] });
  assert.deepEqual(v.errors, []);
  assert.equal(v.journeys[0].submit, true);
  assert.deepEqual(v.journeys[0].at, ["desktop"]);
});

test("selectors: a brand's own come first, then the kit's, each once", () => {
  const list = strategiesFor("addToCart", { addToCart: ["#buy", 'button[name="add"]'] });
  assert.deepEqual(list.slice(0, 2), ["#buy", 'button[name="add"]']);
  assert.equal(list.filter((s) => s === 'button[name="add"]').length, 1);
  assert.deepEqual(strategiesFor("addToCart"), STRATEGIES.addToCart);
  assert.deepEqual(strategiesFor("cartCount", { cartCount: ".bag" })[0], ".bag");
  assert.deepEqual(strategiesFor("nothing"), []);
  // Shopify's own conventions come before guesses at class names
  assert.ok(STRATEGIES.addToCart[0].includes("/cart/add"));
  assert.ok(STRATEGIES.filterOption[0].includes('name^="filter."'));
});

test("verdict: passes live and fails the preview is a FAIL; fails both is listed only", () => {
  assert.equal(stepVerdict("pass", "pass"), "pass");
  assert.equal(stepVerdict("pass", "fail"), "FAIL");
  assert.equal(stepVerdict("fail", "fail"), "live-too");
  assert.equal(stepVerdict("fail", "pass"), "pass");
  assert.equal(stepVerdict("pass", "notfound"), "FAIL");
  assert.equal(stepVerdict("notfound", "notfound"), "notfound");
  assert.equal(stepVerdict("pass", "none"), "FAIL");
  assert.equal(stepVerdict("none", "none"), "none");
  assert.equal(stepVerdict("pass", "error"), "notchecked");
  assert.equal(stepVerdict("pass", "skipped"), "notreached");
});

test("verdict: with no live site to compare (not on Shopify yet), the preview is judged on its own", () => {
  assert.equal(stepVerdict("fail", "fail", { liveComparable: false }), "FAIL");
  assert.equal(stepVerdict("error", "fail"), "FAIL");
  assert.equal(stepVerdict(undefined, "pass", { liveComparable: false }), "pass");
});

test("a journey's steps line up by name; a step live has and the preview lacks is a FAIL", () => {
  const live = { steps: [{ name: "Tops opens", status: "pass" }, { name: "Shorts opens", status: "pass" }] };
  const preview = { steps: [{ name: "Tops opens", status: "pass" }] };
  const rows = compareJourney(live, preview);
  assert.deepEqual(rows.map((r) => [r.name, r.outcome]), [["Tops opens", "pass"], ["Shorts opens", "FAIL"]]);
  assert.match(rows[1].detail, /not on the preview/);
});

test("after a preview step fails, the steps it never reached are not counted again", () => {
  const live = { steps: [{ name: "add", status: "pass" }, { name: "count", status: "pass" }, { name: "remove", status: "pass" }] };
  const preview = { steps: [{ name: "add", status: "fail", detail: "pressed, and /cart.js still holds nothing" }] };
  assert.deepEqual(compareJourney(live, preview).map((r) => r.outcome), ["FAIL", "notreached", "notreached"]);
});

test("a live run that could not be checked leaves the preview judged alone", () => {
  const live = { steps: [{ name: "the journey", status: "error" }] };
  const preview = { steps: [{ name: "add", status: "fail" }] };
  const rows = compareJourney(live, preview);
  assert.equal(rows.find((r) => r.name === "add").outcome, "FAIL");
});

test("new problems: only what the preview has and live never had, ignoring domains, ids and line numbers", () => {
  const origins = ["https://shop.example.com"];
  const live = [{ kind: "JS error", text: "Cannot read properties of null (reading 'x') at https://shop.example.com/cdn/theme.js?v=12345:10:20" }, { kind: "404 from", text: "GET /products/a/1234567.json" }];
  const preview = [
    { kind: "JS error", text: "Cannot read properties of null (reading 'x') at https://shop.example.com/cdn/theme.js?v=99999:11:3" },
    { kind: "404 from", text: "GET /products/a/7654321.json" },
    { kind: "JS error", text: "cartDrawer is not defined" },
    { kind: "JS error", text: "cartDrawer is not defined" },
    { kind: "500 from", text: "POST /cart/change.js" },
  ];
  assert.deepEqual(newProblems(live, preview, origins), ["JS error: cartDrawer is not defined", "500 from: POST /cart/change.js"]);
  assert.deepEqual(newProblems(live, [], origins), []);
  assert.equal(problemKey({ kind: "console error", text: "a\nstack line" }), "console error: a");
});

test("form sends are blocked unless the journey says submit; add to cart and checkout are not form sends", () => {
  assert.ok(isFormSend({ url: "https://shop.example.com/contact", method: "POST" }));
  assert.ok(isFormSend({ url: "https://shop.example.com/account/register", method: "POST" }));
  assert.ok(isFormSend({ url: "https://a.klaviyo.com/client/subscriptions/?company_id=x", method: "POST" }));
  assert.ok(isFormSend({ url: "https://a.klaviyo.com/client/back-in-stock-subscriptions/", method: "POST" }));
  assert.ok(isFormSend({ url: "https://shop.example.com/", method: "POST", postData: "form_type=customer&contact%5Bemail%5D=x" }));
  assert.ok(!isFormSend({ url: "https://shop.example.com/contact", method: "GET" }));
  assert.ok(!isFormSend({ url: "https://shop.example.com/cart/add.js", method: "POST", postData: "form_type=product&id=1" }));
  assert.ok(!isFormSend({ url: "https://shop.example.com/cart", method: "POST", postData: "checkout=" }));
  assert.ok(!isFormSend({ url: "https://shop.example.com/cart/clear.js", method: "POST" }));
});

test("analytics and ad beacons are blocked, the store's own pages and scripts are not", () => {
  for (const u of ["https://www.google-analytics.com/g/collect?v=2", "https://region1.analytics.google.com/g/collect", "https://www.facebook.com/tr/?id=1&ev=AddToCart",
    "https://shop.example.com/.well-known/shopify/monorail/unstable/produce_batch", "https://a.klaviyo.com/client/events/?company_id=x", "https://analytics.tiktok.com/api/v2/pixel"]) assert.ok(isTracking(u), u);
  for (const u of ["https://shop.example.com/cart.js", "https://www.googletagmanager.com/gtm.js?id=GTM-X", "https://connect.facebook.net/en_US/fbevents.js", "https://shop.example.com/collections/all"]) assert.ok(!isTracking(u), u);
});

test("a word to search for comes from the first product title", () => {
  assert.equal(searchWord("The High Waist Bike Shorts"), "high");
  assert.equal(searchWord("Néoprène Wetsuit 3mm"), "neoprene");
  assert.equal(searchWord("XL"), null);
});

test("variant change: the nearest in-stock variant, and the nearest sold-out one", () => {
  const v = (id, o1, o2, available, price = 5000) => ({ id, option1: o1, option2: o2, option3: null, available, price });
  const product = { variants: [v(1, "Black", "S", true), v(2, "Black", "M", true, 5500), v(3, "Red", "S", true), v(4, "Black", "L", false), v(5, "Red", "L", false)] };
  const p = pickVariantChange(product, "1");
  assert.equal(p.from.id, 1);
  assert.equal(p.to.id, 2); // one option changed, and a different price shows the price really moved
  assert.equal(p.soldOut.id, 4);
  assert.equal(pickVariantChange(product, null).from.id, 1);
  assert.equal(pickVariantChange({ variants: [v(1, "S", null, true)] }, 1).to, null);
});

test("products to test: two variants in stock, a sold-out one preferred; and one to buy", () => {
  const p = (handle, avail) => ({ handle, variants: avail.map((a, i) => ({ id: i + 1, available: a })) });
  const r = pickProducts([p("single", [true]), p("two", [true, true]), p("mixed", [true, true, false])]);
  assert.equal(r.variantProduct.handle, "mixed");
  assert.equal(r.buy.handle, "single");
  assert.equal(r.buyVariant.id, 1);
  assert.equal(pickProducts([p("none", [false])]).buy, null);
});

test("prices: the amount is found in any format the theme shows", () => {
  assert.ok(moneyMatches("$89.95 AUD", 8995));
  assert.ok(moneyMatches("Sale price $64.00 Regular price $80.00", 6400));
  assert.ok(moneyMatches("$1,299.00", 129900));
  assert.ok(moneyMatches("1.299,00 €", 129900));
  assert.ok(moneyMatches("From $90", 9000));
  assert.ok(!moneyMatches("$89.95", 9995));
  assert.ok(!moneyMatches("", 100));
});

test("cart counts: a number in the bubble, empty means none", () => {
  assert.equal(cartCountFrom("3"), 3);
  assert.equal(cartCountFrom("Cart, 12 items"), 12);
  assert.equal(cartCountFrom(""), 0);
  assert.equal(cartCountFrom(null), 0);
});

test("the kit's journeys.json.example is a valid file", async (t) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const file = new URL("../journeys.json.example", import.meta.url);
  if (!existsSync(file)) return t.skip("only in the kit itself");
  assert.deepEqual(validateJourneys(JSON.parse(readFileSync(file, "utf8"))).errors, []);
});
