// Scratch reproductions for root-cause class K1 (not part of the PR).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Job, type SamplePr } from "./types.ts";
import { startComment, STOPPED_MARKER } from "./review-loop.ts";
import { readLoopSession } from "./review-loop-engine.server.ts";
import { continueLoopOnPush, runPostReviewLoop, startLoop, stopLoop, type LoopRuntimeDeps } from "./review-loop-runtime.server.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
const NEW_SHA = "e".repeat(40);
const ENV = { ASHLAR_FIX_AGENT: "1" } as NodeJS.ProcessEnv;
const START_AT = "2025-12-31T00:00:00Z";
const dayIso = (i: number) => `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`;

type Row = { userLogin: string; body: string; createdAt: string; updatedAt?: string };

function settings(mode: "suggest" | "apply" = "suggest"): BotSettings {
  return { ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } };
}

const sample = { changedPaths: ["src/a.ts"], files: [{ path: "src/a.ts", content: "export const a = 1;\n", language: "ts" }] } as unknown as SamplePr;

function job(over: Partial<Job> = {}): Job {
  return {
    deliveryId: "d", trigger: "issue_comment.mention", owner: "o", repo: "r", pr: 7, title: "t", headSha: HEAD, baseSha: "b",
    sender: "alice", isFork: false, isDraft: false, origin: "github", thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot review" },
    id: "job-1", status: "posted", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ingressMs: 1, traces: [], plan: "",
    candidates: [], findings: [{ id: "f1", status: "accepted", severity: "P1", file: "src/a.ts", line: 3, side: "RIGHT", title: "t", failureScenario: "s", rootCause: "r", evidence: "e", recommendedFix: "f", recommendedTest: "t" }],
    investigatedSafe: [], assumptions: [], ...over,
  } as Job;
}

/** Fake GitHub: `lag` hides comments the App posted after lag was switched on (the list API has
 * not caught up); `lostResponse(body)` makes a POST land but reject; `listFails()` makes lists throw. */
function fake(o: {
  rounds: number[];
  start?: "suggest" | "apply" | null;
  issues?: Row[];
  lostResponse?: (body: string, n: number) => boolean;
  failPost?: (body: string, n: number) => boolean;
  listFails?: () => boolean;
  reply?: string | ((n: number) => string);
  requestDelayMs?: number;
  onRequest?: () => Promise<void> | void;
} ) {
  const issues: Row[] = [...(o.start === null ? [] : [{ userLogin: BOT, body: startComment({ mode: o.start ?? "suggest", by: "alice", at: START_AT }), createdAt: START_AT }]), ...(o.issues ?? [])];
  const posted: string[] = [];
  const prompts: string[] = [];
  let hideFrom = Infinity; // index into issues from which rows are hidden (lag)
  let clock = 0;
  let committed = false;
  let postN = 0;
  const deps: LoopRuntimeDeps = {
    gh: {
      async listPullReviews() {
        if (o.listFails?.()) throw new Error("list 502");
        return o.rounds.map((n, i) => ({ userLogin: BOT, body: `<!-- ashlar-findings total=${n} -->`, commitId: i === o.rounds.length - 1 ? HEAD : `c${i}`.padEnd(40, "0"), submittedAt: dayIso(i) }));
      },
      async listReviewComments() {
        if (o.listFails?.()) throw new Error("list 502");
        return [];
      },
      async listIssueComments() {
        if (o.listFails?.()) throw new Error("list 502");
        return issues.slice(0, Math.min(issues.length, hideFrom)).map((c, i) => ({ ...c, id: i + 1 }));
      },
      async createIssueComment(_t, x) {
        postN += 1;
        if (o.failPost?.(x.body, postN)) throw new Error("GitHub issue comment 502");
        posted.push(x.body);
        clock += 1;
        issues.push({ userLogin: BOT, body: x.body, createdAt: `2026-02-01T00:00:${String(clock).padStart(2, "0")}Z` });
        if (o.lostResponse?.(x.body, postN)) throw new Error("GitHub API timeout");
        return { id: issues.length };
      },
      async fetchPullHeadRef() {
        return { ref: "feature", sha: committed ? NEW_SHA : HEAD, fork: false, sameRepo: true };
      },
      async fetchUserPermission() {
        return "write";
      },
      gitDataApi() {
        return {
          baseTreeSha: async () => "tree",
          createBlob: async () => "blob",
          createTree: async () => "tree2",
          createCommit: async () => NEW_SHA,
          async updateBranchRef() {
            committed = true;
          },
        };
      },
    },
    requestFix: async (p) => {
      prompts.push(p);
      if (o.onRequest) await o.onRequest();
      if (o.requestDelayMs) await new Promise((r) => setTimeout(r, o.requestDelayMs));
      const rep = typeof o.reply === "function" ? o.reply(prompts.length) : o.reply;
      return rep ?? '{"summary":"s","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';
    },
    validate: async () => ({ ok: true }),
    sleep: async () => {},
  };
  return {
    deps, posted, prompts, issues,
    lagFromNow() { hideFrom = issues.length; },
    noLag() { hideFrom = Infinity; },
    get committed() { return committed; },
  };
}

const esc = (p: string[]) => p.filter((b) => b.startsWith("<!-- ashlar-loop-escalate"));
const cont = (p: string[]) => p.filter((b) => b.startsWith("<!-- ashlar-loop-continue"));

describe("K1 repro", () => {
  it("I1 maybeEscalate: lost response on the round-cap handoff + lag → a SECOND (loop-error) handoff", async () => {
    const f = fake({ rounds: [5, 4, 3, 2, 2, 2], lostResponse: (b) => b.includes("reason=round-cap") });
    f.lagFromNow();
    const r = await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    console.log("I1", JSON.stringify(r), esc(f.posted).map((b) => /reason=([a-z-]+)/.exec(b)?.[1]));
    assert.equal(esc(f.posted).length, 2);
  });

  it("I1b maybeEscalate: a definite 502 on the round-cap handoff → handed off as loop-error, the reason is lost", async () => {
    const f = fake({ rounds: [5, 4, 3, 2, 2, 2], failPost: (b, n) => b.includes("reason=round-cap") });
    const r = await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    console.log("I1b", JSON.stringify(r), esc(f.posted).map((b) => /reason=([a-z-]+)/.exec(b)?.[1]));
    assert.equal(esc(f.posted).length, 1);
  });

  it("I2 escalateNow: one transient 502 on the fix-failed handoff → no handoff, session stays active (stall)", async () => {
    const f = fake({ rounds: [3], reply: "not json", failPost: (b) => b.startsWith("<!-- ashlar-loop-escalate") });
    const r = await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    const s = await readLoopSession(f.deps.gh, "t", "o", "r", 7, { botLogin: BOT, pr: { sha: HEAD } });
    console.log("I2", JSON.stringify(r), "active:", s.active, "handoffs:", esc(f.posted).length);
    assert.equal(s.active, true);
  });

  it("I3 suggestion report lost response → terminal loop-error handoff ends a suggest session that should wait for a push", async () => {
    const f = fake({ rounds: [3], lostResponse: (b) => b.includes("fix agent — suggestion") });
    const r = await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    console.log("I3", JSON.stringify(r), esc(f.posted).map((b) => /reason=([a-z-]+)/.exec(b)?.[1]));
    assert.equal(esc(f.posted).length, 1);
  });

  it("I4 sequential re-run of the same (session, head) in suggest mode → second FIXING, second provider request, second report", async () => {
    const f = fake({ rounds: [3] });
    await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    await runPostReviewLoop("t", job({ id: "job-2" }), sample, settings(), f.deps, ENV);
    console.log("I4 fixing:", f.posted.filter((b) => b.startsWith("<!-- ashlar-loop-fixing")).length, "prompts:", f.prompts.length, "reports:", f.posted.filter((b) => b.includes("suggestion")).length);
    assert.equal(f.prompts.length, 2);
  });

  it("I5 continuation: first POST lands but its response is lost; the retry's scan lags → duplicate continuation", async () => {
    const pushed = HEAD;
    const f = fake({ rounds: [3], lostResponse: (b, n) => b.startsWith("<!-- ashlar-loop-continue") && n === 1 });
    f.lagFromNow();
    const r = await continueLoopOnPush("t", { owner: "o", repo: "r", pr: 7, headSha: pushed, actor: "alice" }, settings(), f.deps, ENV);
    console.log("I5", JSON.stringify(r), "continuations:", cont(f.posted).length);
    assert.equal(cont(f.posted).length, 2);
  });

  it("I5b continuation: lost response + the scan's list read fails (same outage) → duplicate continuation", async () => {
    let failLists = false;
    const f = fake({ rounds: [3], listFails: () => failLists, lostResponse: (b, n) => { if (b.startsWith("<!-- ashlar-loop-continue") && n === 1) { failLists = true; return true; } return false; } });
    const r = await continueLoopOnPush("t", { owner: "o", repo: "r", pr: 7, headSha: HEAD, actor: "alice" }, settings(), f.deps, ENV);
    console.log("I5b", JSON.stringify(r), "continuations:", cont(f.posted).length);
    assert.equal(cont(f.posted).length, 2);
  });

  it("I6 stop record: lost response + lag → two STOPPED records for one stop", async () => {
    const f = fake({ rounds: [3], lostResponse: (b, n) => b.startsWith(STOPPED_MARKER) && n === 1 });
    f.lagFromNow();
    const r = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "bob", stopAt: "2026-01-20T00:00:00Z" }, settings(), f.deps, ENV);
    console.log("I6", JSON.stringify(r), "stopped:", f.posted.filter((b) => b.startsWith(STOPPED_MARKER)).length);
    assert.equal(f.posted.filter((b) => b.startsWith(STOPPED_MARKER)).length, 2);
  });

  it("I6b start record: lost response + lag → two start records", async () => {
    const f = fake({ rounds: [3], start: null, lostResponse: (b, n) => b.includes("ashlar-loop-start") && n === 1 });
    f.lagFromNow();
    const r = await startLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", mode: "suggest", at: START_AT }, settings(), f.deps, ENV);
    console.log("I6b", JSON.stringify(r), "starts:", f.posted.filter((b) => b.includes("ashlar-loop-start")).length);
    assert.equal(f.posted.filter((b) => b.includes("ashlar-loop-start")).length, 2);
  });

  it("I7 PR-body stop recorded while the list lags: pending stop is cleared on POST success → an in-flight apply round commits past it", async () => {
    let f!: ReturnType<typeof fake>;
    f = fake({
      rounds: [3],
      start: "apply",
      onRequest: async () => {
        // a PR-body stop arrives while the fix request runs; its record POST succeeds but the list lags
        f.lagFromNow();
        const r = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", stopAt: "2026-01-20T00:00:00Z" }, settings("apply"), f.deps, ENV);
        console.log("I7 stop:", JSON.stringify(r));
      },
    });
    const r = await runPostReviewLoop("t", job(), sample, settings("apply"), f.deps, ENV);
    console.log("I7", JSON.stringify(r), "committed:", f.committed, "continuations:", cont(f.posted).length);
    assert.equal(f.committed, true);
  });

  it("I8 just-posted handoff invisible to the fold: a sequential review of the same head re-runs the fix past a fix-declined handoff", async () => {
    const f = fake({ rounds: [3], reply: '{"summary":"declined","files":[]}' });
    f.lagFromNow();
    const r1 = await runPostReviewLoop("t", job(), sample, settings(), f.deps, ENV);
    const r2 = await runPostReviewLoop("t", job({ id: "job-2" }), sample, settings(), f.deps, ENV);
    console.log("I8", JSON.stringify(r1), JSON.stringify(r2), "prompts:", f.prompts.length, "handoffs:", esc(f.posted).length);
    assert.equal(f.prompts.length, 2);
  });

  it("I9 start self-heal: a record visible only through postedRecently never ends the poll → silent NO_SESSION", async () => {
    const f = fake({ rounds: [3], start: null });
    f.lagFromNow();
    // harbor recorded the start at admission (list lags from then on)
    await startLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", mode: "suggest", at: START_AT }, settings(), f.deps, ENV);
    const j = job({ thread: { kind: "mention", commentId: 5, userText: "/review-loop", loop: { kind: "start", mode: "suggest" }, eventAt: START_AT } });
    const r = await runPostReviewLoop("t", j, sample, settings(), f.deps, ENV);
    console.log("I9", JSON.stringify(r));
    assert.deepEqual(r, { ran: false, reason: "no active loop session" });
  });

  it("I8b apply: a fix-failed handoff hidden by lag → a sequential review of the same head COMMITS past the terminal handoff", async () => {
    const f = fake({ rounds: [3], start: "apply", reply: (n) => (n <= 2 ? "not json" : '{"summary":"s","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}') });
    f.lagFromNow();
    const r1 = await runPostReviewLoop("t", job(), sample, settings("apply"), f.deps, ENV);
    const r2 = await runPostReviewLoop("t", job({ id: "job-2" }), sample, settings("apply"), f.deps, ENV);
    console.log("I8b", JSON.stringify(r1), JSON.stringify(r2), "committed:", f.committed, "handoffs:", esc(f.posted).map((b) => /reason=([a-z-]+)/.exec(b)?.[1]));
    assert.equal(f.committed, true);
  });
});

describe("K1 repro — own review invisible", () => {
  it("I10 the App's just-posted CLEAN review is invisible to the push handler → a human push after convergence resumes the session", async () => {
    const H2 = "b".repeat(40);
    let hideClean = true;
    const issues: Row[] = [{ userLogin: BOT, body: startComment({ mode: "apply", by: "alice", at: START_AT }), createdAt: START_AT }];
    const posted: string[] = [];
    const reviews = () => [
      { userLogin: BOT, body: "<!-- ashlar-findings total=3 -->", commitId: "c".repeat(40), submittedAt: dayIso(0) },
      ...(hideClean ? [] : [{ userLogin: BOT, body: "<!-- ashlar-findings total=0 -->", commitId: HEAD, submittedAt: dayIso(1) }]),
    ];
    const deps: LoopRuntimeDeps = {
      gh: {
        listPullReviews: async () => reviews(),
        listReviewComments: async () => [],
        listIssueComments: async () => issues.map((c, i) => ({ ...c, id: i + 1 })),
        async createIssueComment(_t, x) { posted.push(x.body); issues.push({ userLogin: BOT, body: x.body, createdAt: "2026-01-02T00:00:05Z" }); return { id: issues.length }; },
        fetchPullHeadRef: async () => ({ ref: "feature", sha: H2, fork: false, sameRepo: true }),
        fetchUserPermission: async () => "write",
        gitDataApi: () => { throw new Error("unused"); },
      },
      requestFix: async () => "{}",
      validate: async () => ({ ok: true }),
      sleep: async () => {},
    };
    // the clean review of HEAD was posted at 2026-01-02T00:00:00Z (CONVERGED); the human pushes H2 2 s later
    const r = await continueLoopOnPush("t", { owner: "o", repo: "r", pr: 7, headSha: H2, actor: "alice", pushedAt: "2026-01-02T00:00:02Z" }, settings("apply"), deps, ENV);
    hideClean = false; // the list catches up
    const s = await readLoopSession(deps.gh, "t", "o", "r", 7, { botLogin: BOT, pr: { sha: H2 } });
    console.log("I10", JSON.stringify(r), "session after catch-up:", JSON.stringify(s));
    assert.equal(r.posted, true);
    assert.equal(s.active, true);
  });
});
