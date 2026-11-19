// The QA pass: a record that every check passed on one exact set of code, written only by a full
// `npm run deploy` (no SKIP_QA, no --skip-walks, every walk green). Approve and release both read it,
// so work that was deployed with checks skipped, or changed after its checks, cannot be approved or
// released.
//
// Exists because until 1.7.0 a release only checked the person's approval and the review stamp:
// a deploy with --skip-walks, or one whose walks failed, could still be approved and released, and
// Claude could approve its own visual baselines, so nobody saw what changed (Roselle review, Nov 2026).
//
// Visual changes do not fail the pass. They are pictures a person has to look at, so the pass lists
// them and `npm run approve` makes the approver say they looked before it accepts them as the new
// baseline. Claude never approves pictures (ship gate rule 6).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const QA_PASS = join(ROOT, ".qa-pass.json");
export const VISUAL_PENDING = join(ROOT, "parity", "visual", "pending.json");
export const VISUAL_OUT = join(ROOT, "parity", "visual");
export const VISUAL_BASE = join(ROOT, "design", "visual-baseline");

export function readQaPass({ file = QA_PASS } = {}) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function clearQaPass({ file = QA_PASS } = {}) { rmSync(file, { force: true }); }

export function writeQaPass(pass, { file = QA_PASS } = {}) {
  writeFileSync(file, JSON.stringify({ ...pass, at: new Date().toISOString() }, null, 2) + "\n");
}

/** Pictures the visual walk marked for a person to look at on its last run. */
export function readVisualPending({ file = VISUAL_PENDING } = {}) {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, "utf8")).shots || []; } catch { return []; }
}

/**
 * Whether a QA pass covers the code about to be approved or released.
 * @returns {{ ok: boolean, why?: string }}
 */
export function qaPassVerdict(pass, { codeHash, store, theme }) {
  if (!pass) return { ok: false, why: "no full QA pass on record for this code (run npm run deploy with no --skip-walks and no SKIP_QA, and get every check green)" };
  if (store && pass.store !== store) return { ok: false, why: `the QA pass is for ${pass.store}, not ${store}` };
  if (theme && String(pass.theme) !== String(theme)) return { ok: false, why: `the QA pass is for theme ${pass.theme}, not ${theme}` };
  if (pass.codeHash !== codeHash) return { ok: false, why: "the code changed after its last full QA pass, so the checks did not see what would go live" };
  return { ok: true };
}

/** Make the pictures a person accepted the new visual baseline. */
export function acceptVisual(shots, { out = VISUAL_OUT, base = VISUAL_BASE } = {}) {
  mkdirSync(base, { recursive: true });
  let n = 0;
  for (const s of shots) {
    const from = join(out, `${s}.png`);
    if (!existsSync(from)) continue;
    cpSync(from, join(base, `${s}.png`)); n++;
  }
  return n;
}
