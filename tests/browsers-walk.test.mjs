// The browsers walk's rules, without a browser: matching boxes, the tolerance, the engine rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRIVERS, ENGINES, SCREENS, compareReadings, differences, findingKind, grouped, loadProblem,
  matchBoxes, referenceFor, rowsToRun, tolerance,
} from "../scripts/qa/browsers-walk.mjs";

const box = (k, t, x, y, w = 100, h = 40, over = false) => ({ k, t, r: [x, y, w, h], over });

test("boxes match by kind and text, in page order, whatever else is on the page", () => {
  const chrome = [box("h2", "Best sellers", 0, 100), box("button", "Add to cart", 0, 200), box("button", "Add to cart", 200, 200), box("price", "$10.00", 0, 180)];
  const other = [box("button", "Add to cart", 0, 210), box("h2", "Best sellers", 0, 110), box("button", "Add to cart", 200, 210), box("button", "Sign up", 0, 900)];
  const { pairs, onlyA, onlyB } = matchBoxes(chrome, other);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map(([a, b]) => [a.t, a.r[0], b.r[0]]), [["Best sellers", 0, 0], ["Add to cart", 0, 0], ["Add to cart", 200, 200]]);
  assert.deepEqual(onlyA.map((x) => x.t), ["$10.00"]);
  assert.deepEqual(onlyB.map((x) => x.t), ["Sign up"]);
});

test("the tolerance is 8px, or 1% of a wide screen", () => {
  assert.equal(tolerance(390), 8);
  assert.equal(tolerance(810), 8);
  assert.equal(tolerance(1440), 14);
});

test("a few pixels of font drawing pass; a box moved or resized past the tolerance fails", () => {
  const pass = differences([[box("h1", "A", 0, 100), box("h1", "A", 1, 103, 101, 41)]], { tol: 8 });
  assert.deepEqual(pass, []);
  const moved = differences([[box("h1", "A", 0, 100), box("h1", "A", 0, 130)]], { tol: 8 });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].dy, 30);
  const wider = differences([[box("button", "Buy", 0, 100, 236), box("button", "Buy", 0, 100, 165)]], { tol: 8 });
  assert.equal(wider.length, 1);
  assert.ok(wider[0].resized && !wider[0].moved);
});

test("a shift is reported once, at the box where it starts, not on every box below", () => {
  const pairs = [0, 1, 2, 3, 4].map((i) => [box("h2", `h${i}`, 0, 100 + 300 * i), box("h2", `h${i}`, 0, 100 + 300 * i + (i >= 2 ? 48 : 0))]);
  const d = differences(pairs, { tol: 8 });
  assert.equal(d.length, 1);
  assert.equal(d[0].a.t, "h2");
  assert.ok(d[0].carries);
});

test("one box out of line in a column of a footer is that box alone; its neighbours in other columns pass", () => {
  // two columns read top to bottom in zig-zag order; the right column's headings sit 30px low
  const L = (t, y) => [box("button", t, 0, y), box("button", t, 0, y)];
  const R = (t, y) => [box("button", t, 300, y), box("button", t, 300, y + 30)];
  const d = differences([L("Radios", 5000), R("Others", 5000), R("Quick Links", 5200), L("Automotive", 5330), R("Support", 5480), L("Marine", 5650)], { tol: 8 });
  assert.deepEqual(d.map((x) => x.a.t), ["Others"]);
  assert.ok(d[0].carries, "the boxes below it in its column move with it");
});

test("a page that drifts a few pixels over a long stretch of text passes; the same shift over a short one fails", () => {
  const far = differences([[box("price", "$1", 0, 3000), box("price", "$1", 0, 3002)], [box("button", "Play", 0, 5200), box("button", "Play", 0, 5213)]], { tol: 8 });
  assert.deepEqual(far, []);
  const near = differences([[box("price", "$1", 0, 3000), box("price", "$1", 0, 3002)], [box("button", "Play", 0, 3100), box("button", "Play", 0, 3113)]], { tol: 8 });
  assert.equal(near.length, 1);
});

test("text running out of its box in one engine fails; in both it is the widths walk's", () => {
  const chrome = { vw: 1440, items: [box("button", "Shop now", 0, 100, 150, 48, false), box("button", "Sale", 0, 300, 150, 48, true)], findings: [] };
  const other = { vw: 1440, items: [box("button", "Shop now", 0, 100, 150, 48, true), box("button", "Sale", 0, 300, 150, 48, true)], findings: [] };
  const r = compareReadings(chrome, other, { engine: "Firefox" });
  assert.deepEqual(r.fails.map((f) => f.text), ['button "Shop now" runs out of its box in Firefox only']);
});

test("a widths finding fails only when Chrome has none of that kind on the page", () => {
  assert.equal(findingKind('text sits on a picture: "Camera" on a.jpg'), "text sits on a picture");
  assert.equal(findingKind('"Add to cart" wraps'), '"..." wraps');
  assert.equal(findingKind("header menu runs 12px under the icons"), "header menu runs Npx under the icons");
  const chrome = { vw: 390, items: [], findings: ['text sits on a picture: "Card one" on one.jpg'] };
  const other = { vw: 390, items: [], findings: ['text sits on a picture: "Card two" on two.jpg', '"Add to cart" wraps'] };
  const r = compareReadings(chrome, other, { engine: "WebKit" });
  assert.deepEqual(r.fails.map((f) => f.text), ['"Add to cart" wraps in WebKit only']);
  assert.equal(r.info.length, 1);
});

test("the header or main menu gone in one engine fails; a card gone is only listed", () => {
  const chrome = { vw: 1440, items: [box("header", "", 0, 0, 1440, 80), box("button", "Next", 0, 900)], findings: [] };
  const r = compareReadings(chrome, { vw: 1440, items: [], findings: [] }, { engine: "WebKit" });
  assert.deepEqual(r.fails.map((f) => f.text), ["the header is shown in Chrome but not in WebKit"]);
  assert.deepEqual(r.info, ['button "Next" is shown in Chrome but not in WebKit']);
});

test("the same line for several boxes is one line with a count", () => {
  const g = grouped([{ text: "a", boxes: [1] }, { text: "a", boxes: [2] }, { text: "b", boxes: [3] }]);
  assert.deepEqual(g.map((x) => x.text), ["a (2 of them)", "b"]);
  assert.equal(g[0].all.length, 2);
});

test("Shopify limiting this computer is NOT CHECKED with a plain reason, never a pass", () => {
  assert.equal(loadProblem({ status: 429, url: "https://example.com/" }), "Shopify is limiting requests from this computer; wait and run again");
  assert.match(loadProblem({ status: 404 }), /404/);
  assert.match(loadProblem({ status: 200, url: "https://example.com/password" }), /password/);
  assert.match(loadProblem({ error: "net::ERR_INTERNET_DISCONNECTED" }), /DISCONNECTED/);
  assert.equal(loadProblem({ status: 200, url: "https://example.com/" }), null);
});

test("the engine rows: WebKit at desktop, iPhone and iPad, Firefox at 1440 and 390, Android Chrome", () => {
  assert.deepEqual(ENGINES.map((e) => e.id), ["webkit-desktop", "webkit-iphone", "webkit-ipad", "firefox-desktop", "firefox-phone", "android-pixel"]);
  assert.equal(new Set(ENGINES.map((e) => e.id)).size, ENGINES.length);
  for (const e of ENGINES) {
    assert.ok(DRIVERS[e.engine], `${e.id}: no driver for ${e.engine}`);
    assert.ok(SCREENS[e.screen], `${e.id}: no screen ${e.screen}`);
    if (e.device) assert.ok(SCREENS[e.device], `${e.id}: no screen for device ${e.device}`);
  }
  assert.equal(SCREENS["iPhone 15"].width, 393);
  assert.equal(SCREENS["Pixel 7"].width, 412);
  assert.ok(SCREENS["Pixel 7"].touch && SCREENS["Pixel 7"].mobile && /Android/.test(SCREENS["Pixel 7"].ua));
});

test("rows of the same size share one Chrome reference, set to the row's size and phone mode", () => {
  const byId = Object.fromEntries(ENGINES.map((e) => [e.id, e]));
  assert.equal(referenceFor(byId["webkit-desktop"]).key, referenceFor(byId["firefox-desktop"]).key);
  const phone = referenceFor(byId["webkit-iphone"]);
  assert.deepEqual([phone.width, phone.height, phone.mobile, phone.touch, phone.dpr], [393, 659, true, true, 1]);
  assert.notEqual(phone.key, referenceFor(byId["firefox-phone"]).key);
});

test("BROWSERS_ENGINES picks rows by id or engine, and a name it does not know stops the walk", () => {
  assert.equal(rowsToRun("").length, ENGINES.length);
  assert.deepEqual(rowsToRun("firefox").map((e) => e.id), ["firefox-desktop", "firefox-phone"]);
  assert.deepEqual(rowsToRun("webkit-ipad, android-pixel").map((e) => e.id), ["webkit-ipad", "android-pixel"]);
  assert.throws(() => rowsToRun("safari"), /unknown browser row: safari/);
});

test("adding a row later (real Safari) is one entry and one driver", () => {
  const rows = [...ENGINES, { id: "safari-desktop", engine: "safari", label: "Safari", size: "1440px", screen: "desktop" }];
  assert.deepEqual(rowsToRun("safari", rows).map((e) => e.id), ["safari-desktop"]);
  assert.equal(referenceFor(rows.at(-1)).width, 1440);
});
