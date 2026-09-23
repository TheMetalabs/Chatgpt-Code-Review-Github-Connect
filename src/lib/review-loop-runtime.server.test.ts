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

/** Fake deps: configurable review history (for the escalate engine) + fix replies + push spy. */
function fakeDeps(
  opts: {
    rounds?: number[];
    reply?: string | string[]; // one reply per attempt (last repeats)
    requestThrows?: number; // the first N requests throw (transport failure)
    validateOk?: boolean;
    liveSha?: string;
    movedDuringFix?: boolean;
    refMovedAtWrite?: boolean;
    commitSha?: string;
    lastHead?: string; // head of the latest reconstructed round (default: the reviewed HEAD)
    additions?: number;
    deletions?: number;
    priorIssues?: Array<{ userLogin: string; body: string }>;
  } = {},
) {
  const posted: string[] = [];
  const issues: Array<{ userLogin: string; body: string }> = [...(opts.priorIssues ?? [])];
  const prompts: string[] = [];
  let committed = false;
  let moved = false;
  let headReads = 0;
  let sleeps = 0;
  const rounds = opts.rounds ?? [];
  const lastHead = opts.lastHead ?? HEAD;
  const replies = Array.isArray(opts.reply) ? opts.reply : [opts.reply ?? '{"summary":"guard removed","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}'];
  const deps: LoopRuntimeDeps = {
    gh: {
      async listPullReviews() {
        // each round on a distinct head; the LAST is the reviewed HEAD unless lastHead says otherwise
        return rounds.map((n, i) => ({
          userLogin: BOT,
          body: `<!-- ashlar-findings total=${n} -->`,
          commitId: i === rounds.length - 1 ? lastHead : `c${i}`.padEnd(40, "0"),
          submittedAt: `2026-01-0${i + 1}T00:00:00Z`,
        }));
      },
      async listReviewComments() {
        return rounds.map((_n, i) => ({
          userLogin: BOT,
          path: "src/a.ts",
          commitId: i === rounds.length - 1 ? lastHead : `c${i}`.padEnd(40, "0"),
          createdAt: `2026-01-0${i + 1}T00:00:00Z`,
        }));
      },
      async listIssueComments() {
        return issues;
      },
      async createIssueComment(_t, o) {
        posted.push(o.body);
        issues.push({ userLogin: BOT, body: o.body });
        return { id: posted.length };
      },
      async fetchPullHeadRef() {
        headReads += 1;
        // movedDuringFix: the first read (pre-fix) matches, every later re-check does not
        const sha = moved || (opts.movedDuringFix && headReads > 1) ? "m".repeat(40) : (opts.liveSha ?? HEAD);
        return { ref: "feature", sha, fork: false, additions: opts.additions, deletions: opts.deletions };
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
            if (opts.refMovedAtWrite) moved = true;
            const current = opts.refMovedAtWrite ? "a".repeat(40) : HEAD;
            if (current !== expectedOldSha) throw new Error("branch moved; refusing to update");
            committed = true;
          },
        };
      },
    },
    requestFix: async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length <= (opts.requestThrows ?? 0)) throw new Error("local LLM timeout");
      return replies[Math.min(prompts.length - 1 - (opts.requestThrows ?? 0), replies.length - 1)];
    },
    validate: async () => ({ ok: opts.validateOk ?? true }),
    sleep: async () => {
      sleeps += 1;
    },
  };
  return {
    deps,
    posted,
    prompts,
    get committed() {
      return committed;
    },
    get sleeps() {
      return sleeps;
    },
  };
}

const escalations = (posted: string[]) => posted.filter((b) => b.includes("<!-- ashlar-loop-escalate"));
const reasonOf = (body: string) => /reason=([a-z-]+)/.exec(body)?.[1];

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

  it("a converged review is silent: its clean review IS the terminal signal", async () => {
    const f = fakeDeps();
    const r = await runPostReviewLoop("t", job({ findings: [] }), sample, settings(), [], f.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "no findings (converged)" });
    assert.equal(f.posted.length, 0);
  });
});

describe("runPostReviewLoop: termination contract (every stop is CONVERGED, ESCALATE or superseded)", () => {
  it("stuck → fixed ESCALATE and NO fix attempt", async () => {
    const f = fakeDeps({ rounds: [6, 4, 4] }); // recurring file, plateau => whack-a-mole
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated");
    assert.deepEqual(escalations(f.posted).map(reasonOf), ["whack-a-mole"]);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.committed, false);
  });

  it("budget: within the fix-round budget an improving loop fixes and continues", async () => {
    const f = fakeDeps({ rounds: [5, 4, 3] });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, { ...ENV_ON, ASHLAR_LOOP_ROUND_CAP: "3" } as NodeJS.ProcessEnv);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "applied" && r.continued === true);
    const cont = f.posted.map((b) => parseContinueMarker(b, { authoredByBot: true })).find(Boolean);
    assert.equal(cont?.round, 4, "review round 4 verifies the 3rd (last budgeted) fix");
  });

  it("budget: the verification review after the last budgeted fix hands off (round-cap) even while improving", async () => {
    const f = fakeDeps({ rounds: [5, 4, 3, 2] });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, { ...ENV_ON, ASHLAR_LOOP_ROUND_CAP: "3" } as NodeJS.ProcessEnv);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "round-cap");
    assert.deepEqual(escalations(f.posted).map(reasonOf), ["round-cap"]);
    assert.equal(f.prompts.length, 0, "no fix past the budget");
  });

  it("the default fix-round budget is 5", async () => {
    const within = fakeDeps({ rounds: [9, 8, 7, 6, 5] });
    const j = job({}, "apply");
    const r5 = await runPostReviewLoop("t", j, sample, settings("apply"), [j], within.deps, ENV_ON);
    assert.ok(r5.ran && r5.step === "fix");
    const past = fakeDeps({ rounds: [9, 8, 7, 6, 5, 4] });
    const r6 = await runPostReviewLoop("t", j, sample, settings("apply"), [j], past.deps, ENV_ON);
    assert.ok(r6.ran && r6.step === "escalated" && r6.reason === "round-cap");
  });

  it("diff-too-large is enforced from the live PR size", async () => {
    const f = fakeDeps({ rounds: [3], additions: 4000, deletions: 2000 });
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "diff-too-large");
    assert.equal(f.prompts.length, 0);
  });

  it("an unattributable history (current review missing) is re-read once, then hands off — never fixes blind", async () => {
    const f = fakeDeps({ rounds: [3], lastHead: "z".repeat(40) });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.equal(f.sleeps, 1, "one re-read for a lagging API");
    assert.ok(r.ran && r.step === "escalated" && r.reason === "loop-error");
    assert.match(escalations(f.posted)[0], /Detail: could not verify the loop history/);
    assert.equal(f.committed, false);
  });

  it("never fixes past an existing handoff on this head (stuck + already escalated → quiet)", async () => {
    const prior = { userLogin: BOT, body: `<!-- ashlar-loop-escalate reason=oscillation round=3 pr=7 head=${HEAD} -->` };
    const f = fakeDeps({ rounds: [6, 4, 4], priorIssues: [prior] });
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "already escalated on this head" });
    assert.equal(f.posted.length, 0);
    assert.equal(f.prompts.length, 0);
  });

  it("suggest mode runs one fix round, posts the proposal, and does not push or escalate", async () => {
    const f = fakeDeps({ rounds: [3] });
    const r = await runPostReviewLoop("t", job(), sample, settings("suggest"), [job()], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "suggested");
    assert.equal(f.committed, false);
    assert.ok(f.posted[0].includes("suggestion"));
    assert.equal(escalations(f.posted).length, 0);
  });

  it("apply mode commits through the validate gate, reports the sha, and continues with the fixed marker", async () => {
    const f = fakeDeps({ rounds: [3] });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "applied" && r.commitSha === NEW_SHA && r.continued === true);
    assert.equal(f.committed, true);
    assert.ok(f.posted[0].includes(NEW_SHA));
    assert.match(f.posted[0], /Loop continues/);
    const cont = f.posted.map((b) => parseContinueMarker(b, { authoredByBot: true })).find(Boolean);
    assert.deepEqual(cont, { mode: "apply", round: 2, pr: 7, head: NEW_SHA });
    assert.ok(!f.posted.some((b) => /@ashlar/i.test(b)), "no bot @-mention posted");
  });

  it("a retryable failure is retried with the rejection fed back, then succeeds", async () => {
    const f = fakeDeps({ rounds: [3], reply: ["not json at all", '{"summary":"ok","files":[{"path":"src/a.ts","content":"export const a = 3;\\n"}]}'] });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "applied" && r.attempts === 2);
    assert.equal(f.prompts.length, 2);
    assert.match(f.prompts[1], /PREVIOUS ATTEMPT REJECTED \(parse-failed\)/);
    assert.ok(f.prompts[1].startsWith(f.prompts[0]), "the retry keeps the full original prompt");
  });

  it("a transport failure is retried; exhausting the attempts hands off (fix-failed)", async () => {
    const f = fakeDeps({ rounds: [3], requestThrows: 5 });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "fix-failed");
    assert.equal(f.prompts.length, 2, "default 2 attempts");
    assert.match(escalations(f.posted)[0], /Detail: request-failed after 2 attempt\(s\): local LLM timeout/);
  });

  it("apply with a failing validator never pushes and hands off (fix-failed)", async () => {
    const f = fakeDeps({ rounds: [3], validateOk: false });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "fix-failed");
    assert.match(escalations(f.posted)[0], /validation-failed after 2 attempt/);
    assert.equal(f.committed, false);
  });

  it("K3: a policy/context file is NOT editable (scope-violation → retried → fix-failed, no push)", async () => {
    const f = fakeDeps({ rounds: [3], reply: '{"summary":"edit policy","files":[{"path":"docs/POLICY.md","content":"tampered"}]}' });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "fix-failed");
    assert.match(escalations(f.posted)[0], /scope-violation/);
    assert.equal(f.committed, false);
  });

  it("no-change keeps the agent's rationale visible and hands off (fix-declined)", async () => {
    const f = fakeDeps({ rounds: [3], reply: '{"summary":"all three are false positives: the guard exists at line 9","files":[]}' });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "fix-declined");
    assert.ok(f.posted.some((b) => b.startsWith("### Ashlar fix agent — no change") && b.includes("false positives")));
    assert.match(escalations(f.posted)[0], /Detail: no-change: all three are false positives/);
    assert.equal(f.committed, false);
  });

  it("apply on a fork PR hands off (loop-error); suggest on a fork still proposes", async () => {
    const fork = (f: ReturnType<typeof fakeDeps>) => {
      const orig = f.deps.gh.fetchPullHeadRef;
      f.deps.gh.fetchPullHeadRef = async (...a) => ({ ...(await orig(...a)), fork: true });
      return f;
    };
    const a = fork(fakeDeps({ rounds: [3] }));
    const j = job({}, "apply");
    const ra = await runPostReviewLoop("t", j, sample, settings("apply"), [j], a.deps, ENV_ON);
    assert.ok(ra.ran && ra.step === "escalated" && ra.reason === "loop-error");
    assert.match(escalations(a.posted)[0], /fork/);
    const s2 = fork(fakeDeps({ rounds: [3] }));
    const rs = await runPostReviewLoop("t", job(), sample, settings("suggest"), [job()], s2.deps, ENV_ON);
    assert.ok(rs.ran && rs.step === "fix" && rs.outcome === "suggested");
  });

  it("K1: a head that moved before the fix = superseded (quiet: the newer head drives the loop)", async () => {
    const f = fakeDeps({ rounds: [3], liveSha: "a".repeat(40) });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "superseded (head moved)" });
    assert.equal(f.posted.length, 0);
    assert.equal(f.committed, false);
  });

  it("K1: a head move DURING the fix is caught before the commit and is quiet (superseded)", async () => {
    const f = fakeDeps({ rounds: [3], movedDuringFix: true });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "superseded (head moved)" });
    assert.equal(f.committed, false);
    assert.equal(escalations(f.posted).length, 0);
  });

  it("L1: a force-push between validation and the ref write is refused and quiet (superseded)", async () => {
    const f = fakeDeps({ rounds: [3], refMovedAtWrite: true });
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.deepEqual(r, { ran: false, reason: "superseded (head moved)" });
    assert.equal(f.committed, false);
    assert.equal(escalations(f.posted).length, 0);
  });

  it("K2: the global setting is a ceiling — push only when BOTH command and setting say apply", async () => {
    let f = fakeDeps({ rounds: [3] });
    let j = job({}, "suggest");
    let r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "suggested");
    assert.equal(f.committed, false);
    f = fakeDeps({ rounds: [3] });
    j = job({}, "apply");
    r = await runPostReviewLoop("t", j, sample, settings("suggest"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "fix" && r.outcome === "suggested");
    assert.equal(f.committed, false);
    assert.ok(f.posted[0].includes("mode: suggest"), "report uses the effective mode");
  });

  it("never throws: a dependency failure hands off (loop-error) with the cause", async () => {
    const f = fakeDeps({ rounds: [3] });
    f.deps.gh.fetchPullHeadRef = async () => {
      throw new Error("boom");
    };
    const r = await runPostReviewLoop("t", job(), sample, settings(), [job()], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "loop-error");
    assert.match(escalations(f.posted)[0], /Detail: loop step failed: boom/);
  });

  it("a continuation that cannot be composed hands off instead of announcing 'Loop continues'", async () => {
    const f = fakeDeps({ rounds: [3], commitSha: "newsha" }); // not a full SHA → parser would reject
    const j = job({}, "apply");
    const r = await runPostReviewLoop("t", j, sample, settings("apply"), [j], f.deps, ENV_ON);
    assert.ok(r.ran && r.step === "escalated" && r.reason === "loop-error");
    assert.ok(!f.posted.some((b) => /Loop continues/.test(b)), "no false continuation announcement");
    assert.match(escalations(f.posted)[0], /invalid loop continuation/);
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
