import test from "node:test";
import assert from "node:assert/strict";
import { fixingOf, listFixing, parseRepos } from "./loop-fixing.mjs";
import { continueComment, escalateComment, fixingComment, startComment, stoppedComment } from "../src/lib/review-loop.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
let nextId = 1;
/** An issue comment as GitHub's REST API returns it. */
const row = (body, at, login = BOT) => ({ id: nextId++, user: { login }, body, created_at: at });
const fixing = (at = "2026-01-02T00:00:00Z") => row(fixingComment({ round: 2, pr: 7, head: HEAD }), at);
const start = row(startComment({ mode: "apply", by: "alice", at: "2026-01-01T00:00:00Z" }), "2026-01-01T00:00:01Z");

test("parseRepos: owner/repo arguments, else ASHLAR_LOOP_REPOS; anything else is a usage error", () => {
  assert.deepEqual(parseRepos(["o/r", "o/r", "x/y.js"]), [{ owner: "o", repo: "r" }, { owner: "x", repo: "y.js" }]);
  assert.deepEqual(parseRepos([], { ASHLAR_LOOP_REPOS: " o/r , p/q ," }), [{ owner: "o", repo: "r" }, { owner: "p", repo: "q" }]);
  assert.deepEqual(parseRepos(["a/b"], { ASHLAR_LOOP_REPOS: "o/r" }), [{ owner: "a", repo: "b" }], "arguments win");
  assert.throws(() => parseRepos([]), /usage/);
  assert.throws(() => parseRepos(["just-a-repo", "o/r/extra"]), /not owner\/repo: just-a-repo, o\/r\/extra/);
});

test("fixingOf: FIXING is reported only while it is the App's newest loop comment", () => {
  assert.deepEqual(fixingOf([start, fixing()], BOT), { round: 2, head: HEAD, at: "2026-01-02T00:00:00Z" });
  // Anything the round (or the session) wrote after it means the round was not cut.
  const after = {
    "a continuation (applied round)": continueComment({ mode: "apply", round: 3, pr: 7, head: "b".repeat(40) }),
    "a suggestion report (waits for the push)": "### Ashlar fix agent — suggestion (mode: suggest)\n\nProposed changes",
    "a handoff": escalateComment({ reason: "fix-failed", round: 2, roundCap: 5, pr: 7, head: HEAD, repo: "o/r" }),
    "a STOPPED acknowledgement": stoppedComment(),
    "a re-issued start": startComment({ mode: "suggest", by: "bob", at: "2026-01-03T00:00:00Z" }),
  };
  for (const [label, body] of Object.entries(after)) {
    assert.equal(fixingOf([start, fixing(), row(body, "2026-01-03T00:00:00Z")], BOT), null, label);
  }
  // Rows that are not the App's loop comments never hide a FIXING, nor forge one.
  assert.ok(fixingOf([start, fixing(), row("### Ashlar ops — review posted", "2026-01-03T00:00:00Z")], BOT), "an ops comment of the App");
  assert.ok(fixingOf([start, fixing(), row(stoppedComment(), "2026-01-03T00:00:00Z", "mallory")], BOT), "a human quoting STOPPED");
  assert.equal(fixingOf([start, row(fixingComment({ round: 1, pr: 7, head: HEAD }), "2026-01-03T00:00:00Z", "mallory")], BOT), null, "a human quoting FIXING");
  assert.equal(fixingOf([start, row(`quoted: ${fixingComment({ round: 1, pr: 7, head: HEAD })}`, "2026-01-03T00:00:00Z")], BOT), null, "a marker that does not open the comment");
  // Order is creation time, then id (GitHub's timestamps have 1 s resolution) — never list order.
  const report = row("### Ashlar fix agent — applied\n\nCommitted", "2026-01-02T00:00:00Z");
  assert.equal(fixingOf([report, start, fixing("2026-01-02T00:00:00Z")].map((r, i) => (i === 0 ? { ...r, id: 10_000 } : r)), BOT), null, "same second: the higher id is newer");
  assert.equal(fixingOf([], BOT), null);
  // The configured App login is honored (ASHLAR_BOT_LOGIN), and only it.
  assert.equal(fixingOf([start, fixing()], "other-app[bot]"), null);
});

/** A fake fetch over canned list pages: `pages` maps a path (without the paging query) to its rows. */
function fakeFetch(pages, { fail } = {}) {
  const urls = [];
  const impl = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const page = Number(u.searchParams.get("page"));
    const path = u.pathname + (u.searchParams.get("state") ? `?state=${u.searchParams.get("state")}` : "");
    if (fail && path.includes(fail)) return { ok: false, status: 502, json: async () => ({}) };
    const rows = pages[path] ?? [];
    return { ok: true, status: 200, json: async () => rows.slice((page - 1) * 100, page * 100) };
  };
  return { impl, urls };
}

test("listFixing: open PRs whose newest loop comment is FIXING, across every page of comments", async () => {
  const many = Array.from({ length: 100 }, (_x, i) => row(`human chatter ${i}`, "2026-01-01T12:00:00Z", "alice"));
  const pages = {
    "/repos/o/r/pulls?state=open": [{ number: 7 }, { number: 8 }, { number: 9 }],
    "/repos/o/r/issues/7/comments": [start, fixing()],
    // PR 8: FIXING is on the SECOND page of its comments (100 rows before it)
    "/repos/o/r/issues/8/comments": [start, ...many, fixing()],
    // PR 9: the round ended in a continuation
    "/repos/o/r/issues/9/comments": [start, fixing(), row(continueComment({ mode: "apply", round: 3, pr: 9, head: HEAD }), "2026-01-03T00:00:00Z")],
  };
  const { impl, urls } = fakeFetch(pages);
  const hits = await listFixing({ repos: [{ owner: "o", repo: "r" }], token: "t", botLogin: BOT, fetchImpl: impl });
  assert.deepEqual(hits.map((h) => h.pr), ["o/r#7", "o/r#8"]);
  assert.ok(urls.some((u) => u.includes("/issues/8/comments") && u.includes("page=2")), "the second page was read");
});

test("listFixing: a failed page fails the check (exit 2 in main) — a partial list never reads as «0 at FIXING»", async () => {
  const { impl } = fakeFetch({ "/repos/o/r/pulls?state=open": [{ number: 7 }] }, { fail: "/issues/7/comments" });
  await assert.rejects(listFixing({ repos: [{ owner: "o", repo: "r" }], token: "t", botLogin: BOT, fetchImpl: impl }), /\/issues\/7\/comments failed \(502\)/);
});
