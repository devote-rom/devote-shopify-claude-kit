// Walks pace their requests and stop when a store limits this computer (scripts/qa/pace.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBotCheck, noteThrottle, slot, throttled } from "../scripts/qa/pace.mjs";

test("requests to one host are spaced; other hosts are not held up", () => {
  const book = new Map();
  assert.equal(slot("a.com", 1000, 1500, book), 0);
  assert.equal(slot("a.com", 1000, 1500, book), 1500);
  assert.equal(slot("a.com", 1200, 1500, book), 2800);
  assert.equal(slot("b.com", 1200, 1500, book), 0);
  assert.equal(slot("a.com", 9000, 1500, book), 0);
});

test("a 429 or Shopify's bot check counts as being limited", () => {
  assert.equal(isBotCheck(429), true);
  assert.equal(isBotCheck(200, "Just a moment..."), true);
  assert.equal(isBotCheck(503, "Just a moment..."), true);
  assert.equal(isBotCheck(200, "Fishing Lures | A store"), false);
  assert.equal(isBotCheck(503, "Maintenance"), false);
});

test("being limited is remembered for 30 minutes, then forgotten", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pace-")), ".shopify-throttled");
  assert.equal(throttled({ file }), null);
  noteThrottle("https://example.com/collections/all", "429", { file });
  assert.equal(throttled({ file }).why, "429");
  const old = (Date.now() - 31 * 60000) / 1000;
  utimesSync(file, old, old);
  assert.equal(throttled({ file }), null);
  assert.equal(existsSync(file), false);
});
