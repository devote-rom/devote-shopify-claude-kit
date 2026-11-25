// npm run release
//
// Puts approved work onto the live theme itself, so the live theme keeps its id (apps and
// integrations are tied to it). Only after a full QA pass and a person's `npm run approve`, both
// for this exact code (scripts/qa-pass.mjs, scripts/approval.mjs).
// See scripts/approval.mjs for the whole flow.
//
// What it pushes, and what it never does:
//   - code files (sections, snippets, blocks, layout, assets, settings schema) that differ from live
//   - template and settings JSON that live does not have yet (a new page template)
//   - never a template or settings file live already has: those hold the live store's editor work
//   - for a locale file live already has, only the text keys live lacks, added to live's own copy:
//     every value live has stays as it is (the client edits those under Edit default theme content)
//   - never over a live file this repo has never seen: someone changed live outside the repo
//     (the code editor, an app). Those are brought into .theme-incoming/ and nothing is pushed.
//   - nothing is deleted on the live theme
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APPROVAL, ROOT, approvalVerdict, deployTarget, inGitHistory, readApproval, reviewLink, unknownLiveChanges } from "./approval.mjs";
import { execCli, sleepSync } from "./platform.mjs";
import { pushResult, themeList } from "./shopify-json.mjs";
import { codeHash, reviewStatus } from "./review-stamp.mjs";
import { qaPassVerdict, readQaPass } from "./qa-pass.mjs";
import { CODE_GLOBS, codeFilesIn, hashFile } from "./theme-sync.mjs";
import { differingValues, missingKeys, parseLocale, serializeLocale, withMissingKeys } from "./locale-keys.mjs";

const target = deployTarget();
if (!target.store) { console.log("package.json's deploy script has no --store. Stopping."); process.exit(1); }
const STORE = target.store;
const run = (args, opts = {}) => execCli("shopify", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });

// One release or deploy at a time (the same lock deploy uses).
const LOCK = join(ROOT, ".deploy.lock");
for (let waited = 0; ; waited += 2) {
  try { mkdirSync(LOCK); break; } catch {
    if (waited === 0) console.log("A deploy or release is running. Waiting for it to finish...");
    if (waited > 900) { console.log(`Still locked after 15 minutes. If nothing is running, remove ${LOCK}.`); process.exit(1); }
    sleepSync(2000);
  }
}
process.on("exit", () => { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// 1. A person approved exactly this code, and the reviews saw it.
const approval = readApproval();
const verdict = approvalVerdict(approval, { codeHash: codeHash(), store: STORE });
if (!verdict.ok) {
  console.log(`Not releasing: ${verdict.why}.`);
  if (target.theme) console.log(`Deploy (npm run deploy), have a person check ${reviewLink(target)} and run npm run approve -- --by "Their name" in their own terminal, then release.`);
  process.exit(1);
}
const review = reviewStatus();
if (!review.ok) { console.log(`Not releasing: ${review.why}.`); process.exit(1); }
// and every check passed on that same code: a deploy with --skip-walks or SKIP_QA, or failed walks, never releases
const qa = qaPassVerdict(readQaPass(), { codeHash: codeHash(), store: STORE, theme: target.theme });
if (!qa.ok) { console.log(`Not releasing: ${qa.why}.`); process.exit(1); }

// 2. Which theme is live. Could not check means stop.
let live;
try {
  const themes = themeList(run(["theme", "list", "--store", STORE, "--role", "live", "--json"]));
  if (!themes) throw new Error("the Shopify CLI printed a theme list this kit cannot read");
  live = themes[0];
}
catch (e) { console.log(`Could not read which theme is live on ${STORE}. Stopping. (${String(e.message).split("\n")[0]})`); process.exit(1); }
if (!live?.id) { console.log(`Shopify listed no live theme on ${STORE}. Stopping.`); process.exit(1); }
const LIVE = String(live.id);
if (LIVE === String(target.theme)) { console.log("The deploy target is the live theme itself; there is nothing to release. Stopping."); process.exit(1); }

// 3. Code: what differs from live, and whether live holds anything this repo has never seen.
const liveCode = mkdtempSync(join(tmpdir(), "release-code-"));
run(["theme", "pull", "--store", STORE, "--theme", LIVE, "--path", liveCode, ...CODE_GLOBS.flatMap((g) => ["--only", g])]);
const liveFiles = new Set(codeFilesIn(liveCode));
if (!liveFiles.size) { console.log("Pulled no code from the live theme, so it is not known what it holds. Stopping."); process.exit(1); }
const changed = codeFilesIn(ROOT).filter((f) => !liveFiles.has(f) || hashFile(join(liveCode, f)) !== hashFile(join(ROOT, f)));
const strangers = unknownLiveChanges(changed.filter((f) => liveFiles.has(f)), (f) => inGitHistory(join(liveCode, f)));
if (strangers.length) {
  const INCOMING = join(ROOT, ".theme-incoming");
  for (const f of strangers) { mkdirSync(dirname(join(INCOMING, f)), { recursive: true }); cpSync(join(liveCode, f), join(INCOMING, f)); }
  console.log("Not releasing: these files were changed on the live theme outside this repo, and releasing would overwrite them:");
  for (const f of strangers) console.log(`  ${f}`);
  console.log("Live's versions are in .theme-incoming/. Merge them into the repo, delete .theme-incoming/, deploy, get a new approval, then release.");
  process.exit(1);
}

// 4. Editor files: only ones live does not have yet.
const EDITOR_DIRS = ["templates", "templates/customers", "config", "sections", "locales"];
const liveEditor = mkdtempSync(join(tmpdir(), "release-editor-"));
run(["theme", "pull", "--store", STORE, "--theme", LIVE, "--path", liveEditor, "--only", "templates/*.json", "--only", "templates/customers/*.json", "--only", "config/settings_data.json", "--only", "sections/*.json", "--only", "locales/*.json"]);
const editorIn = (dir) => EDITOR_DIRS.flatMap((d) => {
  const full = join(dir, d);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith(".json") && statSync(join(full, f)).isFile() && (d !== "config" || f === "settings_data.json"))
    .map((f) => `${d}/${f}`);
});
const liveEditorFiles = new Set(editorIn(liveEditor));
if (!liveEditorFiles.size) { console.log("Pulled no templates from the live theme, so it is not known which exist. Stopping."); process.exit(1); }
const newTemplates = editorIn(ROOT).filter((f) => !liveEditorFiles.has(f));

// 4b. Locale files live has: add the keys this code prints that live lacks, so the release does not
// show "Translation missing" (Rom, 25 Nov 2026), without changing any wording live already has.
const localeMerges = [];
for (const f of editorIn(ROOT).filter((f) => f.startsWith("locales/") && liveEditorFiles.has(f))) {
  const mine = parseLocale(readFileSync(join(ROOT, f), "utf8"));
  const theirs = parseLocale(readFileSync(join(liveEditor, f), "utf8"));
  if (!mine || !theirs) { console.log(`Not releasing: ${f} is not valid JSON ${mine ? "on the live theme" : "in the repo"}, so its new text keys cannot be added. Fix it, then release.`); process.exit(1); }
  const added = missingKeys(mine.data, theirs.data);
  const kept = differingValues(mine.data, theirs.data);
  if (kept.length) console.log(`${f}: ${kept.length} text value(s) differ from live and were left as live has them: ${kept.slice(0, 8).join(", ")}${kept.length > 8 ? ", ..." : ""}`);
  if (added.length && theirs.innerComments) console.log(`${f}: live's copy has comments inside it (translator notes), which the release cannot keep while adding keys. The text is unchanged.`);
  if (added.length) localeMerges.push({ f, added, text: serializeLocale({ comment: theirs.comment, data: withMissingKeys(theirs.data, mine.data) }) });
}

const files = [...changed, ...newTemplates, ...localeMerges.map((m) => m.f)];
if (!files.length) { console.log("The live theme already has this code. Nothing to release."); rmSync(APPROVAL, { force: true }); process.exit(0); }

// 5. Push just those files onto the live theme. A push "with errors" exits 0, so read the result.
const stage = mkdtempSync(join(tmpdir(), "release-push-"));
for (const f of [...changed, ...newTemplates]) { mkdirSync(dirname(join(stage, f)), { recursive: true }); cpSync(join(ROOT, f), join(stage, f)); }
for (const m of localeMerges) { mkdirSync(dirname(join(stage, m.f)), { recursive: true }); writeFileSync(join(stage, m.f), m.text); }
const out = run(["theme", "push", "--store", STORE, "--theme", LIVE, "--path", stage, "--nodelete", "--allow-live", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
const result = pushResult(out, stage);
if (!result) { console.log("Could not read the push result, so it is not known what reached the live theme. Check it now. Stopping."); process.exit(1); }
if (result.skipped) { console.log(`Shopify pushed nothing to the live theme (${result.skipped}). Stopping.`); process.exit(1); }
const errors = result.errors;
if (Object.keys(errors).length) {
  console.log("Shopify rejected these files; the live theme still has the old copies:");
  for (const [f, msgs] of Object.entries(errors)) console.log(`  ${f}: ${[].concat(msgs).join("; ")}`);
  process.exit(1);
}

// 6. One approval, one release. Keep a record of who approved what went live.
rmSync(APPROVAL, { force: true });
appendFileSync(join(ROOT, "releases.log"), JSON.stringify({ at: new Date().toISOString(), approvedBy: approval.by, approvedAt: approval.at, commit: approval.commit, liveTheme: LIVE, files }) + "\n");
console.log(`Live: ${files.length} file(s) pushed to the live theme "${live.name}" (#${LIVE}), approved by ${approval.by}. The theme id is unchanged.`);
for (const f of files) { const m = localeMerges.find((x) => x.f === f); console.log(`  ${f}${m ? ` (${m.added.length} new text key${m.added.length === 1 ? "" : "s"} added to live's copy: ${m.added.slice(0, 6).join(", ")}${m.added.length > 6 ? ", ..." : ""})` : ""}`); }
console.log(`\nCheck it: https://${target.domain || STORE}/`);
console.log("Then merge this branch into main and commit releases.log.");
