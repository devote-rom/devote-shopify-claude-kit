// SessionStart: tells Claude when the Shopify repo it just opened has no kit, or an older one.
//
// The team does not run install.sh by hand, so this is how a new rule or guard reaches every
// brand: the next session in that folder sees the version differ and updates it first.
// Silent in any folder that is not a Shopify theme or app, so other work is not interrupted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kitVersion } from "./kit-version.mjs";
import { isMain } from "../scripts/platform.mjs";
import { enableAutoUpdate } from "./auto-update.mjs";
import { isThemeRepo, missingDeployTarget } from "../scripts/qa/deploy-target.mjs";

const repo = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const has = (p) => existsSync(join(repo, p));
const isShopify = (has("sections") && has("layout")) || has("shopify.app.toml") || has("DEVOTE-KIT.md");

export function advice({ isShopify, installed, current, missingTarget = [], noCarryover = false }) {
  if (!isShopify) return null;
  if (!installed) {
    return "This folder is a Shopify repo without the Devote Shopify kit (or with a copy from before the plugin). " +
      "Before any other work, run the /devote-shopify:setup skill, tell the person in one line that you are setting up the kit, then carry on with what they asked.";
  }
  if (installed !== current) {
    // An urgent small fix finishes on the kit it started with: an update mid-fix cost one same-day
    // follow-up its slot (Rom, 25 Nov 2026). The repo's own gate and checks still run meanwhile.
    return "The Devote Shopify kit in this repo is out of date (" + installed + ", latest " + current + "). " +
      "Run the /devote-shopify:setup skill to update it before starting new work, and tell the person in one line. " +
      "If the person says this is an urgent small fix, or you are part way through one, finish that fix first on the kit already in this repo " +
      "(its gate and checks still work), then update straight after, and tell the person you did it in that order.";
  }
  // Every session until it is fixed: without these, deploy cannot run its SEO, accessibility
  // and speed checks (two brands went weeks like that, 9 Oct 2026).
  if (missingTarget.length) {
    return "This brand's deploy script in package.json is missing " + missingTarget.join(", ") + ". " +
      "Without them npm run deploy cannot push or cannot run its SEO, accessibility and speed checks. " +
      "Before any other work, fill them in: read what you can from CLAUDE.md, `shopify theme list --store <store>` and the live site, " +
      "then ask the person for the rest in one message and wait for the answer. Commit the change, then carry on with what they asked.";
  }
  // Once per brand: what the live theme does for some products only (a delivery note, an app
  // block, a template) is found before the build, not after launch (DEVOTE-KIT.md, "Carry Over").
  if (noCarryover) {
    return "This brand has no record of what its live theme does beyond drawing the page (design/carryover-report.md is missing). " +
      "Before building anything, run npm run carryover (about two minutes), read design/carryover-report.md, and put every MISSING item into the plan: " +
      "build it into the new theme or record in design/carryover.json what replaces it. Commit the report, tell the person in one line what it found, then carry on with what they asked.";
  }
  return null;
}

if (isMain(import.meta.url)) {
  enableAutoUpdate();
  const installed = has(".devote-kit-version") ? readFileSync(join(repo, ".devote-kit-version"), "utf8").trim() : null;
  const pkg = join(repo, "package.json");
  const missingTarget = isThemeRepo(repo) ? missingDeployTarget(existsSync(pkg) ? readFileSync(pkg, "utf8") : null) : [];
  const noCarryover = isThemeRepo(repo) && !has("design/carryover-report.md");
  const text = advice({ isShopify, installed, current: kitVersion(), missingTarget, noCarryover });
  if (text) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
}
