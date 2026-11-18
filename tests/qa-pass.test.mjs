// The QA pass holds: approve and release only for code that passed every check (scripts/qa-pass.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptVisual, qaPassVerdict, readQaPass, writeQaPass } from "../scripts/qa-pass.mjs";
import { bypassesChecks, writesCheckRecord } from "../scripts/qa/ship-gate.mjs";

const PASS = { codeHash: "abc", store: "acme.myshopify.com", theme: "111" };

test("no pass, or a pass for other code, theme or store, is never ok", () => {
  assert.equal(qaPassVerdict(null, PASS).ok, false);
  assert.equal(qaPassVerdict({ ...PASS, codeHash: "old" }, PASS).ok, false);
  assert.equal(qaPassVerdict({ ...PASS, theme: "222" }, PASS).ok, false);
  assert.equal(qaPassVerdict({ ...PASS, store: "example.myshopify.com" }, PASS).ok, false);
  assert.equal(qaPassVerdict(PASS, PASS).ok, true);
});

test("a pass written is read back, and accepted pictures become the baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-pass-"));
  const file = join(dir, ".qa-pass.json");
  writeQaPass({ ...PASS, visualPending: ["home-390"] }, { file });
  assert.deepEqual(readQaPass({ file }).visualPending, ["home-390"]);
  const out = join(dir, "out"), base = join(dir, "base");
  mkdirSync(out);
  writeFileSync(join(out, "home-390.png"), "x");
  assert.equal(acceptVisual(["home-390", "gone-768"], { out, base }), 1);
  assert.equal(existsSync(join(base, "home-390.png")), true);
});

test("rule 6: Claude never accepts its own screenshots or writes the QA pass", () => {
  for (const cmd of [
    "npm run visual -- --approve",
    "PREVIEW_URL=https://x npm run visual -- --approve",
    "node scripts/qa/visual-walk.mjs --approve",
    "cp parity/visual/home-390.png design/visual-baseline/",
    "rsync -a parity/visual/ design/visual-baseline/",
    "echo '{}' > .qa-pass.json",
    "cp /tmp/p.json .qa-pass.json",
    "touch .qa-pass.json",
    `node -e 'require("fs").writeFileSync(".qa-pass.json","{}")'`,
  ]) assert.equal(bypassesChecks(cmd), true, cmd);
  assert.equal(writesCheckRecord("/r/.qa-pass.json"), true);
  assert.equal(writesCheckRecord("/r/design/visual-baseline/home-390.png"), true);
  assert.equal(writesCheckRecord("/r/parity/visual/pending.json"), true);
});

test("rule 6: running the checks and reading their records stay allowed", () => {
  for (const cmd of [
    "npm run visual",
    "npm run deploy",
    "npm run release",
    "cat .qa-pass.json",
    "ls design/visual-baseline",
    "open parity/visual/home-390.diff.png",
  ]) assert.equal(bypassesChecks(cmd), false, cmd);
  assert.equal(writesCheckRecord("/r/scripts/qa-pass.mjs"), false);
  assert.equal(writesCheckRecord("/r/parity/visual/home-390.png"), false);
});
