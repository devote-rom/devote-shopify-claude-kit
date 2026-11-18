// The widths walk's text rules, without a browser: text over text, text on a picture, text cut off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutOff, textOnPictures, textOverlaps, widthsConfig } from "../scripts/qa/widths-walk.mjs";

const box = (n, b, r, s = `text ${n}`) => ({ n, b, r, s });

test("two lines of text from different blocks drawn over each other clash", () => {
  const found = textOverlaps([box(0, 0, [10, 100, 200, 120]), box(1, 1, [50, 104, 250, 124])]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].map((x) => x.n), [0, 1]);
});

test("touching or a few pixels into each other is not a clash", () => {
  assert.deepEqual(textOverlaps([box(0, 0, [10, 100, 200, 120]), box(1, 1, [10, 120, 200, 140])]), []);
  assert.deepEqual(textOverlaps([box(0, 0, [10, 100, 200, 120]), box(1, 1, [198, 100, 300, 120])]), []);
  // a display heading set with a line height under 1: lines a third into each other on purpose
  assert.deepEqual(textOverlaps([box(0, 0, [16, 5252, 69, 5298]), box(1, 1, [16, 5282, 231, 5328])]), []);
});

test("lines of the same block are never compared, and each pair is listed once", () => {
  assert.deepEqual(textOverlaps([box(0, 0, [10, 100, 200, 120]), box(1, 0, [10, 105, 200, 125])]), []);
  const twice = textOverlaps([box(0, 0, [10, 100, 200, 120]), box(0, 0, [10, 130, 200, 150]), box(1, 1, [10, 102, 200, 122]), box(1, 1, [10, 132, 200, 152])]);
  assert.equal(twice.length, 1);
});

test("text on a picture is found, text beside it is not", () => {
  const pics = [{ i: 0, r: [0, 0, 300, 200], s: "hero.jpg" }];
  assert.equal(textOnPictures([box(0, 0, [20, 50, 120, 70])], pics).length, 1);
  assert.deepEqual(textOnPictures([box(0, 0, [20, 202, 120, 222])], pics), []);
  assert.deepEqual(textOnPictures([box(0, 0, [298, 50, 400, 70])], pics), []);
});

test("text cut off by its box is found; text that fits is not", () => {
  const base = { s: "Add to cart", sw: 100, cw: 100, sh: 20, ch: 20, clipX: true, clipY: true, marked: false, label: false, ok: false };
  assert.deepEqual(cutOff([base]), []);
  assert.equal(cutOff([{ ...base, sw: 130 }]).length, 1);
  assert.equal(cutOff([{ ...base, sh: 40 }]).length, 1);
  // two pixels of slack for rounding and descenders
  assert.deepEqual(cutOff([{ ...base, sw: 102, sh: 21 }]), []);
  // a box that does not clip shows its overflow
  assert.deepEqual(cutOff([{ ...base, sw: 130, clipX: false, clipY: false }]), []);
});

test("an ellipsis or a line clamp is the theme's choice, except on a button or menu link", () => {
  const title = { s: "A very long product title", sw: 300, cw: 200, sh: 40, ch: 40, clipX: true, clipY: true, marked: true, label: false, ok: false };
  assert.deepEqual(cutOff([title]), []);
  assert.equal(cutOff([{ ...title, label: true }]).length, 1);
});

test("design/widths.json exceptions are respected", () => {
  const item = { s: "Clipped on purpose", sw: 300, cw: 200, sh: 20, ch: 20, clipX: true, clipY: true, marked: false, label: false, ok: true };
  assert.deepEqual(cutOff([item]), []);
  const root = mkdtempSync(join(tmpdir(), "widths-cfg-"));
  assert.deepEqual(widthsConfig(root), {});
  mkdirSync(join(root, "design"));
  writeFileSync(join(root, "design", "widths.json"), JSON.stringify({ cutOffOk: [".card__title"] }));
  assert.deepEqual(widthsConfig(root).cutOffOk, [".card__title"]);
});
