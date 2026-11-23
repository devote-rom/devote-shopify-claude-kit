// Gives /security-review something to compare against in a brand folder with no GitHub remote.
//
//   npm run review:base      (run it before /security-review)
//
// /security-review reviews `git diff origin/HEAD`, and a brand folder made by new-brand.sh has no
// origin, so it stopped with "unknown revision origin/HEAD" (one Mac, Nov 2026). With no origin
// remote, this points the local ref origin/HEAD at the last reviewed code: the last commit that
// changed .review-stamp.json, or the theme as first pulled (the first commit) before any review.
// The review then covers exactly what changed since. A folder with a real origin is left alone.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./platform.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

export function reviewBase(cwd = ROOT) {
  const git = (...args) => {
    try { return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  if (git("rev-parse", "--verify", "-q", "HEAD") == null) return { error: "this folder has no commits yet, so there is nothing to review against" };
  const hasOrigin = (git("remote") || "").split("\n").includes("origin");
  if (hasOrigin && git("rev-parse", "--verify", "-q", "origin/HEAD") != null) return { left: true };
  const stamped = git("log", "-1", "--format=%H", "--", ".review-stamp.json");
  const base = stamped || (git("rev-list", "--max-parents=0", "HEAD") || "").split("\n").pop();
  if (!base) return { error: "could not find the first commit" };
  if (git("update-ref", "refs/remotes/origin/HEAD", base) == null) return { error: "git would not set origin/HEAD" };
  return { base, from: stamped ? "the last reviewed commit" : "the theme as first pulled", subject: git("log", "-1", "--format=%s", base) };
}

if (isMain(import.meta.url)) {
  const r = reviewBase();
  if (r.error) { console.log(`Could not set the review base: ${r.error}.`); process.exit(1); }
  if (r.left) console.log("This folder has a real origin remote, so /security-review compares against it. Nothing changed.");
  else console.log(`origin/HEAD now points at ${r.base.slice(0, 7)} ("${r.subject}"), ${r.from}. /security-review will review everything changed since.`);
}
