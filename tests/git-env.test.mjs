// A git hook sets GIT_DIR. A test that runs `git init` with it inherited re-initialises the kit's
// own repo as bare, and the commit fails with "must be run in a work tree" (it happened twice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// Reading the kit's own repo (git ls-files) with the hook's GIT_DIR is fine; making a repo is not.
test("every test that makes a git repo runs git without the hook's GIT_ variables", () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".test.mjs") && n !== "git-env.test.mjs")) {
    const text = readFileSync(join(DIR, f), "utf8");
    if (!/["'`]init["'`]/.test(text)) continue;
    text.split("\n").forEach((line, i) => {
      if (/(execFileSync|spawnSync|execSync)\(\s*["'`]git\b/.test(line) && !/\benv\b/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
