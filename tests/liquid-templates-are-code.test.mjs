// A new liquid template (an alternate view an app fetches, like cart.<app>.json.liquid) must count as
// code, or release never pushes it: it reached the preview with deploy and was missing on live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFilesIn, CODE_GLOBS } from "../scripts/theme-sync.mjs";

test("liquid templates are code files; JSON templates are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-tpl-"));
  mkdirSync(join(dir, "templates/customers"), { recursive: true });
  writeFileSync(join(dir, "templates/cart.app.json.liquid"), "{}");
  writeFileSync(join(dir, "templates/customers/login.liquid"), "x");
  writeFileSync(join(dir, "templates/index.json"), "{}");
  const files = codeFilesIn(dir);
  assert.ok(files.includes("templates/cart.app.json.liquid"));
  assert.ok(files.includes("templates/customers/login.liquid"));
  assert.ok(!files.includes("templates/index.json"));
  assert.ok(CODE_GLOBS.includes("templates/*.liquid"));
});
