// K2 repro tests (scratch; not part of the PR). Each test asserts the CURRENT (buggy) behavior.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";
import { startComment, STOPPED_MARKER } from "./review-loop.ts";
import { continueLoopOnPush, runPostReviewLoop, stopLoop, type LoopRuntimeDeps } from "./review-loop-runtime.server.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "a".repeat(40);
const NEW_SHA = "e".repeat(40);
const PUSHED = "d".repeat(40);
const ENV_ON = { ASHLAR_FIX_AGENT: "1" } as NodeJS.ProcessEnv;
const START_AT = "2025-12-31T00:00:00Z";

const finding: Finding = {
  id: "f1", status: "accepted", severity: "P1", file: "src/a.ts", line: 3, side: "RIGHT", title: "t",
  failureScenario: "x", rootCause: "y", evidence: "z", recommendedFix: "w", recommendedTest: "v",
};
const sample = { changedPaths: ["src/a.ts"], files: [{ path: "src/a.ts", content: "export const a = 1;\n", language: "ts" }] } as unknown as SamplePr;
const settings = (mode: "suggest" | "apply"): BotSettings => ({ ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } });

function job(over: Partial<Job> = {}): Job {
  return {
    deliveryId: "d", trigger: "issue_comment.mention", owner: "o", repo: "r", pr: 7, title: "t", headSha: HEAD, baseSha: "b",
    sender: "alice", isFork: false, isDraft: false, origin: "github",
    thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot review" },
    id: "job-1", status: "posted", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ingressMs: 1, traces: [], plan: "",
    candidates: [], findings: [finding], investigatedSafe: [], assumptions: [], ...over,
  } as Job;
}

type Row = { userLogin: string; body: string; createdAt: string; updatedAt?: string };
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function fake(o: { start?: boolean; mode?: "suggest" | "apply"; liveSha?: string } = {}) {
  const issues: Row[] = o.start === false ? [] : [{ userLogin: BOT, body: startComment({ mode: o.mode ?? "apply", by: "alice", at: START_AT }), createdAt: START_AT }];
  const posted: string[] = [];
  let committed = false;
  let clock = 0;
  const hooks: {
    beforePost?: (body: string) => Promise<void> | void;
    beforeList?: (n: number) => Promise<void> | void;
  } = {};
  let lists = 0;
  const deps: LoopRuntimeDeps = {
    gh: {
      async listPullReviews() {
        return [{ userLogin: BOT, body: "<!-- ashlar-findings total=3 -->", commitId: HEAD, submittedAt: "2026-01-01T00:00:00Z" }];
      },
      async listReviewComments() {
        return [{ userLogin: BOT, path: "src/a.ts", commitId: HEAD, createdAt: "2026-01-01T00:00:00Z", body: "f" }];
      },
      async listIssueComments() {
        const snap = issues.map((c, i) => ({ ...c, id: i + 1 })); // snapshot at request time
        lists += 1;
        await hooks.beforeList?.(lists);
        return snap;
      },
      async createIssueComment(_t, x) {
        await hooks.beforePost?.(x.body);
        posted.push(x.body);
        clock += 1;
        issues.push({ userLogin: BOT, body: x.body, createdAt: `2026-02-01T00:00:${String(clock).padStart(2, "0")}Z` });
        return { id: issues.length };
      },
      async fetchPullHeadRef() {
        return { ref: "feature", sha: committed ? NEW_SHA : (o.liveSha ?? HEAD), fork: false, sameRepo: true };
      },
      async fetchUserPermission() {
        return "write";
      },
      gitDataApi() {
        return {
          async baseTreeSha() { return "tree"; },
          async createBlob() { return "blob"; },
          async createTree() { return "tree2"; },
          async createCommit() { return NEW_SHA; },
          async updateBranchRef() { committed = true; },
        };
      },
    },
    requestFix: async () => '{"summary":"s","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}',
    validate: async () => ({ ok: true }),
    sleep: async () => {},
  };
  return { deps, issues, posted, hooks, get committed() { return committed; }, get lists() { return lists; } };
}

describe("K2 repro", () => {
  it("I1: an edit-time stop that races the step's self-heal start record is forgotten; apply then commits past it", async () => {
    const f = fake({ start: false, mode: "apply" });
    const startPost = gate();
    const startReached = gate();
    f.hooks.beforePost = async (body) => {
      if (body.includes("ashlar-loop-start")) {
        startReached.open();
        await startPost.p; // the start record POST is in flight
      }
    };
    const j = job({ thread: { kind: "mention", commentId: 1, userText: "/review-loop apply", loop: { kind: "start", mode: "apply" }, eventAt: "2025-12-31T12:00:00Z" } as Job["thread"] });
    const step = runPostReviewLoop("t", j, sample, settings("apply"), f.deps, ENV_ON);
    await startReached.p;
    // harbor: the start job already POSTED its review (not live) → startInFlight=false
    const stop = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", stopAt: "2026-01-01T00:10:00Z" }, settings("apply"), f.deps, ENV_ON);
    startPost.open();
    const r = await step;
    assert.deepEqual(stop, { posted: false, reason: "no active loop session" }, "the stop is forgotten");
    assert.equal(f.committed, true, `BUG: committed past the operator's stop: ${JSON.stringify(r)}`);
  });

  it("I2: a push continuation decided before a stop is POSTED after the stop's STOPPED record", async () => {
    const f = fake({ mode: "apply", liveSha: PUSHED });
    const contPost = gate();
    const contReached = gate();
    f.hooks.beforePost = async (body) => {
      if (body.includes("ashlar-loop-continue")) {
        contReached.open();
        await contPost.p;
      }
    };
    const push = continueLoopOnPush("t", { owner: "o", repo: "r", pr: 7, headSha: PUSHED, actor: "alice", pushedAt: "2026-01-02T00:00:00Z" }, settings("apply"), f.deps, ENV_ON);
    await contReached.p;
    const stop = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", stopAt: "2026-01-02T00:00:02Z" }, settings("apply"), f.deps, ENV_ON);
    contPost.open();
    const p = await push;
    const iStop = f.posted.findIndex((b) => b.startsWith(STOPPED_MARKER));
    const iCont = f.posted.findIndex((b) => b.includes("ashlar-loop-continue"));
    assert.equal(stop.posted, true);
    assert.equal(p.posted, true);
    assert.ok(iStop >= 0 && iCont > iStop, `BUG: continuation posted after STOPPED: ${JSON.stringify(f.posted.map((b) => b.slice(0, 30)))}`);
  });

  it("I3: a stop recorded while the pre-commit session read is in flight is missed: the commit lands after STOPPED", async () => {
    const f = fake({ mode: "apply" });
    const hold = gate();
    const reached = gate();
    let validateRead = false;
    // make validate's checkpoint read slow: hold the issue-comments list that the validate checkpoint issues
    const origValidate = f.deps.validate;
    f.deps.validate = async (c) => {
      validateRead = true;
      return origValidate(c);
    };
    let held = false;
    f.hooks.beforeList = async () => {
      if (validateRead && !held) {
        held = true;
        reached.open();
        await hold.p;
      }
    };
    const step = runPostReviewLoop("t", job(), sample, settings("apply"), f.deps, ENV_ON);
    await reached.p;
    // edit-time stop: not in history; stopLoop marks it pending and posts the STOPPED record
    const stop = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", stopAt: "2026-01-03T00:00:00Z" }, settings("apply"), f.deps, ENV_ON);
    hold.open();
    const r = await step;
    assert.equal(stop.posted, true, "the stop was acknowledged (STOPPED posted)");
    assert.equal(f.committed, true, `BUG: the commit landed after the STOPPED acknowledgement: ${JSON.stringify(r)}`);
  });

  it("I4: an applied round's continuation decided before a stop is POSTED after STOPPED (afterCommit not ordered against stopLoop)", async () => {
    const f = fake({ mode: "apply" });
    const contPost = gate();
    const contReached = gate();
    f.hooks.beforePost = async (body) => {
      if (body.includes("ashlar-loop-continue")) {
        contReached.open();
        await contPost.p;
      }
    };
    const step = runPostReviewLoop("t", job(), sample, settings("apply"), f.deps, ENV_ON);
    await contReached.p;
    const stop = await stopLoop("t", { owner: "o", repo: "r", pr: 7, actor: "alice", stopAt: "2026-01-03T00:00:00Z" }, settings("apply"), f.deps, ENV_ON);
    contPost.open();
    const r = await step;
    const iStop = f.posted.findIndex((b) => b.startsWith(STOPPED_MARKER));
    const iCont = f.posted.findIndex((b) => b.includes("ashlar-loop-continue"));
    assert.equal(stop.posted, true);
    assert.ok(iStop >= 0 && iCont > iStop, `BUG: continuation after STOPPED; step=${JSON.stringify(r)}`);
    const report = f.posted.find((b) => b.startsWith("### Ashlar fix agent — applied")) ?? "";
    assert.match(report, /Loop continues/, "BUG: the report claims the loop continues after the operator stopped it");
  });

  it("I5: a second review of the same head (the operator upgrades suggest→apply) is dropped SILENTLY while the suggest round runs", async () => {
    const f = fake({ mode: "suggest" });
    const fixHeld = gate();
    const fixReached = gate();
    let fixes = 0;
    f.deps.requestFix = async () => {
      fixes += 1;
      if (fixes === 1) {
        fixReached.open();
        await fixHeld.p;
      }
      return '{"summary":"s","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}';
    };
    const a = runPostReviewLoop("t", job({ id: "job-A" }), sample, settings("apply"), f.deps, ENV_ON);
    await fixReached.p;
    // the operator re-issues the start in apply mode (same session): the App records it
    f.issues.push({ userLogin: BOT, body: startComment({ mode: "apply", by: "alice", at: "2026-01-01T00:05:00Z" }), createdAt: "2026-01-01T00:05:01Z" });
    const b = await runPostReviewLoop("t", job({ id: "job-B", thread: { kind: "mention", commentId: 2, userText: "/review-loop apply", loop: { kind: "start", mode: "apply" } } as Job["thread"] }), sample, settings("apply"), f.deps, ENV_ON);
    fixHeld.open();
    const ra = await a;
    assert.deepEqual(b, { ran: false, reason: "another loop step is in flight for this head" }, "B dropped with a SILENT reason");
    assert.ok(ra.ran && ra.step === "fix" && ra.outcome === "suggested", `A still posts a suggestion: ${JSON.stringify(ra)}`);
    assert.equal(f.committed, false, "BUG: the operator's apply request never runs; no signal says so");
  });

  it("I6: module-level guards leak across independent runtimes (distinct GitHub clients): one hung step blocks another client's step", async () => {
    const hung = fake({ mode: "suggest" });
    const reached = gate();
    hung.deps.requestFix = () => {
      reached.open();
      return new Promise<string>(() => {}); // never settles (a test that times out / an abandoned fake)
    };
    void runPostReviewLoop("t", job({ id: "hung" }), sample, settings("suggest"), hung.deps, ENV_ON);
    await reached.p;
    const fresh = fake({ mode: "suggest" });
    const r = await runPostReviewLoop("t", job({ id: "fresh" }), sample, settings("suggest"), fresh.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "another loop step is in flight for this head" }, "BUG: an unrelated client inherits the in-flight guard");
  });
});

