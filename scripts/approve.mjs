// npm run approve -- --by "Your name"
//
// Run by a person, in their own terminal, after opening the review link and checking the work.
// Only for code with a full QA pass (scripts/qa-pass.mjs). If screenshots changed, it lists them and
// needs --pictures-checked once the person has opened each one; they then become the visual baseline.
// Claude never runs this (the ship gate refuses): an approval has to mean somebody looked.
// It records who approved which code, and only if the preview theme is showing exactly that code,
// so nobody approves one thing and releases another. See scripts/approval.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL, ROOT, deployTarget, reviewLink } from "./approval.mjs";
import { execCli, flag } from "./platform.mjs";
import { codeHash } from "./review-stamp.mjs";
import { acceptVisual, qaPassVerdict, readQaPass } from "./qa-pass.mjs";
import { CODE_GLOBS, codeFilesIn, hashFile } from "./theme-sync.mjs";

const fileExists = (p) => existsSync(join(ROOT, p));

const by = (flag("--by") || "").trim();
if (!by) { console.log('Say who is approving: npm run approve -- --by "Your name"'); process.exit(1); }

const target = deployTarget();
if (!target.store || !target.theme) { console.log("package.json's deploy script has no --store or --theme, so it is not known which preview you checked. Stopping."); process.exit(1); }

// Only work that passed every check can be approved (scripts/qa-pass.mjs).
const pass = readQaPass();
const qa = qaPassVerdict(pass, { codeHash: codeHash(), store: target.store, theme: target.theme });
if (!qa.ok) { console.log(`Not approved: ${qa.why}.`); process.exit(1); }
if (pass.notRun?.length) console.log(`Not checked by the walks on this deploy: ${pass.notRun.join(", ")}. Check those by hand on the review link.`);
// Pictures that changed since the last baseline: the approver says they looked at each one.
const pictures = pass.visualPending || [];
if (pictures.length && !process.argv.includes("--pictures-checked")) {
  console.log(`${pictures.length} screenshot(s) changed or are new. Open each picture (red marks what changed) and check every change was meant:`);
  for (const s of pictures.slice(0, 40)) console.log(`  parity/visual/${s}.png${fileExists(`parity/visual/${s}.diff.png`) ? `  (changes: parity/visual/${s}.diff.png)` : ""}`);
  if (pictures.length > 40) console.log(`  ...and ${pictures.length - 40} more in parity/visual/pending.json`);
  console.log('Then approve again with --pictures-checked: npm run approve -- --by "Your name" --pictures-checked');
  process.exit(1);
}

// The preview must hold this repo's code, or the approval is for something nobody looked at.
const pulled = mkdtempSync(join(tmpdir(), "approve-pull-"));
try {
  execCli("shopify", ["theme", "pull", "--store", target.store, "--theme", target.theme, "--path", pulled, ...CODE_GLOBS.flatMap((g) => ["--only", g])], { stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  console.log(`Could not read the preview theme, so it is not known what you checked. Stopping. (${String(e.message).split("\n")[0]})`);
  process.exit(1);
}
const preview = Object.fromEntries(codeFilesIn(pulled).map((f) => [f, hashFile(join(pulled, f))]));
if (!Object.keys(preview).length) { console.log("Pulled no code from the preview theme, so it is not known what you checked. Stopping."); process.exit(1); }
const differ = codeFilesIn(ROOT).filter((f) => preview[f] !== hashFile(join(ROOT, f)));
if (differ.length) {
  console.log("Not approved: the preview is not showing this repo's code, so what you checked is not what would go live:");
  for (const f of differ.slice(0, 20)) console.log(`  ${f}`);
  console.log("Deploy first (npm run deploy), check the review link again, then approve.");
  process.exit(1);
}

let commit = null;
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
if (pictures.length) console.log(`Accepted ${acceptVisual(pictures)} screenshot(s) as the new visual baseline.`);
writeFileSync(APPROVAL, JSON.stringify({ by, at: new Date().toISOString(), store: target.store, previewTheme: target.theme, commit, codeHash: codeHash() }, null, 2) + "\n");
console.log(`Approved by ${by}: the code on ${reviewLink(target)}`);
console.log("Next: npm run release puts it on the live theme (same theme id). Any code change from here needs a new deploy and approval.");
