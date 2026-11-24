// `npm run deploy -- --theme X` puts a second --theme after the one package.json's script passes.
// 20 Nov 2026: scripts read the first copy, and a release meant for one theme went to another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, flagValues } from "../scripts/platform.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the flag typed after npm run deploy -- wins over the script's own", () => {
  const argv = ["node", "deploy.mjs", "--store", "acme.myshopify.com", "--theme", "111", "--theme", "222"];
  assert.equal(flag("--theme", argv), "222");
  assert.equal(flag("--store", argv), "acme.myshopify.com");
  assert.deepEqual(flagValues("--theme", argv), ["111", "222"]);
  assert.equal(flag("--domain", argv), null);
  assert.equal(flag("--theme", ["node", "x", "--theme"]), null, "a flag with no value is no value");
});

test("no kit script reads the first copy of a flag", () => {
  const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".mjs") ? [join(d, f)] : []));
  const bad = [...files(join(KIT, "scripts")), ...files(join(KIT, "hooks"))]
    .filter((f) => /process\.argv\.indexOf\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(bad.map((f) => f.slice(KIT.length + 1)), [], "use flag() from scripts/platform.mjs");
});
