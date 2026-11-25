import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStatePages } from "../scripts/qa/find-state-pages.mjs";
import { stateIncomplete } from "../scripts/qa/page-list.mjs";
import { THROTTLE_FILE } from "../scripts/qa/pace.mjs";

// A refused catalogue read once wrote the 30-minute throttle mark, so every walk after it was
// skipped and the deploy failed while the store's pages loaded fine.
test("a 429 on products.json is reported but does not stop the walks", async () => {
  const hadMark = existsSync(THROTTLE_FILE);
  const realFetch = globalThis.fetch;
  const pace = process.env.WALK_PACE_MS;
  process.env.WALK_PACE_MS = "0";
  globalThis.fetch = async () => new Response("Too many requests", { status: 429 });
  try {
    const { pages, problems } = await findStatePages("www.example.com");
    assert.equal(problems.length, 2);
    assert.match(problems[0], /429/);
    assert.ok(pages.some((p) => p.path === "/cart"));
    if (!hadMark) assert.equal(existsSync(THROTTLE_FILE), false);
  } finally {
    globalThis.fetch = realFetch;
    if (pace === undefined) delete process.env.WALK_PACE_MS; else process.env.WALK_PACE_MS = pace;
    if (!hadMark) rmSync(THROTTLE_FILE, { force: true });
  }
});

test("a state pages file from a refused look counts as incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  const file = join(dir, "state-pages.json");
  assert.equal(stateIncomplete({ file }), false);
  writeFileSync(file, JSON.stringify({ incomplete: true, pages: [] }));
  assert.equal(stateIncomplete({ file }), true);
  writeFileSync(file, JSON.stringify({ pages: [] }));
  assert.equal(stateIncomplete({ file }), false);
});
