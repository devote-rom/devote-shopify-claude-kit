// The fast lane: which changes may deploy with one page checked instead of every walk.
//
// Exists because a one-line copy fix took about an hour to reach live: the full walks ran on every
// page at every width, tripped Shopify's rate limit, and each follow-up used another theme slot on
// stores near the 20-theme cap (Rom, 25 Nov 2026). `npm run deploy -- --small --page <path>` checks
// the changed page (visual at 390, 768, 1024 and 1440px, accessibility at 390 and 1440px) and writes
// a QA pass that says which walks did not run, so the approver knows what they are signing off.
//
// Small means: locale text, and at most one code file the theme already runs with a few changed
// lines. Never template or settings JSON, never a new file, never anything that touches money, the
// cart or checkout.
import { spawnSync } from "node:child_process";

export const MAX_LINES = 20;
// "order" with no letter before it, so border-radius is not money; taxonomy is, which fails toward the full deploy
const MONEY = /(?<![a-z])(cart|checkout|price|money|discount|gift[_-]?card|tax|shipping|order|payment|currency|subtotal)/i;

/**
 * @param {{ path: string, isNew?: boolean, binary?: boolean, added?: string[], removed?: string[], error?: string }[]} changes
 * @returns {{ ok: boolean, why?: string }}
 */
export function smallVerdict(changes) {
  const no = (why) => ({ ok: false, why });
  if (!changes.length) return no("nothing differs from the theme");
  for (const c of changes) {
    if (/^(templates\/[^/]*\.json|templates\/customers\/[^/]*\.json|config\/|sections\/[^/]*\.json)/.test(c.path)) return no(`${c.path} is template or settings JSON`);
    if (MONEY.test(c.path)) return no(`${c.path} handles money, the cart or checkout`);
  }
  const code = changes.filter((c) => !c.path.startsWith("locales/"));
  if (code.length > 1) return no(`${code.length} code files changed (${code.map((c) => c.path).slice(0, 4).join(", ")}), and the fast lane takes one`);
  if (code.length === 1) {
    const c = code[0];
    if (c.error) return no(`${c.path} could not be compared with the theme (${c.error})`);
    if (c.isNew) return no(`${c.path} is new, not code the theme already runs`);
    if (c.binary) return no(`${c.path} is not a text file`);
    const lines = [...(c.added || []), ...(c.removed || [])];
    if (lines.length > MAX_LINES) return no(`${c.path} has ${lines.length} changed lines, more than ${MAX_LINES}`);
    const money = lines.find((l) => MONEY.test(l));
    if (money) return no(`a changed line in ${c.path} touches money, the cart or checkout: ${money.trim().slice(0, 80)}`);
  }
  return { ok: true };
}

/** The lines added and removed between the theme's copy of a file and the repo's. */
export function lineChanges(themeCopy, repoCopy) {
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U0", "--", themeCopy, repoCopy], { encoding: "utf8" });
  if (r.error || r.status > 1) return { error: String(r.error?.message || r.stderr || "git diff failed").split("\n")[0] };
  if (/^Binary files /m.test(r.stdout)) return { binary: true };
  const lines = r.stdout.split("\n");
  return {
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)),
    removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1)),
  };
}

/** The walks a fast-lane deploy does not run, for the QA pass and the approver. */
export function smallNotRun(pages) {
  return ["carry-over", "forms", "SEO", "widths", "Safari, Firefox and phones", "live comparison", "journeys", "speed", `visual and accessibility on every page except ${pages.join(", ")}`];
}
