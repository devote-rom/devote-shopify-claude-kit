// npm run review:base gives /security-review an origin/HEAD in a brand folder with no remote.
//
// Exists because /security-review reviews `git diff origin/HEAD`, and on one Mac (Nov 2026) a
// fresh brand folder from new-brand.sh had no origin, so it stopped with "unknown revision
// origin/HEAD" and deploy could not be stamped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewBase } from "../scripts/review-base.mjs";

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "review-base-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, env: ENV, encoding: "utf8" }).trim();
  git("init", "-q", ".");
  const commit = (file, msg) => { writeFileSync(join(dir, file), msg); git("add", "-A"); git("commit", "-qm", msg, "--no-verify"); return git("rev-parse", "HEAD"); };
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("no remote and no review yet: origin/HEAD is the theme as first pulled", () => {
  const r = repo();
  const first = r.commit("a.liquid", "first pull");
  r.commit("a.liquid", "a change");
  const out = reviewBase(r.dir);
  assert.equal(out.base, first);
  assert.equal(r.git("rev-parse", "origin/HEAD"), first);
  r.done();
});

test("no remote after a review: origin/HEAD is the commit that last changed the stamp", () => {
  const r = repo();
  r.commit("a.liquid", "first pull");
  const stamped = r.commit(".review-stamp.json", "reviewed");
  r.commit("a.liquid", "a later change");
  assert.equal(reviewBase(r.dir).base, stamped);
  assert.equal(r.git("diff", "--name-only", "origin/HEAD", "HEAD"), "a.liquid");
  r.done();
});

test("a real origin with its own HEAD is left alone", () => {
  const r = repo();
  const first = r.commit("a.liquid", "first pull");
  r.git("remote", "add", "origin", "https://example.invalid/x.git");
  r.git("update-ref", "refs/remotes/origin/main", first);
  r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  r.commit("a.liquid", "a change");
  assert.deepEqual(reviewBase(r.dir), { left: true });
  assert.equal(r.git("symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/main");
  r.done();
});

test("no commits yet says so instead of setting anything", () => {
  const r = repo();
  assert.match(reviewBase(r.dir).error, /no commits/);
  r.done();
});
