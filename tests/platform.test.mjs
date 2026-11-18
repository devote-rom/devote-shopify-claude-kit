// Commands start the same way on Windows as on a Mac (scripts/platform.mjs).
//
// Exists because on Windows (Nov 2026) deploy and QA could not start the Shopify CLI, which is
// shopify.cmd there, and install.sh wrote an empty .devote-kit-version. The last test is the guard:
// no script starts shopify, npm, npx, sleep or `which` directly, or tells "run directly" from
// "imported" by comparing process.argv[1] by hand, because each of those only works on a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command, isMain, which } from "../scripts/platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (p) => p.replace(/\\/g, "/").toLowerCase(); // Windows paths ignore case
const fakeFs = (paths) => (p) => paths.map(slash).includes(slash(p));
const WIN = { platform: "win32", env: { PATH: "C:/Users/dev/AppData/Roaming/npm;C:/Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD" } };
const SHIM = "C:/Users/dev/AppData/Roaming/npm/shopify.cmd";
const RUN_JS = "C:/Users/dev/AppData/Roaming/npm/node_modules/@shopify/cli/bin/run.js";

test("which finds the .cmd shim on Windows, not npm's extension-less shell script", () => {
  const exists = fakeFs(["C:/Users/dev/AppData/Roaming/npm/shopify", SHIM]);
  assert.equal(slash(which("shopify", { ...WIN, exists }) ?? ""), slash(SHIM));
  assert.equal(which("gh", { ...WIN, exists }), null);
});

test("on Windows the Shopify CLI runs as its own run.js through node", () => {
  const c = command("shopify", ["theme", "list", "--json"], { ...WIN, exists: fakeFs([SHIM, RUN_JS]) });
  assert.equal(c.file, process.execPath);
  assert.deepEqual([c.args[0].replace(/\\/g, "/"), ...c.args.slice(1)], [RUN_JS, "theme", "list", "--json"]);
});

test("without run.js it falls back to cmd.exe with every argument quoted", () => {
  const c = command("shopify", ["store", "execute", "--query", 'mutation { a(b: "c") { d } }'], { ...WIN, exists: fakeFs([SHIM]) });
  assert.match(slash(c.shell), /^"c:\/users\/dev\/appdata\/roaming\/npm\/shopify\.cmd" /);
  assert.match(c.shell, /store execute --query "mutation \{ a\(b: \\"c\\"\) \{ d \} \}"$/);
});

test("on a Mac every command starts as itself", () => {
  assert.deepEqual(command("shopify", ["theme", "list"], { platform: "darwin" }), { file: "shopify", args: ["theme", "list"] });
  assert.deepEqual(command("git", ["status"], WIN), { file: "git", args: ["status"] });
});

test("isMain is true only for the file that was run", () => {
  assert.equal(isMain(import.meta.url, fileURLToPath(import.meta.url)), true);
  assert.equal(isMain(import.meta.url, join(ROOT, "scripts", "deploy.mjs")), false);
  assert.equal(isMain(import.meta.url, ""), false);
});

test("no script starts a command or checks how it was run in a Mac-only way", () => {
  const files = [];
  for (const d of ["scripts", "scripts/qa", "hooks"]) {
    if (!existsSync(join(ROOT, d))) continue; // brand repos have no hooks/
    for (const f of readdirSync(join(ROOT, d))) if (f.endsWith(".mjs") && f !== "platform.mjs") files.push(`${d}/${f}`);
  }
  const BAD = [
    [/exec(?:File)?Sync\(\s*["'](?:shopify|npm|npx|sleep)["']/, "use execCli or sleepSync from scripts/platform.mjs"],
    [/["']\/usr\/bin\/env["']/, "use haveCli from scripts/platform.mjs"],
    [/process\.argv\[1\]\s*(?:===|&&)|===\s*process\.argv\[1\]|file:\/\/\$\{process\.argv\[1\]\}|pathToFileURL\(process\.argv\[1\]/, "use isMain(import.meta.url) from scripts/platform.mjs"],
  ];
  const problems = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const [re, fix] of BAD) if (re.test(line)) problems.push(`${f}:${i + 1}: ${fix}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(problems, []);
});
