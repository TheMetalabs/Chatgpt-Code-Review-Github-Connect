import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maybeEscalate, reconstructRounds, type ReviewLoopGithub } from "./review-loop-engine.server.ts";

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
        { userLogin: BOT, body: findingsBody(r.findings), commitId: r.head + "0000000", submittedAt: r.at },
        { userLogin: BOT, body: findingsBody(r.findings), commitId: r.head + "0000000", submittedAt: r.at + "1" },
      ]);
    },
    async listReviewComments() {
      return rounds.flatMap((r) =>
        r.files.map((f) => ({ userLogin: BOT, path: f, commitId: r.head + "0000000" })),
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
    head: `h${i}`.padEnd(7, "0"),
    findings: n,
    files,
    at: `2026-01-0${i + 1}T00:00:00Z`,
  }));

  it("emits a fixed ESCALATE handoff on a stuck (whack-a-mole) loop", async () => {
    const { gh, posted } = fakeGh(pr68);
    const res = await maybeEscalate(gh, "t", { owner: "o", repo: "r", pr: 68, head: "h5000000", roundCap: 8 });
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
    const existing = [{ userLogin: BOT, body: "<!-- ashlar-loop-escalate reason=whack-a-mole round=6 pr=68 head=h500000 -->" }];
    const { gh, posted } = fakeGh(pr68, existing);
    const res = await maybeEscalate(gh, "t", { owner: "o", repo: "r", pr: 68, head: "h500000", roundCap: 8 });
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
      async listReviewComments() { return [{ userLogin: bot, path: files[0], commitId: "old00000" }, { userLogin: bot, path: files[0], commitId: "new00000" }]; },
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
      async listPullReviews() { return [{ userLogin: bot, body: "<!-- ashlar-findings total=6 -->", commitId: "h0000000", submittedAt: "2026-01-01T00:00:00Z" }]; },
      async listReviewComments() { return [{ userLogin: bot, path: files[0], commitId: "h000000" }]; },
      async listIssueComments() { throw new Error("list issues failed (502)"); },
      async createIssueComment() { throw new Error("must not post on incomplete history"); },
    };
    const res = await maybeEscalate(gh as never, "t", { owner: "o", repo: "r", pr: 1, head: "h000000", roundCap: 1 });
    assert.equal(res.escalated, false);
    assert.match(res.error ?? "", /list issues failed/);
  });
});
