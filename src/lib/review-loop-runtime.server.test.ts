import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";
import {
  builtinValidate,
  loopEnabled,
  loopSinceIso,
  renderFindings,
  runPostReviewLoop,
  type LoopRuntimeDeps,
} from "./review-loop-runtime.server.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "h".repeat(40);
const ENV_ON = { ASHLAR_FIX_AGENT: "1" } as NodeJS.ProcessEnv;
const ENV_OFF = {} as NodeJS.ProcessEnv;

const finding = (file: string, title = "null deref"): Finding => ({
  id: "f1",
  status: "accepted",
  severity: "P1",
  file,
  line: 3,
  side: "RIGHT",
  title,
  failureScenario: "x is undefined",
  rootCause: "missing guard",
  evidence: "line 3",
  recommendedFix: "remove the bad state",
  recommendedTest: "add a test",
});

function job(over: Partial<Job> = {}): Job {
  return {
    deliveryId: "d",
    trigger: "issue_comment.mention",
    owner: "o",
    repo: "r",
    pr: 7,
    title: "t",
    headSha: HEAD,
    baseSha: "b",
    sender: "alice",
    isFork: false,
    isDraft: false,
    origin: "github",
    thread: { kind: "mention", commentId: 1, userText: "/review-loop", loop: { kind: "start", mode: "suggest" } },
    id: "job-1",
    status: "posted",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ingressMs: 1,
    traces: [],
    plan: "",
    candidates: [],
    findings: [finding("src/a.ts")],
    investigatedSafe: [],
    assumptions: [],
    ...over,
  } as Job;
}

const sample = { files: [{ path: "src/a.ts", content: "export const a = 1;\n", language: "ts" }] } as unknown as SamplePr;

function settings(mode: "suggest" | "apply" = "suggest"): BotSettings {
  return { ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } };
}

/** Fake deps: configurable review history (for the escalate engine) + fix reply + push spy. */
function fakeDeps(opts: { rounds?: number[]; reply?: string; validateOk?: boolean } = {}) {
  const posted: string[] = [];
  let committed = false;
  const rounds = opts.rounds ?? [];
  const deps: LoopRuntimeDeps = {
    gh: {
      async listPullReviews() {
        // each round on a distinct head; the LAST must be the current HEAD for the engine to classify
        return rounds.map((n, i) => ({
          userLogin: BOT,
          body: `<!-- ashlar-findings total=${n} -->`,
          commitId: i === rounds.length - 1 ? HEAD : `c${i}`.padEnd(40, "0"),
          submittedAt: `2026-01-0${i + 1}T00:00:00Z`,
        }));
      },
      async listReviewComments() {
        return rounds.map((_n, i) => ({
          userLogin: BOT,
          path: "src/a.ts",
          commitId: i === rounds.length - 1 ? HEAD : `c${i}`.padEnd(40, "0"),
          createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        }));
      },
      async listIssueComments() {
        return [];
      },
      async createIssueComment(_t, o) {
        posted.push(o.body);
        return { id: posted.length };
      },
      async fetchPullHeadRef() {
        return { ref: "feature", fork: false };
      },
      gitDataApi() {
        return {
          async baseTreeSha() {
            return "tree";
          },
          async createBlob() {
            return "blob";
          },
          async createTree() {
            return "tree2";
          },
          async createCommit() {
            return "newsha";
          },
          async updateBranchRef() {
            committed = true;
          },
        };
      },
    },
    requestFix: async () => opts.reply ?? '{"summary":"guard removed","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}',
    validate: async () => ({ ok: opts.validateOk ?? true }),
  };
  return { deps, posted, get committed() { return committed; } };
}

describe("loopEnabled", () => {
  it("is off by default (no env flag) and off without a provider", () => {
    assert.equal(loopEnabled(settings(), ENV_OFF), false);
    assert.equal(loopEnabled({ ...DEFAULT_SETTINGS }, ENV_ON), false); // provider null
    assert.equal(loopEnabled(settings(), ENV_ON), true);
  });
});

describe("runPostReviewLoop gates", () => {
  it("is a no-op when disabled", async () => {
    const f = fakeDeps();
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_OFF);
    assert.deepEqual(r, { ran: false, reason: "disabled" });
    assert.equal(f.posted.length, 0);
  });

  it("is a no-op for a plain (non-/review-loop) review", async () => {
    const f = fakeDeps();
    const j = job({ thread: { kind: "mention", commentId: 1, userText: "@ashlar-bot review" } });
    const r = await runPostReviewLoop("t", j, sample, settings(), [j], f.deps, ENV_ON);
    assert.equal(r.ran, false);
    assert.equal(f.posted.length, 0);
  });

  it("is a no-op on a fork and on a converged (0 findings) review", async () => {
    const f = fakeDeps();
    assert.equal((await runPostReviewLoop("t", job({ isFork: true }), sample, settings(), [], f.deps, ENV_ON)).ran, false);
    assert.equal((await runPostReviewLoop("t", job({ findings: [] }), sample, settings(), [], f.deps, ENV_ON)).ran, false);
    assert.equal(f.posted.length, 0);
  });
});

describe("runPostReviewLoop steps", () => {
  it("escalates (fixed handoff) and does NOT attempt a fix when the loop is stuck", async () => {
    const f = fakeDeps({ rounds: [6, 4, 4] }); // recurring file, plateau => whack-a-mole
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.equal(r.ran, true);
    if (r.ran) assert.equal(r.step, "escalated");
    assert.equal(f.posted.length, 1);
    assert.ok(f.posted[0].includes("<!-- ashlar-loop-escalate"));
    assert.equal(f.committed, false);
  });

  it("suggest mode runs one fix round, posts the proposal, and does not push", async () => {
    const f = fakeDeps({ rounds: [3] }); // single round on HEAD => not stuck
    const r = await runPostReviewLoop("t", job(), sample, settings("suggest"), [job()], f.deps, ENV_ON);
    assert.equal(r.ran, true);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "suggested");
    assert.equal(f.committed, false);
    assert.ok(f.posted[0].includes("suggestion"));
  });

  it("apply mode commits through the validate gate and reports the sha", async () => {
    const f = fakeDeps({ rounds: [3] });
    const r = await runPostReviewLoop("t", job(), sample, settings("apply"), [job()], f.deps, ENV_ON);
    assert.equal(r.ran, true);
    if (r.ran && r.step === "fix") {
      assert.equal(r.outcome, "applied");
      assert.equal(r.commitSha, "newsha");
    }
    assert.equal(f.committed, true);
    assert.ok(f.posted[0].includes("newsha"));
  });

  it("apply mode with a failing validator does not push and reports validation-failed", async () => {
    const f = fakeDeps({ rounds: [3], validateOk: false });
    const r = await runPostReviewLoop("t", job(), sample, settings("apply"), [job()], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "validation-failed");
    assert.equal(f.committed, false);
  });

  it("never throws: a dependency failure becomes a structured non-run", async () => {
    const f = fakeDeps({ rounds: [3] });
    f.deps.gh.fetchPullHeadRef = async () => {
      throw new Error("boom");
    };
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.equal(r.ran, false);
    if (!r.ran) assert.match(r.reason, /boom/);
  });
});

describe("helpers", () => {
  it("loopSinceIso is the earliest loop-triggered job for the PR", () => {
    const a = job({ createdAt: 2000 });
    const b = job({ createdAt: 1000 });
    const other = job({ pr: 99, createdAt: 1 });
    assert.equal(loopSinceIso(a, [a, b, other]), new Date(1000).toISOString());
    assert.equal(loopSinceIso(job({ thread: { kind: "mention", commentId: 1, userText: "x" } }), []), undefined);
  });

  it("renderFindings is deterministic and carries file:line, scenario, root cause, fix", () => {
    const s = renderFindings([finding("src/a.ts", "T")]);
    assert.match(s, /\[P1\] src\/a\.ts:3 — T/);
    assert.match(s, /root cause: missing guard/);
  });

  it("builtinValidate rejects empty content and invalid JSON files", async () => {
    assert.equal((await builtinValidate([{ path: "a.ts", content: "  " }])).ok, false);
    assert.equal((await builtinValidate([{ path: "cfg.json", content: "{bad" }])).ok, false);
    assert.equal((await builtinValidate([{ path: "cfg.json", content: '{"ok":1}' }, { path: "a.ts", content: "x" }])).ok, true);
  });
});
