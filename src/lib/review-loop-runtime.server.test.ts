import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type BotSettings, type Finding, type Job, type SamplePr } from "./types.ts";
import { parseContinueMarker } from "./review-loop.ts";
import {
  ashlarBotLogin,
  builtinValidate,
  effectiveFixMode,
  loopEnabled,
  loopSinceIso,
  renderFindings,
  runPostReviewLoop,
  type LoopRuntimeDeps,
} from "./review-loop-runtime.server.ts";

const BOT = "ashlar-bot-review-loop[bot]";
const HEAD = "h".repeat(40);
const NEW_SHA = "e".repeat(40); // the fix commit (40-hex, as the Git Data API returns)
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

function job(over: Partial<Job> = {}, loopMode: "suggest" | "apply" = "suggest"): Job {
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
    thread: { kind: "mention", commentId: 1, userText: "/review-loop", loop: { kind: "start", mode: loopMode } },
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

const sample = {
  changedPaths: ["src/a.ts"],
  files: [
    { path: "src/a.ts", content: "export const a = 1;\n", language: "ts" },
    { path: "docs/POLICY.md", content: "read-only review context", language: "md" }, // policy context, NOT editable
  ],
} as unknown as SamplePr;

function settings(mode: "suggest" | "apply" = "suggest"): BotSettings {
  return { ...DEFAULT_SETTINGS, fixAgent: { provider: "local", delivery: "script-apply", mode, parallelPrs: 3 } };
}

/** Fake deps: configurable review history (for the escalate engine) + fix reply + push spy. */
function fakeDeps(opts: { rounds?: number[]; reply?: string; validateOk?: boolean; liveSha?: string; movedDuringFix?: boolean; refMovedAtWrite?: boolean; commitSha?: string } = {}) {
  const posted: string[] = [];
  let committed = false;
  let headReads = 0;
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
        headReads += 1;
        // movedDuringFix: the first read (pre-fix) matches, the re-check before commit does not
        const sha = opts.movedDuringFix && headReads > 1 ? "m".repeat(40) : (opts.liveSha ?? HEAD);
        return { ref: "feature", sha, fork: false };
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
            return opts.commitSha ?? NEW_SHA;
          },
          async updateBranchRef(_branch: string, _sha: string, expectedOldSha: string) {
            // the real impl reads the ref right before the write and refuses on mismatch
            const current = opts.refMovedAtWrite ? "a".repeat(40) : HEAD;
            if (current !== expectedOldSha) throw new Error("branch moved; refusing to update");
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

  it("a converged review is silent; a fork is a reported halt (the user asked for a loop)", async () => {
    const f = fakeDeps();
    assert.equal((await runPostReviewLoop("t", job({ findings: [] }), sample, settings(), [], f.deps, ENV_ON)).ran, false);
    assert.equal(f.posted.length, 0, "converged: nothing to report");
    assert.equal((await runPostReviewLoop("t", job({ isFork: true }), sample, settings(), [], f.deps, ENV_ON)).ran, false);
    assert.equal(f.posted.length, 1);
    assert.match(f.posted[0], /halted before fix[\s\S]*fork/);
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
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.equal(r.ran, true);
    if (r.ran && r.step === "fix") {
      assert.equal(r.outcome, "applied");
      assert.equal(r.commitSha, NEW_SHA);
    }
    assert.equal(f.committed, true);
    assert.ok(f.posted[0].includes(NEW_SHA));
  });

  it("apply mode with a failing validator does not push and reports validation-failed", async () => {
    const f = fakeDeps({ rounds: [3], validateOk: false });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "validation-failed");
    assert.equal(f.committed, false);
  });

  it("K1: does not fix when the live head no longer matches the reviewed SHA", async () => {
    const f = fakeDeps({ rounds: [3], liveSha: "a".repeat(40) });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.equal(r.ran, false);
    if (!r.ran) assert.match(r.reason, /head moved/);
    assert.equal(f.committed, false);
    assert.equal(f.posted.length, 1, "the halt is reported in-thread (L4)");
    assert.match(f.posted[0], /halted before fix[\s\S]*head moved/);
  });

  it("K1: a head move DURING the fix is caught by the pre-commit re-check (no push)", async () => {
    const f = fakeDeps({ rounds: [3], movedDuringFix: true });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") {
      assert.equal(r.outcome, "validation-failed");
      assert.match(r.error ?? "", /head moved during fix/);
    }
    assert.equal(f.committed, false);
  });

  it("K2: the global setting is a ceiling — push only when BOTH command and setting say apply", async () => {
    // command suggest + global apply → no push
    let f = fakeDeps({ rounds: [3] });
    let j = job({}, "suggest");
    let r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "suggested");
    assert.equal(f.committed, false);
    // command apply + global suggest → no push
    f = fakeDeps({ rounds: [3] });
    j = job({}, "apply");
    r = await runPostReviewLoop("t", j, sample, settings("suggest"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "suggested");
    assert.equal(f.committed, false);
    assert.ok(f.posted[0].includes("mode: suggest"), "report uses the effective mode");
  });

  it("K3: a policy/context file in the snapshot is NOT editable (scope-violation, no push)", async () => {
    const f = fakeDeps({
      rounds: [3],
      reply: '{"summary":"edit policy","files":[{"path":"docs/POLICY.md","content":"tampered"}]}',
    });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.outcome, "scope-violation");
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
    assert.ok(f.posted.some((b) => /halted before fix[\s\S]*boom/.test(b)), "the failure is observable in-thread (L4)");
  });

  it("L1: a backward force-push between validation and the ref write is refused (no restore)", async () => {
    const f = fakeDeps({ rounds: [3], refMovedAtWrite: true });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") {
      assert.equal(r.outcome, "commit-failed");
      assert.match(r.error ?? "", /branch moved/);
      assert.equal(r.continued, false);
    }
    assert.equal(f.committed, false);
  });

  it("L3: an applied round continues the loop with the FIXED continuation marker on the new head", async () => {
    const f = fakeDeps({ rounds: [3] });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    if (r.ran && r.step === "fix") assert.equal(r.continued, true);
    assert.match(f.posted[0], /Loop continues/);
    const cont = f.posted.map((b) => parseContinueMarker(b, { authoredByBot: true })).find(Boolean);
    assert.deepEqual(cont, { mode: "apply", round: 2, pr: 7, head: NEW_SHA }, "marker names the next round + new head");
    // never an @-mention / prose directive: the webhook parser ignores those from the bot
    assert.ok(!f.posted.some((b) => /@ashlar/i.test(b)), "no bot @-mention posted");
  });

  it("L3: a continuation that cannot be composed halts instead of announcing 'Loop continues'", async () => {
    const f = fakeDeps({ rounds: [3], commitSha: "newsha" }); // not a full SHA → parser would reject
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.equal(r.ran, false);
    assert.ok(!f.posted.some((b) => /Loop continues/.test(b)), "no false continuation announcement");
    assert.ok(f.posted.some((b) => /halted before fix[\s\S]*invalid loop continuation/.test(b)), "halt is observable");
  });

  it("L3: at the round cap an applied round does NOT continue (bounded)", async () => {
    const f = fakeDeps({ rounds: [5, 4, 3] }); // strictly improving → not stuck, but 3 rounds reach cap 3
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, { ...ENV_ON, ASHLAR_LOOP_ROUND_CAP: "3" } as NodeJS.ProcessEnv);
    if (r.ran && r.step === "fix") {
      assert.equal(r.outcome, "applied");
      assert.equal(r.continued, false);
    }
    assert.ok(!f.posted.some((b) => b.includes("ashlar-loop-continue")), "no continuation at the cap");
    assert.match(f.posted[0], /Loop paused/);
  });
});

describe("helpers", () => {
  it("loopSinceIso is the CURRENT session start (latest start at/before this job), not the earliest ever (K4)", () => {
    const old = job({ createdAt: 1000 }); // a finished earlier session
    const cur = job({ createdAt: 2000 }); // this session's explicit start
    const future = job({ createdAt: 3000 }); // a later start must not count for cur
    const other = job({ pr: 99, createdAt: 1 });
    assert.equal(loopSinceIso(cur, [old, cur, future, other]), new Date(2000).toISOString());
    assert.equal(loopSinceIso(job({ thread: { kind: "mention", commentId: 1, userText: "x" } }), []), undefined);
  });

  it("L3: bot continuation starts stay in the human-started session", () => {
    const human = job({ createdAt: 1000, sender: "alice" });
    const cont = job({ createdAt: 2000, sender: "ashlar-bot-review-loop[bot]" });
    assert.equal(loopSinceIso(cont, [human, cont], "ashlar-bot"), new Date(1000).toISOString());
  });

  it("ashlarBotLogin: ASHLAR_BOT_LOGIN only in the App-reserved <slug>[bot] shape", () => {
    assert.equal(ashlarBotLogin({} as NodeJS.ProcessEnv), BOT);
    assert.equal(ashlarBotLogin({ ASHLAR_BOT_LOGIN: "other-app[bot]" } as NodeJS.ProcessEnv), "other-app[bot]");
    assert.equal(ashlarBotLogin({ ASHLAR_BOT_LOGIN: "some-human" } as NodeJS.ProcessEnv), BOT);
  });

  it("effectiveFixMode: apply only when command AND setting allow it", () => {
    assert.equal(effectiveFixMode(job({}, "apply"), settings("apply")), "apply");
    assert.equal(effectiveFixMode(job({}, "apply"), settings("suggest")), "suggest");
    assert.equal(effectiveFixMode(job({}, "suggest"), settings("apply")), "suggest");
    assert.equal(effectiveFixMode(job({ thread: { kind: "mention", commentId: 1, userText: "x" } }), settings("apply")), "suggest");
  });

  it("renderFindings is deterministic and carries file:line, scenario, root cause, fix", () => {
    const s = renderFindings([finding("src/a.ts", "T")]);
    assert.match(s, /\[P1\] src\/a\.ts:3 — T/);
    assert.match(s, /root cause: missing guard/);
  });

  it("L2: builtinValidate rejects syntactically invalid TS/JS and refuses apply for unvalidated types", async () => {
    const bad = await builtinValidate([{ path: "src/a.ts", content: "export const = 1" }]);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /syntax error/);
    assert.equal((await builtinValidate([{ path: "src/C.tsx", content: "export const C = () => <div />;\n" }])).ok, true);
    assert.equal((await builtinValidate([{ path: "x.js", content: "function (" }])).ok, false);
    const md = await builtinValidate([{ path: "README.md", content: "# hi" }]);
    assert.equal(md.ok, false);
    assert.match(md.error ?? "", /no deterministic validator/);
  });

  it("builtinValidate rejects empty content and invalid JSON files", async () => {
    assert.equal((await builtinValidate([{ path: "a.ts", content: "  " }])).ok, false);
    assert.equal((await builtinValidate([{ path: "cfg.json", content: "{bad" }])).ok, false);
    assert.equal((await builtinValidate([{ path: "cfg.json", content: '{"ok":1}' }, { path: "a.ts", content: "x" }])).ok, true);
  });
});
