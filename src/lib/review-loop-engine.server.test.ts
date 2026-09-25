import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  controlInSession,
  CURRENT_ROUND_MISSING,
  escalateNow,
  maybeEscalate,
  readLoopEvents,
  readLoopSession,
  reconstructRounds,
  type ReviewLoopGithub,
} from "./review-loop-engine.server.ts";
import { continueComment, INCOMPLETE_OUTCOME_MARKER, startComment, stoppedComment } from "./review-loop.ts";

const BOT = "ashlar-bot-review-loop[bot]";

function findingsBody(total: number): string {
  return `### Ashlar Review\nReviewed commit\n<!-- ashlar-findings total=${total} inline=${total} body=0 p0=0 p1=${total} p2=0 -->`;
}

/** Build a fake GitHub client from per-head round specs. */
function fakeGh(
  rounds: Array<{ head: string; findings: number; files: string[]; at: string }>,
  issueComments: Array<{ userLogin: string; body: string }> = [],
): { gh: ReviewLoopGithub; posted: string[] } {
  const posted: string[] = [];
  const gh: ReviewLoopGithub = {
    async listPullReviews() {
      // two reviews per head (explicit + synchronize) to prove dedup-by-head
      return rounds.flatMap((r) => [
        { userLogin: BOT, body: findingsBody(r.findings), commitId: r.head, submittedAt: r.at },
        { userLogin: BOT, body: findingsBody(r.findings), commitId: r.head, submittedAt: r.at + "1" },
      ]);
    },
    async listReviewComments() {
      return rounds.flatMap((r) =>
        r.files.map((f) => ({ userLogin: BOT, path: f, commitId: r.head, createdAt: r.at })),
      );
    },
    async listIssueComments() {
      return issueComments;
    },
    async createIssueComment(_t, opts) {
      posted.push(opts.body);
      return { id: posted.length };
    },
  };
  return { gh, posted };
}

describe("reconstructRounds", () => {
  it("collapses multiple reviews on the same head into one round, ordered by time", async () => {
    const { gh } = fakeGh([
      { head: "aaaaaaa", findings: 6, files: ["x.ts"], at: "2026-01-01T00:00:00Z" },
      { head: "bbbbbbb", findings: 3, files: ["y.ts"], at: "2026-01-01T01:00:00Z" },
    ]);
    const rounds = await reconstructRounds(gh, "t", "o", "r", 1);
    assert.equal(rounds.length, 2);
    assert.deepEqual(rounds.map((r) => [r.index, r.findings, r.head]), [
      [1, 6, "aaaaaaa"],
      [2, 3, "bbbbbbb"],
    ]);
    assert.deepEqual(rounds[0].files, ["x.ts"]);
  });
});

describe("maybeEscalate", () => {
  const files = ["src/lib/review-loop.ts"];
  const pr68 = [6, 4, 3, 4, 3, 3].map((n, i) => ({
    head: `head${i}`.padEnd(40, `${i}`),
    findings: n,
    files,
    at: `2026-01-0${i + 1}T00:00:00Z`,
  }));
  const pr68Head = pr68[pr68.length - 1].head;

  it("emits a fixed ESCALATE handoff on a stuck (whack-a-mole) loop", async () => {
    const { gh, posted } = fakeGh(pr68);
    const res = await maybeEscalate(gh, "t", { owner: "o", repo: "r", pr: 68, head: pr68Head, roundCap: 8 });
    assert.equal(res.escalated, true);
    assert.equal(res.reason, "whack-a-mole");
    assert.equal(posted.length, 1);
    assert.ok(posted[0].includes("<!-- ashlar-loop-escalate reason=whack-a-mole"));
    assert.ok(posted[0].includes("Ashlar review-loop halted"));
  });

  it("does not escalate a converged or still-progressing loop", async () => {
    const conv = fakeGh([
      { head: "aaaaaaa", findings: 3, files, at: "2026-01-01T00:00:00Z" },
      { head: "bbbbbbb", findings: 0, files: [], at: "2026-01-02T00:00:00Z" },
    ]);
    const r1 = await maybeEscalate(conv.gh, "t", { owner: "o", repo: "r", pr: 1, head: "bbbbbbb", roundCap: 8 });
    assert.equal(r1.escalated, false);
    assert.equal(conv.posted.length, 0);

    const prog = fakeGh([
      { head: "aaaaaaa", findings: 5, files: ["a.ts"], at: "2026-01-01T00:00:00Z" },
      { head: "bbbbbbb", findings: 3, files: ["b.ts"], at: "2026-01-02T00:00:00Z" },
      { head: "ccccccc", findings: 1, files: ["c.ts"], at: "2026-01-03T00:00:00Z" },
    ]);
    const r2 = await maybeEscalate(prog.gh, "t", { owner: "o", repo: "r", pr: 2, head: "ccccccc", roundCap: 8 });
    assert.equal(r2.escalated, false);
    assert.equal(prog.posted.length, 0);
  });

  it("is idempotent: does not re-emit when an escalate for this head already exists", async () => {
    const existing = [{ userLogin: BOT, body: `<!-- ashlar-loop-escalate reason=whack-a-mole round=6 pr=68 head=${pr68Head} -->` }];
    const { gh, posted } = fakeGh(pr68, existing);
    const res = await maybeEscalate(gh, "t", { owner: "o", repo: "r", pr: 68, head: pr68Head, roundCap: 8 });
    assert.equal(res.escalated, false);
    assert.equal(res.reason, "whack-a-mole"); // still classified, just not re-posted
    assert.equal(posted.length, 0);
  });
});

describe("maybeEscalate — provenance, session boundary, fail-closed (round-1 fixes)", () => {
  const files = ["src/lib/review-loop.ts"];
  const bot = "ashlar-bot-review-loop[bot]";

  it("F3: a non-bot login containing 'ashlar' does not contribute rounds", async () => {
    // all reviews authored by 'ashlar-fan' (not the exact bot) → no rounds → no escalate
    const rounds = [6, 4, 3].map((n, i) => ({ head: `h${i}`.padEnd(7, "0"), findings: n, files, at: `2026-01-0${i + 1}T00:00:00Z` }));
    const gh = {
      async listPullReviews() {
        return rounds.map((r) => ({ userLogin: "ashlar-fan", body: `<!-- ashlar-findings total=${r.findings} -->`, commitId: r.head + "0000000", submittedAt: r.at }));
      },
      async listReviewComments() { return []; },
      async listIssueComments() { return []; },
      async createIssueComment() { return { id: 1 }; },
    };
    const res = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "h2000000", roundCap: 8 });
    assert.equal(res.rounds.length, 0);
    assert.equal(res.escalated, false);
  });

  it("F4: reviews before the loop's sinceIso are excluded from round history", async () => {
    const gh = {
      async listPullReviews() {
        return [
          { userLogin: bot, body: "<!-- ashlar-findings total=5 -->", commitId: "old0000" + "0", submittedAt: "2026-01-01T00:00:00Z" },
          { userLogin: bot, body: "<!-- ashlar-findings total=4 -->", commitId: "new0000" + "0", submittedAt: "2026-06-01T00:00:00Z" },
        ];
      },
      async listReviewComments() { return [{ userLogin: bot, path: files[0], commitId: "old00000", createdAt: "2026-01-01T00:00:00Z" }, { userLogin: bot, path: files[0], commitId: "new00000", createdAt: "2026-06-01T00:00:00Z" }]; },
      async listIssueComments() { return []; },
      async createIssueComment() { return { id: 1 }; },
    };
    const all = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "new0000", roundCap: 8 });
    assert.equal(all.rounds.length, 2);
    const scoped = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "new0000", roundCap: 8, sinceIso: "2026-05-01T00:00:00Z" });
    assert.equal(scoped.rounds.length, 1, "only the in-session review counts");
  });

  it("F6: an incomplete/failed history read fails closed (no classify, no post)", async () => {
    const gh = {
      // two reviewed heads with the budget (cap 1) spent → a stuck reason → the idempotency read runs
      async listPullReviews() {
        return [
          { userLogin: bot, body: "<!-- ashlar-findings total=6 -->", commitId: "g0000000", submittedAt: "2026-01-01T00:00:00Z" },
          { userLogin: bot, body: "<!-- ashlar-findings total=5 -->", commitId: "h0000000", submittedAt: "2026-01-02T00:00:00Z" },
        ];
      },
      async listReviewComments() { return [{ userLogin: bot, path: files[0], commitId: "h0000000", createdAt: "2026-01-02T00:00:00Z" }]; },
      async listIssueComments() { throw new Error("list issues failed (502)"); },
      async createIssueComment() { throw new Error("must not post on incomplete history"); },
    };
    const res = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "h0000000", roundCap: 1 });
    assert.equal(res.escalated, false);
    assert.match(res.error ?? "", /list issues failed/);
  });
});

describe("engine round-2 fixes", () => {
  const bot = "ashlar-bot-review-loop[bot]";

  it("G8: two full SHAs sharing a 7-char prefix are distinct rounds", async () => {
    const a = "abcdef1" + "1".repeat(33);
    const b = "abcdef2" + "2".repeat(33); // same first 6, differ at char 7
    const gh = {
      async listPullReviews() {
        return [
          { userLogin: bot, body: "<!-- ashlar-findings total=3 -->", commitId: a, submittedAt: "2026-01-01T00:00:00Z" },
          { userLogin: bot, body: "<!-- ashlar-findings total=2 -->", commitId: b, submittedAt: "2026-01-02T00:00:00Z" },
        ];
      },
      async listReviewComments() { return []; },
      async listIssueComments() { return []; },
      async createIssueComment() { return { id: 1 }; },
    };
    const res = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: b, roundCap: 8 });
    assert.equal(res.rounds.length, 2, "distinct full SHAs must not collapse");
  });

  it("G6: a pre-session inline comment does not leak into the current loop's file history", async () => {
    const head = "h".repeat(40);
    const gh = {
      async listPullReviews() {
        // in-session review of head with NO x.ts finding
        return [{ userLogin: bot, body: "<!-- ashlar-findings total=1 -->", commitId: head, submittedAt: "2026-06-01T00:00:00Z" }];
      },
      async listReviewComments() {
        // an OLD (pre-session) comment on the same head flagging x.ts
        return [{ userLogin: bot, path: "x.ts", commitId: head, createdAt: "2026-01-01T00:00:00Z" }];
      },
      async listIssueComments() { return []; },
      async createIssueComment() { return { id: 1 }; },
    };
    const rounds = await reconstructRounds(gh as never, "t", "o", "r", 1, { sinceIso: "2026-05-01T00:00:00Z" });
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0].files, [], "pre-session comment must not attach to the in-session round");
  });

  it("G7: concurrent maybeEscalate for the same head posts at most once", async () => {
    const pr68 = [6, 4, 3, 4, 3, 3];
    let posts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const gh = {
      async listPullReviews() {
        return pr68.map((n, i) => ({ userLogin: bot, body: `<!-- ashlar-findings total=${n} -->`, commitId: `c${i}`.padEnd(40, "0"), submittedAt: `2026-01-0${i + 1}T00:00:00Z` }));
      },
      async listReviewComments() { return pr68.map((_n, i) => ({ userLogin: bot, path: "src/a.ts", commitId: `c${i}`.padEnd(40, "0"), createdAt: `2026-01-0${i + 1}T00:00:00Z` })); },
      async listIssueComments() { await gate; return []; }, // hold both past the idempotency check
      async createIssueComment() { posts += 1; return { id: posts }; },
    };
    const head = "c5".padEnd(40, "0");
    const p1 = maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 68, head, roundCap: 8 });
    const p2 = maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 68, head, roundCap: 8 });
    release();
    await Promise.all([p1, p2]);
    assert.equal(posts, 1, "the in-process guard serializes same-head escalation");
  });

  it("H5: does not classify when the latest reconstructed head is not the requested head (force-push)", async () => {
    // stuck rounds on an OLD lineage; the current head is a divergent replacement not yet reviewed
    const gh = {
      async listPullReviews() {
        return [4, 4, 4].map((n, i) => ({ userLogin: bot, body: `<!-- ashlar-findings total=${n} -->`, commitId: `old${i}`.padEnd(40, "o"), submittedAt: `2026-01-0${i + 1}T00:00:00Z` }));
      },
      async listReviewComments() { return [4, 4, 4].map((_n, i) => ({ userLogin: bot, path: "a.ts", commitId: `old${i}`.padEnd(40, "o"), createdAt: `2026-01-0${i + 1}T00:00:00Z` })); },
      async listIssueComments() { return []; },
      async createIssueComment() { throw new Error("must not escalate for a divergent head"); },
    };
    const res = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "newDivergentHead".padEnd(40, "n"), roundCap: 3 });
    assert.equal(res.escalated, false);
  });
});

describe("engine: termination contract (budget + failure handoffs)", () => {
  const bot = "ashlar-bot-review-loop[bot]";
  const review = (total: number, head: string, at: string) => ({ userLogin: bot, body: `<!-- ashlar-findings total=${total} -->`, commitId: head, submittedAt: at });

  it("requireCurrentRound fails closed when the reviewed head is not the latest attributable round", async () => {
    const posted: string[] = [];
    const gh = {
      async listPullReviews() { return [review(3, "a".repeat(40), "2026-01-01T00:00:00Z")]; },
      async listReviewComments() { return []; },
      async listIssueComments() { return []; },
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    const head = "b".repeat(40);
    const strict = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head, roundCap: 5, requireCurrentRound: true });
    assert.equal(strict.error, CURRENT_ROUND_MISSING);
    const empty = { ...gh, async listPullReviews() { return []; } };
    const none = await maybeEscalate(empty as never, "t", { owner: "o", repo: "r", pr: 1, head, roundCap: 5, requireCurrentRound: true });
    assert.equal(none.error, CURRENT_ROUND_MISSING, "no attributable history (e.g. wrong bot login) never fixes blind");
    const lax = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head, roundCap: 5 });
    assert.equal(lax.error, undefined);
    assert.deepEqual(posted, []);
  });

  it("escalateNow posts one fixed handoff per head with the detail, and is idempotent", async () => {
    const issues: Array<{ userLogin: string; body: string }> = [];
    const gh = {
      async listPullReviews() { return []; },
      async listReviewComments() { return []; },
      async listIssueComments() { return issues; },
      async createIssueComment(_t: string, o: { body: string }) { issues.push({ userLogin: bot, body: o.body }); return { id: issues.length }; },
    };
    const head = "c".repeat(40);
    const opts = { owner: "o", repo: "r", pr: 3, head, reason: "fix-failed" as const, detail: "parse-failed after 2 attempt(s): bad json", rounds: [], roundCap: 5 };
    assert.deepEqual(await escalateNow(gh as never, "t", opts), { escalated: true });
    assert.match(issues[0].body, /reason=fix-failed/);
    assert.match(issues[0].body, /Detail: parse-failed after 2 attempt\(s\): bad json/);
    assert.deepEqual(await escalateNow(gh as never, "t", { ...opts, reason: "loop-error" }), { escalated: false });
    assert.equal(issues.length, 1, "one handoff per head");
  });

  it("escalateNow still posts when the idempotency read fails (the failure is the signal)", async () => {
    const posted: string[] = [];
    const gh = {
      async listPullReviews() { return []; },
      async listReviewComments() { return []; },
      async listIssueComments() { throw new Error("502"); },
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    const r = await escalateNow(gh as never, "t", { owner: "o", repo: "r", pr: 3, head: "d".repeat(40), reason: "loop-error", detail: "x", rounds: [], roundCap: 5 });
    assert.equal(r.escalated, true);
    assert.equal(posted.length, 1);
  });
});

describe("round-cap handoff keeps the trend pattern in its detail", () => {
  const bot = "ashlar-bot-review-loop[bot]";
  it("budget spent on a whack-a-mole history → reason round-cap, detail names the pattern", async () => {
    const heads = ["a", "b", "c"].map((c) => c.repeat(40));
    const posted: string[] = [];
    const gh = {
      async listPullReviews() {
        return [6, 4, 4].map((n, i) => ({ userLogin: bot, body: `<!-- ashlar-findings total=${n} -->`, commitId: heads[i], submittedAt: `2026-01-0${i + 1}T00:00:00Z` }));
      },
      async listReviewComments() {
        return heads.map((h, i) => ({ userLogin: bot, path: "src/x.ts", commitId: h, createdAt: `2026-01-0${i + 1}T00:00:00Z` }));
      },
      async listIssueComments() { return []; },
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    const r = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: heads[2], roundCap: 2 });
    assert.equal(r.reason, "round-cap");
    assert.match(posted[0], /reason=round-cap/);
    assert.match(posted[0], /Detail: fix-round budget spent; the finding trend also shows whack-a-mole/);
  });
});

describe("escalateNow: one handoff per head per session, even when the history is unreadable", () => {
  const bot = "ashlar-bot-review-loop[bot]";
  it("a sequential redelivery with a failing history read does not post a duplicate", async () => {
    const posted: string[] = [];
    const gh = {
      async listPullReviews() { return []; },
      async listReviewComments() { return []; },
      async listIssueComments(): Promise<Array<{ userLogin: string; body: string }>> { throw new Error("502"); },
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    const opts = { owner: "o", repo: "r", pr: 9, head: "e".repeat(40), reason: "fix-failed" as const, detail: "x", rounds: [], roundCap: 5, sinceIso: "2026-01-01T00:00:00Z" };
    assert.equal((await escalateNow(gh as never, "t", opts)).escalated, true);
    assert.equal((await escalateNow(gh as never, "t", opts)).escalated, false);
    assert.equal(posted.length, 1);
    // a NEW session (a later anchor) on the same head may hand off again
    assert.equal((await escalateNow(gh as never, "t", { ...opts, sinceIso: "2026-02-01T00:00:00Z" })).escalated, true);
    assert.equal(posted.length, 2);
    void bot;
  });
});

describe("durable loop events: authorship is enforced when reading history", () => {
  const bot = "ashlar-bot-review-loop[bot]";
  type Row = { userLogin: string; body: string; createdAt: string; updatedAt?: string };
  const recorded = (mode: "apply" | "suggest", by: string, at: string) => ({ userLogin: bot, body: startComment({ mode, by, at }), createdAt: at });
  const gh = (issues: Row[], inline: Row[] = [], reviews: Array<{ userLogin: string; body: string; submittedAt: string }> = []) => ({
    async listIssueComments() { return issues; },
    async listReviewComments() { return inline.map((c) => ({ ...c, path: "a.ts", commitId: "c" })); },
    async listPullReviews() { return reviews.map((r) => ({ ...r, commitId: "c" })); },
    async createIssueComment() { return { id: 1 }; },
  });

  it("starts come ONLY from the App's start record; humans contribute stops; the App contributes markers and CONVERGED", async () => {
    const g = gh(
      [
        recorded("apply", "alice", "2026-01-01T00:00:00Z"),
        { userLogin: "alice", body: "/review-loop apply", createdAt: "2026-01-01T00:00:00Z" }, // human text: NOT a start
        { userLogin: "mallory", body: startComment({ mode: "apply", by: "mallory", at: "2025-01-01T00:00:00Z" }), createdAt: "2026-01-01T00:30:00Z" }, // human copy: NOT a start
        { userLogin: bot, body: "quoting /review-loop apply in a report", createdAt: "2026-01-01T01:00:00Z" }, // bot prose: NOT a start
        { userLogin: bot, body: "<!-- ashlar-loop-escalate reason=round-cap round=6 pr=1 head=x -->", createdAt: "2026-01-02T00:00:00Z" },
        { userLogin: "mallory", body: "<!-- ashlar-loop-stopped -->", createdAt: "2026-01-02T01:00:00Z" }, // human marker: NOT stopped
        { userLogin: "bob", body: "/review-loop stop", createdAt: "2026-01-03T00:00:00Z" },
      ],
      [{ userLogin: "carol", body: "please /review-loop stop", createdAt: "2026-01-04T00:00:00Z" }],
      [
        { userLogin: bot, body: "<!-- ashlar-findings total=0 -->", submittedAt: "2026-01-05T00:00:00Z" },
        { userLogin: "mallory", body: "<!-- ashlar-findings total=0 -->", submittedAt: "2026-01-05T01:00:00Z" }, // spoof: NOT converged
      ],
    );
    const events = await readLoopEvents(g as never, "t", "o", "r", 1);
    const kinds = events.map((e) => `${e.kind}@${e.at}${e.actor ? `:${e.actor}` : ""}${e.mode ? `:${e.mode}` : ""}`).sort();
    assert.deepEqual(kinds, [
      "converged@2026-01-05T00:00:00Z",
      "escalate@2026-01-02T00:00:00Z",
      "start@2026-01-01T00:00:00Z:alice:apply",
      "stop@2026-01-03T00:00:00Z:bob",
      "stop@2026-01-04T00:00:00Z:carol",
    ]);
  });

  it("an EDITED comment is never replayed at its creation time (it cannot backdate a stop or a start)", async () => {
    const g = gh(
      [
        recorded("apply", "alice", "2026-01-02T00:00:00Z"),
        // a benign comment from before the session, edited later to a stop / a start
        { userLogin: "bob", body: "/review-loop stop", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
        { userLogin: "bob", body: "/review-loop apply", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
      ],
      [{ userLogin: "carol", body: "/review-loop stop", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-04T00:00:00Z" }],
    );
    const events = await readLoopEvents(g as never, "t", "o", "r", 1);
    assert.deepEqual(events.map((e) => e.kind), ["start"], "only the recorded start");
    assert.equal((await readLoopSession(g as never, "t", "o", "r", 1)).active, true);
    // an unedited stop (updated_at equal to created_at) still counts
    const plain = gh([recorded("apply", "alice", "2026-01-02T00:00:00Z"), { userLogin: "bob", body: "/review-loop stop", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" }]);
    assert.equal((await readLoopSession(plain as never, "t", "o", "r", 1)).endedBy, "stop");
  });

  it("the App's canonical continuation for THIS PR is a head move; a clean review carries its commit", async () => {
    const live = "b".repeat(40);
    const cont = (pr: number, head = live) => continueComment({ mode: "apply", round: 2, pr, head });
    const g = gh(
      [
        recorded("apply", "alice", "2026-01-01T00:00:00Z"),
        { userLogin: bot, body: cont(1), createdAt: "2026-01-02T00:00:00Z" },
        { userLogin: bot, body: cont(2, "c".repeat(40)), createdAt: "2026-01-02T00:00:01Z" }, // another PR: NOT a head move here
        { userLogin: bot, body: `${cont(1, "d".repeat(40))}\n\nquoted in a report`, createdAt: "2026-01-02T00:00:02Z" }, // not canonical
        { userLogin: "mallory", body: cont(1, "e".repeat(40)), createdAt: "2026-01-02T00:00:03Z" }, // human copy: NOT a head move
      ],
      [],
      [{ userLogin: bot, body: "<!-- ashlar-findings total=0 -->", submittedAt: "2026-01-03T00:00:00Z" }],
    );
    const events = await readLoopEvents(g as never, "t", "o", "r", 1);
    assert.deepEqual(
      events.filter((e) => e.kind === "continue" || e.kind === "converged").map((e) => `${e.kind}:${e.head}`),
      [`continue:${live}`, "converged:c"],
    );
    // the stale clean review (commit "c") does not end the session: the loop waits on the live head
    assert.equal((await readLoopSession(g as never, "t", "o", "r", 1, { pr: { sha: live } })).active, true);
    assert.equal((await readLoopSession(g as never, "t", "o", "r", 1, { pr: { sha: "c" } })).active, false, "clean on the live head");
  });

  it("an incomplete review is read from its fixed trailing marker, the App's own only: it ends the session owing a handoff for its head", async () => {
    const body = `<!-- ashlar-review-summary -->\nChatGPT/Grok did not finish a full review.\n\nNot a clean pass — remaining reviewers did not run.\n${INCOMPLETE_OUTCOME_MARKER}`;
    const g = gh(
      [recorded("apply", "alice", "2026-01-01T00:00:00Z"), { userLogin: bot, body: "<!-- ashlar-loop-escalate reason=loop-error round=1 pr=1 head=h -->", createdAt: "2025-12-01T00:00:00Z" }],
      [],
      [
        { userLogin: bot, body, submittedAt: "2026-01-02T00:00:00Z" },
        { userLogin: "mallory", body, submittedAt: "2026-01-02T01:00:00Z" }, // human copy: NOT incomplete
        { userLogin: bot, body: `${INCOMPLETE_OUTCOME_MARKER}\nquoted, not trailing`, submittedAt: "2026-01-02T02:00:00Z" }, // prose
      ],
    );
    const events = await readLoopEvents(g as never, "t", "o", "r", 1);
    assert.deepEqual(events.filter((e) => e.kind === "incomplete").map((e) => `${e.at}:${e.head}`), ["2026-01-02T00:00:00Z:c"]);
    assert.deepEqual(events.filter((e) => e.kind === "escalate").map((e) => e.head), ["h"], "a handoff carries its head");
    const session = await readLoopSession(g as never, "t", "o", "r", 1, { pr: { sha: "c" } });
    assert.equal(session.active, false);
    assert.equal(session.endedBy, "incomplete", "never converged");
    assert.deepEqual(session.owedHandoff, { head: "c", startIso: "2026-01-01T00:00:00Z", startSeq: undefined });
  });

  it("readLoopSession folds history + injected events (a stop the list API has not caught up with)", async () => {
    const g = gh([recorded("apply", "alice", "2026-01-01T00:00:00Z")]);
    assert.equal((await readLoopSession(g as never, "t", "o", "r", 1)).active, true);
    const stopped = await readLoopSession(g as never, "t", "o", "r", 1, { extra: [{ at: "2026-01-02T00:00:00Z", kind: "stop", actor: "bob" }] });
    assert.equal(stopped.endedBy, "stop");
  });
});

describe("round-3: instants, not strings; the trailing findings marker only", () => {
  const A = "a".repeat(40);
  it("a second-precision row just before a millisecond session anchor is OUT of the session", async () => {
    const { gh } = fakeGh([{ head: A, findings: 3, files: ["x.ts"], at: "2026-01-01T00:00:00Z" }]);
    assert.equal((await reconstructRounds(gh, "t", "o", "r", 1, { sinceIso: "2026-01-01T00:00:00.500Z" })).length, 0);
    assert.equal((await reconstructRounds(gh, "t", "o", "r", 1, { sinceIso: "2025-12-31T23:59:59.500Z" })).length, 1);
  });

  it("an older handoff never silences a new session anchored a fraction of a second later", async () => {
    const marker = `<!-- ashlar-loop-escalate reason=fix-failed round=1 pr=1 head=${A} -->`;
    const { gh, posted } = fakeGh([], []);
    gh.listIssueComments = async () => [{ userLogin: BOT, body: marker, createdAt: "2026-01-01T00:00:00Z" }];
    const r = await escalateNow(gh, "t", { owner: "o", repo: "r", pr: 1, head: A, reason: "fix-failed", rounds: [], roundCap: 5, sinceIso: "2026-01-01T00:00:00.500Z" });
    assert.equal(r.escalated, true, "the pre-session handoff is out of scope");
    assert.equal(posted.length, 1);
  });

  it("a review that QUOTES a zero marker before its trailing count is not a clean round", async () => {
    const body = "### Ashlar Review\n- finding quoting <!-- ashlar-findings total=0 --> in prose\n<!-- ashlar-findings total=2 inline=2 -->";
    const gh = {
      async listIssueComments() {
        return [{ userLogin: BOT, body: startComment({ mode: "apply", by: "alice", at: "2026-01-01T00:00:00Z" }), createdAt: "2026-01-01T00:00:00Z" }];
      },
      async listReviewComments() { return []; },
      async listPullReviews() { return [{ userLogin: BOT, body, commitId: A, submittedAt: "2026-01-02T00:00:00Z" }]; },
      async createIssueComment() { return { id: 1 }; },
    };
    const rounds = await reconstructRounds(gh, "t", "o", "r", 1);
    assert.deepEqual(rounds.map((r) => r.findings), [2]);
    const events = await readLoopEvents(gh, "t", "o", "r", 1);
    assert.equal(events.some((e) => e.kind === "converged"), false);
    assert.equal((await readLoopSession(gh, "t", "o", "r", 1)).active, true);
  });
});

describe("round-5: exact session scoping and read-after-write lag", () => {
  const H = "a".repeat(40);
  const T = "2026-01-01T12:00:00Z";
  const escalateMarker = `<!-- ashlar-loop-escalate reason=fix-failed round=1 pr=1 head=${H} -->`;
  const client = (issues: Array<{ id: number; userLogin: string; body: string; createdAt: string }>) => {
    const posted: string[] = [];
    const gh = {
      async listIssueComments() { return issues; },
      async listReviewComments() { return []; },
      async listPullReviews() { return []; },
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 999 }; },
    };
    return { gh, posted };
  };

  it("an old handoff in the SAME second as a new session's start never silences the new session", async () => {
    const { gh, posted } = client([
      { id: 10, userLogin: BOT, body: escalateMarker, createdAt: T }, // session A's handoff
      { id: 11, userLogin: BOT, body: startComment({ mode: "apply", by: "alice", at: T }), createdAt: T }, // session B's start record
    ]);
    const session = await readLoopSession(gh as never, "t", "o", "r", 1);
    assert.equal(session.active, true);
    assert.equal(session.startSeq, 11);
    const r = await escalateNow(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: H, reason: "fix-failed", rounds: [], roundCap: 5, sinceIso: session.startIso, sinceSeq: session.startSeq });
    assert.equal(r.escalated, true, "B gets its own handoff");
    assert.equal(posted.length, 1);
  });

  it("a review in the start's own second belongs to what came before (rounds are strictly later)", async () => {
    const { gh } = fakeGh([{ head: H, findings: 3, files: ["x.ts"], at: T }]);
    assert.equal((await reconstructRounds(gh, "t", "o", "r", 1, { sinceIso: T })).length, 0);
    assert.equal((await reconstructRounds(gh, "t", "o", "r", 1, { sinceIso: "2026-01-01T11:59:59Z" })).length, 1);
  });

  it("controlInSession uses comment ids when both are known, else strictly later time", () => {
    assert.equal(controlInSession({ id: 12, createdAt: T }, { iso: T, seq: 11 }), true);
    assert.equal(controlInSession({ id: 10, createdAt: T }, { iso: T, seq: 11 }), false);
    assert.equal(controlInSession({ createdAt: "2026-01-01T12:00:01Z" }, { iso: T }), true);
    assert.equal(controlInSession({ createdAt: T }, { iso: T }), false);
  });

  it("a just-posted handoff counts while a readable list still omits it (no duplicate)", async () => {
    const { gh, posted } = client([]); // the list never shows what was posted
    const opts = { owner: "o", repo: "r", pr: 1, head: H, reason: "fix-failed" as const, rounds: [], roundCap: 5, sinceIso: T, sinceSeq: 11 };
    assert.equal((await escalateNow(gh as never, "t", opts)).escalated, true);
    assert.equal((await escalateNow(gh as never, "t", opts)).escalated, false);
    assert.equal(posted.length, 1);
  });

  it("a recorded stop ends the session at the STOP's time, not at its acknowledgement's", async () => {
    const { gh } = client([
      { id: 1, userLogin: BOT, body: startComment({ mode: "apply", by: "alice", at: "2026-01-01T00:00:00Z" }), createdAt: "2026-01-01T00:00:00Z" },
      { id: 2, userLogin: BOT, body: startComment({ mode: "apply", by: "carol", at: "2026-01-03T00:00:00Z" }), createdAt: "2026-01-03T00:00:00Z" },
      { id: 3, userLogin: BOT, body: stoppedComment({ by: "bob", at: "2026-01-02T00:00:00Z" }), createdAt: "2026-01-04T00:00:00Z" }, // late ack
    ]);
    const s1 = await readLoopSession(gh as never, "t", "o", "r", 1);
    assert.deepEqual({ active: s1.active, startIso: s1.startIso, starter: s1.starter, startSeq: s1.startSeq }, { active: true, startIso: "2026-01-03T00:00:00Z", starter: "carol", startSeq: 2 });
  });
});

describe("round-6: both handoff paths share the just-posted cache", () => {
  it("maybeEscalate never double-posts a stuck handoff while the list still omits the first", async () => {
    const H = "c".repeat(40);
    const posted: string[] = [];
    const reviews = [5, 4, 4].map((n, i) => ({ userLogin: BOT, body: findingsBody(n), commitId: i === 2 ? H : `h${i}`.padEnd(40, "0"), submittedAt: `2026-01-0${i + 2}T00:00:00Z` }));
    const gh = {
      async listPullReviews() { return reviews; },
      async listReviewComments() { return reviews.map((r) => ({ userLogin: BOT, path: "a.ts", commitId: r.commitId, createdAt: r.submittedAt })); },
      async listIssueComments() { return []; }, // never catches up
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    const opts = { owner: "o", repo: "r", pr: 3, head: H, roundCap: 5, sinceIso: "2026-01-01T00:00:00Z", sinceSeq: 1 };
    assert.equal((await maybeEscalate(gh as never, "t", opts)).escalated, true);
    const again = await maybeEscalate(gh as never, "t", opts);
    assert.equal(again.escalated, false);
    assert.equal(posted.length, 1);
  });
});

describe("round-6: the two handoff paths see each other's just-posted handoff", () => {
  const H = "d".repeat(40);
  const stuck = () => {
    const posted: string[] = [];
    const reviews = [5, 4, 4].map((n, i) => ({ userLogin: BOT, body: findingsBody(n), commitId: i === 2 ? H : `k${i}`.padEnd(40, "0"), submittedAt: `2026-01-0${i + 2}T00:00:00Z` }));
    const gh = {
      async listPullReviews() { return reviews; },
      async listReviewComments() { return reviews.map((r) => ({ userLogin: BOT, path: "a.ts", commitId: r.commitId, createdAt: r.submittedAt })); },
      async listIssueComments() { return []; }, // never catches up
      async createIssueComment(_t: string, o: { body: string }) { posted.push(o.body); return { id: 1 }; },
    };
    return { gh, posted };
  };
  const session = { sinceIso: "2026-01-01T00:00:00Z", sinceSeq: 1 };

  it("escalateNow first, then maybeEscalate: one handoff", async () => {
    const { gh, posted } = stuck();
    assert.equal((await escalateNow(gh as never, "t", { owner: "o", repo: "r", pr: 4, head: H, reason: "fix-failed", rounds: [], roundCap: 5, ...session })).escalated, true);
    const m = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 4, head: H, roundCap: 5, ...session });
    assert.equal(m.escalated, false);
    assert.equal(posted.length, 1);
  });

  it("maybeEscalate first, then escalateNow: one handoff", async () => {
    const { gh, posted } = stuck();
    assert.equal((await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 4, head: H, roundCap: 5, ...session })).escalated, true);
    assert.equal((await escalateNow(gh as never, "t", { owner: "o", repo: "r", pr: 4, head: H, reason: "fix-failed", rounds: [], roundCap: 5, ...session })).escalated, false);
    assert.equal(posted.length, 1);
  });
});

describe("terminal handoffs retry a transient POST failure (a handoff has no other poster)", () => {
  const H = "e".repeat(40);
  const session = { sinceIso: "2026-01-01T00:00:00Z", sinceSeq: 1 };
  /** `plan[i]`: attempt i "ok", "fail" (GitHub rejected it), or "lost" (accepted, response lost). */
  const flaky = (plan: Array<"ok" | "fail" | "lost">, stuck = false) => {
    const stored: Array<{ id: number; userLogin: string; body: string; createdAt: string; updatedAt: string }> = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const reviews = stuck
      ? [5, 4, 4].map((n, i) => ({ userLogin: BOT, body: findingsBody(n), commitId: i === 2 ? H : `m${i}`.padEnd(40, "0"), submittedAt: `2026-01-0${i + 2}T00:00:00Z` }))
      : [];
    const gh = {
      async listPullReviews() { return reviews; },
      async listReviewComments() { return reviews.map((r) => ({ userLogin: BOT, path: "a.ts", commitId: r.commitId, createdAt: r.submittedAt })); },
      async listIssueComments() { return [...stored]; },
      async createIssueComment(_t: string, o: { body: string }) {
        const outcome = plan[Math.min(attempts++, plan.length - 1)];
        if (outcome === "fail") throw new Error("comment POST 502");
        const at = `2026-02-01T00:00:0${stored.length + 1}Z`;
        stored.push({ id: stored.length + 10, userLogin: BOT, body: o.body, createdAt: at, updatedAt: at });
        if (outcome === "lost") throw new Error("GitHub API timeout");
        return { id: stored.length + 9 };
      },
    };
    const sleep = async (ms: number) => void sleeps.push(ms);
    return { gh, stored, sleeps, attempts: () => attempts, sleep };
  };
  const now = (f: ReturnType<typeof flaky>, pr: number) =>
    escalateNow(f.gh as never, "t", { owner: "o", repo: "r", pr, head: H, reason: "fix-failed", rounds: [], roundCap: 5, ...session, sleep: f.sleep });

  it("escalateNow posts on the retry after one failed POST", async () => {
    const f = flaky(["fail", "ok"]);
    assert.deepEqual(await now(f, 11), { escalated: true });
    assert.equal(f.stored.length, 1);
    assert.deepEqual(f.sleeps, [2_000]);
  });

  it("escalateNow never re-posts a handoff GitHub accepted whose response was lost", async () => {
    const f = flaky(["lost", "ok"]);
    assert.deepEqual(await now(f, 12), { escalated: false });
    assert.equal(f.attempts(), 1, "the retry's scan saw the accepted handoff");
    assert.equal(f.stored.length, 1);
  });

  it("escalateNow reports the failure after the last attempt", async () => {
    const f = flaky(["fail"]);
    const r = await now(f, 13);
    assert.equal(r.escalated, false);
    assert.match(r.error ?? "", /502/);
    assert.equal(f.attempts(), 3);
    assert.deepEqual(f.sleeps, [2_000, 5_000]);
  });

  it("the round-cap handoff (maybeEscalate) retries too", async () => {
    const f = flaky(["fail", "ok"], true);
    const r = await maybeEscalate(f.gh as never, "t", { owner: "o", repo: "r", pr: 14, head: H, roundCap: 5, ...session, sleep: f.sleep });
    assert.equal(r.escalated, true);
    assert.equal(f.stored.length, 1);
  });
});
