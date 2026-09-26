import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412, SAMPLE_PRS } from "./samples.ts";
import { fullFileContext } from "./context-slice.ts";
import {
  CHAT_JSON_HINT,
  MERGE_FALLBACK_NOTE,
  PRIOR_THREAD_RULE,
  PR_SCOPE_RULE,
  REVIEW_INSTRUCTIONS,
  REVIEW_OFFLINE_RULE,
  buildChatParts,
  buildChatPrompt,
  buildFpPrompt,
  buildMergePrompt,
  isSandboxPolicy,
  parseChatSubmission,
  splitChatAttachments,
} from "./chat-prompt.ts";
import { PRIOR_REPLY_MAX_CHARS, PRIOR_THREADS_MAX, PRIOR_THREADS_MAX_CHARS, formatPriorThreads, selectPriorThreads } from "./prior-threads.ts";

describe("REVIEW_INSTRUCTIONS recall guidance", () => {
  it("does not let an uncleared helper suppress a finding", () => {
    assert.match(REVIEW_INSTRUCTIONS, /never justifies withholding a finding/);
    assert.match(REVIEW_INSTRUCTIONS, /never justifies withholding a finding whose defect is in the diff or snapshot/);
    assert.match(REVIEW_INSTRUCTIONS, /name the unverified helper\/dependency in evidence/);
    assert.doesNotMatch(REVIEW_INSTRUCTIONS, /Under-report nothing/, "recall no longer overrides the premise check");
  });
  it("binds the premise check: a defect in code not shown is verified or goes to assumptions, never P0/P1 (aicc #455)", () => {
    assert.match(REVIEW_INSTRUCTIONS, /A finding whose defect depends on code NOT in the diff or snapshot .* is a premise you must verify by reading that code — with a tool or connector if this review mode provides one\./);
    assert.match(REVIEW_INSTRUCTIONS, /If you cannot read it, list it in assumptions, not findings, and never as P0\/P1/);
  });
  it("keeps a far-from-hunk finding reportable instead of anchor-only", () => {
    assert.match(REVIEW_INSTRUCTIONS, /still report it: set line to the nearest changed line/);
  });
});

describe("parseChatSubmission", () => {
  it("reads a bare JSON object", () => {
    const out = parseChatSubmission(`{"merge_recommendation":"COMMENT","findings":[]}`);
    assert.equal(out?.merge_recommendation, "COMMENT");
  });

  it("strips markdown fences", () => {
    const out = parseChatSubmission("```json\n{\"findings\":[]}\n```");
    assert.ok(Array.isArray(out?.findings));
  });

  it("rejects empty and non-objects", () => {
    assert.equal(parseChatSubmission(""), null);
    assert.equal(parseChatSubmission("[1]"), null);
    assert.equal(parseChatSubmission("not json"), null);
  });

  it("pulls the review object out of thinking braces", () => {
    const raw = `Thinking { "scratch": 1 }\n{"merge_recommendation":"APPROVE","findings":[],"investigated_safe":["ok"]}`;
    const out = parseChatSubmission(raw);
    assert.equal(out?.merge_recommendation, "APPROVE");
    assert.ok(Array.isArray(out?.findings));
  });
});

describe("buildChatPrompt", () => {
  it("forbids web research and tools so reviewers spend tokens on the snapshot only", () => {
    const out = buildChatPrompt({ sample: SAMPLE_PRS["pay-412"] });
    assert.match(out, /Do not search the web/);
    assert.match(out, /DeepSearch/);
    assert.match(out, /Do not call tools/);
    assert.match(REVIEW_OFFLINE_RULE, /only source of truth/i);
    const fp = buildFpPrompt({ sample: SAMPLE_PRS["pay-412"], findings: [FINDING_412], peer: "grok" });
    assert.match(fp, /Do not search the web/);
    const merge = buildMergePrompt({
      sample: SAMPLE_PRS["pay-412"],
      drafts: [{ provider: "chatgpt", raw: '{"findings":[]}' }],
    });
    assert.match(merge, /Do not search the web/);
  });

  it("keeps the JSON schema complete and puts large snapshots in attachments", () => {
    const sample = {
      ...SAMPLE_PRS["pay-412"],
      files: [
        { path: "README.md", language: "md" as const, content: `${"x".repeat(30_000)}\n# App Builder Workspace` },
        ...SAMPLE_PRS["pay-412"].files,
      ],
      changedPaths: ["README.md", ...SAMPLE_PRS["pay-412"].changedPaths],
      diff: `${SAMPLE_PRS["pay-412"].diff}\n${"y".repeat(12_000)}`,
    };
    const { prompt, files } = buildChatParts({ sample });
    assert.match(prompt, /merge_recommendation/);
    assert.ok(prompt.includes(CHAT_JSON_HINT.slice(0, 40)));
    assert.ok(prompt.length < 8_000, "composer text stays short");
    assert.ok(files.some((f) => f.name === "ashlar-diff.patch"));
    assert.ok(files.some((f) => f.name === "ashlar-snapshot.md"));
    const encoded = buildChatPrompt({ sample });
    assert.match(encoded, /<<<ASHLAR_ATTACHMENTS_V2>>>/);
    assert.match(encoded, /<<<END_ASHLAR_ATTACHMENTS_V2>>>/);
    const split = splitChatAttachments(encoded);
    assert.equal(split.files.length, 2);
    assert.match(split.prompt, /Return exactly this JSON shape/);
    assert.doesNotMatch(split.prompt, /App Builder Workspace/);
  });

  it("drops sandbox AGENTS.md from the review snapshot", () => {
    assert.equal(isSandboxPolicy("# App Builder Workspace\nGrok Build, in an isolated Linux sandbox"), true);
    const sample = {
      ...SAMPLE_PRS["pay-412"],
      files: [
        {
          path: "AGENTS.md",
          language: "md" as const,
          content: "# App Builder Workspace\nGrok Build, in an isolated Linux sandbox\nimagine_*",
        },
        ...SAMPLE_PRS["pay-412"].files,
      ],
      changedPaths: ["AGENTS.md", ...SAMPLE_PRS["pay-412"].changedPaths],
    };
    const out = buildChatPrompt({ sample });
    assert.doesNotMatch(out, /imagine_\*/);
    assert.doesNotMatch(out, /web search if helpful/);
  });
});

describe("buildMergePrompt", () => {
  it("asks ChatGPT to merge drafts when local is unavailable", () => {
    const out = buildMergePrompt({
      sample: SAMPLE_PRS["pay-412"],
      drafts: [{ provider: "chatgpt", raw: '{"findings":[]}' }],
    });
    assert.match(out, /local LLM was unavailable/i);
    assert.match(out, /DRAFT chatgpt/);
    assert.match(MERGE_FALLBACK_NOTE, /ChatGPT to merge/);
  });
});

describe("buildChatParts hunk context", () => {
  const sample = {
    key: "k", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s",
    headSha: "abc1234", baseSha: "def5678", isFork: false, isDraft: false, labels: [],
    changedPaths: ["src/x.ts"],
    files: [{ path: "src/x.ts", language: "ts" as const, content: ["export function f() {", "  const a = 1;", "  return a;", "}"].join("\n") }],
    diff: "--- src/x.ts\n@@ -1,3 +1,4 @@\n export function f() {\n+  const a = 1;\n   return a;\n }",
  };

  it("emits line-numbered hunk context, not a raw head slice", () => {
    const { files } = buildChatParts({ sample });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap, "snapshot attachment present");
    assert.match(snap!.body, /--- src\/x\.ts \(L\d+-L\d+\)/);
    assert.ok(snap!.body.includes("1| "), "line-number gutter present");
  });

  it("ASHLAR_CONTEXT_MODE=head restores the raw head format", () => {
    process.env.ASHLAR_CONTEXT_MODE = "head";
    try {
      const { files } = buildChatParts({ sample });
      const snap = files.find((f) => f.name === "ashlar-snapshot.md");
      assert.ok(snap!.body.startsWith("--- src/x.ts\n"), "raw head format");
      assert.doesNotMatch(snap!.body, /\(L1-/);
    } finally {
      delete process.env.ASHLAR_CONTEXT_MODE;
    }
  });
});

describe("buildChatParts full changed-file body (P1)", () => {
  // A change at the TOP of the file plus a helper far below it, beyond the hunk-window pad. The
  // hunk windows omit the helper; attaching the whole file (when it fits) makes it visible — the
  // fix for the same-file-helper false positive.
  const far = ["export function changed() {", "  return 1;", "}", ...Array.from({ length: 60 }, (_, i) => `// filler line ${i}`), "export function farHelper() {", "  return 'FAR_HELPER_MARKER';", "}"].join("\n");
  const sample = {
    key: "k", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s",
    headSha: "abc1234", baseSha: "def5678", isFork: false, isDraft: false, labels: [] as string[],
    changedPaths: ["src/big.ts"],
    files: [{ path: "src/big.ts", language: "ts" as const, content: far }],
    diff: "--- src/big.ts\n@@ -1,2 +1,3 @@\n export function changed() {\n+  return 1;\n }",
  };

  it("attaches the whole file when it fits, so a helper far from the hunk is visible", () => {
    const { files } = buildChatParts({ sample });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("FAR_HELPER_MARKER"), "far same-file helper is in the snapshot");
    assert.match(snap!.body, /--- src\/big\.ts \(L1-L\d+\)/, "emitted as a full-file block with gutters");
  });

  it("falls back to hunk windows when the file is too large for the budget", () => {
    const { files } = buildChatParts({ sample, contextMaxChars: 500 });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(!snap!.body.includes("FAR_HELPER_MARKER"), "over-budget file degrades — far helper omitted");
    assert.ok(snap!.body.includes("changed()"), "the changed region is still present");
  });

  it("ASHLAR_CONTEXT_FULL_FILES=0 keeps the hunk-window behavior even when the file fits", () => {
    const prev = process.env.ASHLAR_CONTEXT_FULL_FILES;
    process.env.ASHLAR_CONTEXT_FULL_FILES = "0";
    try {
      const { files } = buildChatParts({ sample });
      const snap = files.find((f) => f.name === "ashlar-snapshot.md");
      assert.ok(!snap!.body.includes("FAR_HELPER_MARKER"), "opt-out restores hunk-window slices");
    } finally {
      if (prev === undefined) delete process.env.ASHLAR_CONTEXT_FULL_FILES;
      else process.env.ASHLAR_CONTEXT_FULL_FILES = prev;
    }
  });

  it("attaches the whole file when it is exactly at the budget (no phantom separator before the first block)", () => {
    // Regression for the off-by-2: a single/first block needs no join separator, so a file whose
    // full block length equals the budget must still be attached whole, not degraded to hunk windows.
    const exact = fullFileContext("src/big.ts", sample.files[0].content).length;
    const { files } = buildChatParts({ sample, contextMaxChars: exact });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("FAR_HELPER_MARKER"), "exact-fit first file is attached whole");
  });

  it("a large first file does not starve a later changed file of its baseline context", () => {
    // Regression: the full-file branch must not consume the whole budget. Two changed files where
    // file A's full body is huge; B must still receive at least its hunk window.
    const bigA = ["export function a() {", "  return 1;", "}", ...Array.from({ length: 400 }, (_, i) => `// A filler ${i}`)].join("\n");
    const twoFile = {
      ...sample,
      changedPaths: ["src/a.ts", "src/b.ts"],
      files: [
        { path: "src/a.ts", language: "ts" as const, content: bigA },
        { path: "src/b.ts", language: "ts" as const, content: ["export function bbb() {", "  return 'B_MARKER';", "}"].join("\n") },
      ],
      diff: "--- src/a.ts\n@@ -1,2 +1,3 @@\n export function a() {\n+  return 1;\n }\n\n--- src/b.ts\n@@ -1,2 +1,3 @@\n export function bbb() {\n+  return 'B_MARKER';\n }",
    };
    // Budget fits A's full body but would leave nothing for B if A were greedy.
    const { files } = buildChatParts({ sample: twoFile, contextMaxChars: fullFileContext("src/a.ts", bigA).length + 40 });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("B_MARKER"), "file B keeps its baseline context — not starved by A's full body");
  });

  it("a hunk-heavy first file does not consume the whole baseline budget (fair-share pass 1)", () => {
    // File A has MANY scattered hunks whose windows alone could fill the budget; B must still get
    // its baseline slice. This exercises the pass-1 greedy-slice path, not just the full-body path.
    const aLines: string[] = [];
    const aDiffHunks: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const base = i * 6;
      aLines.push(`export function a_marker_${i}() {`, `  return ${i};`, "}", "", "", "");
      aDiffHunks.push(`@@ -${base + 1},1 +${base + 1},2 @@\n export function a_marker_${i}() {\n+  return ${i};`);
    }
    const twoFile = {
      ...sample,
      changedPaths: ["src/a.ts", "src/b.ts"],
      files: [
        { path: "src/a.ts", language: "ts" as const, content: aLines.join("\n") },
        { path: "src/b.ts", language: "ts" as const, content: ["export function bbb() {", "  return 'B_BASELINE';", "}"].join("\n") },
      ],
      diff: `--- src/a.ts\n${aDiffHunks.join("\n")}\n\n--- src/b.ts\n@@ -1,2 +1,3 @@\n export function bbb() {\n+  return 'B_BASELINE';\n }`,
    };
    // Budget is small enough that A's hunk windows would fill it if A were not capped to its share.
    const { files } = buildChatParts({ sample: twoFile, contextMaxChars: 900, contextPadLines: 3 });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("B_BASELINE"), "file B keeps a baseline slice despite A's many hunks");
  });

  it("budget a later file did not need still restores an earlier file's whole body", () => {
    // A (higher priority) is large with a far helper; B (lower priority) is tiny. Both full bodies fit
    // the budget together, so A must be shown whole — a forward-only allocator that reserved a share
    // for B and never revisited A would wrongly leave A's helper out (the round-4 regression).
    const bigA = ["export function aa() {", "  return 1;", "}", ...Array.from({ length: 40 }, (_, i) => `// A ${i}`), "export function aFar() {", "  return 'A_FAR_MARKER';", "}"].join("\n");
    const twoFile = {
      ...sample,
      changedPaths: ["src/a.ts", "src/b.ts"],
      files: [
        { path: "src/a.ts", language: "ts" as const, content: bigA },
        { path: "src/b.ts", language: "ts" as const, content: "export function b() { return 2; }" },
      ],
      diff: "--- src/a.ts\n@@ -1,2 +1,3 @@\n export function aa() {\n+  return 1;\n }\n\n--- src/b.ts\n@@ -1,1 +1,1 @@\n-export function b() { return 1; }\n+export function b() { return 2; }",
    };
    const budget = fullFileContext("src/a.ts", bigA).length + fullFileContext("src/b.ts", twoFile.files[1].content).length + 10;
    const { files } = buildChatParts({ sample: twoFile, contextMaxChars: budget });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("A_FAR_MARKER"), "A's far helper is present — leftover restored A's whole body");
  });

  it("no changed file is dropped while budget remains (many-file fair shares retried from the remainder)", () => {
    // Four files with a budget whose per-file fair share (~budget/4) is too small for one file's hunk
    // window, yet the whole budget comfortably holds every file's slice. None may be dropped.
    const body = (marker: string) => ["export function fn() {", ...Array.from({ length: 12 }, (_, i) => `  const ${marker}${i} = ${i};`), `  return '${marker}';`, "}"].join("\n");
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const markers = ["AA", "BB", "CC", "DD"];
    const many = {
      ...sample,
      changedPaths: paths,
      files: paths.map((p, i) => ({ path: p, language: "ts" as const, content: body(markers[i]) })),
      diff: paths.map((p) => `--- ${p}\n@@ -1,1 +1,2 @@\n export function fn() {\n+  const x = 0;`).join("\n\n"),
    };
    const { files } = buildChatParts({ sample: many, contextMaxChars: 4000, contextPadLines: 20 });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    for (const p of paths) assert.ok(snap!.body.includes(p), `${p} is present — no file dropped while budget remains`);
  });

  it("fast path: when every whole body fits together, all changed files are shown whole", () => {
    const twoFile = {
      ...sample,
      changedPaths: ["src/a.ts", "src/b.ts"],
      files: [
        { path: "src/a.ts", language: "ts" as const, content: ["export function a() {", "  return 1;", "}", "export function aHelper() { return 'AH'; }"].join("\n") },
        { path: "src/b.ts", language: "ts" as const, content: ["export function b() {", "  return 2;", "}", "export function bHelper() { return 'BH'; }"].join("\n") },
      ],
      diff: "--- src/a.ts\n@@ -1,2 +1,3 @@\n export function a() {\n+  return 1;\n }\n\n--- src/b.ts\n@@ -1,2 +1,3 @@\n export function b() {\n+  return 2;\n }",
    };
    const { files } = buildChatParts({ sample: twoFile });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap!.body.includes("aHelper") && snap!.body.includes("bHelper"), "both files' helpers present — all shown whole");
  });
});

describe("buildChatParts cross-file definitions", () => {
  const sample = {
    key: "k", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s",
    headSha: "abc1234", baseSha: "def5678", isFork: false, isDraft: false, labels: [] as string[],
    changedPaths: ["src/pay.ts"],
    files: [{ path: "src/pay.ts", language: "ts" as const, content: ["import { addMonths } from './date';", "export function issue() {", "  return addMonths(1);", "}"].join("\n") }],
    diff: "--- src/pay.ts\n@@ -1,3 +1,4 @@\n export function issue() {\n+  return addMonths(1);\n }",
    referenceFiles: [{ path: "src/date.ts", language: "ts" as const, content: ["export function addMonths(n) {", "  return n; // inclusive boundary note", "}"].join("\n") }],
  };

  it("attaches definitions of imported helpers the changed hunk calls (file-attachment analog of the loop's file_read)", () => {
    const { files, prompt } = buildChatParts({ sample });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap, "snapshot present");
    assert.match(snap!.body, /CROSS_FILE_DEFINITIONS/);
    assert.match(snap!.body, /addMonths/);
    assert.match(snap!.body, /inclusive boundary note/); // the cross-file body, not just a signature
    assert.match(prompt, /CROSS_FILE_DEFINITIONS/); // the attachment description names the section
  });

  it("omits the cross-file section when there are no reference files", () => {
    const { files } = buildChatParts({ sample: { ...sample, referenceFiles: [] } });
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(snap, "snapshot present");
    assert.doesNotMatch(snap!.body, /CROSS_FILE_DEFINITIONS/);
  });
});

describe("ashlar-policy.md attachment", () => {
  const base = { key: "k", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s", headSha: "abc1234", baseSha: "def5678", isFork: false, isDraft: false, labels: [] as string[] };
  const withPolicy = {
    ...base,
    changedPaths: ["src/x.ts"],
    files: [
      { path: "AGENTS.md", language: "md" as const, content: "# Repo\n\n## Domain\n\n- money is integer won\n\n## Code Review Rules\n\n- always check nulls" },
      { path: "src/x.ts", language: "ts" as const, content: ["export function f() {", "  return 1;", "}"].join("\n") },
    ],
    diff: "--- src/x.ts\n@@ -1,2 +1,3 @@\n export function f() {\n+  return 1;\n }",
  };

  it("delivers unchanged repo policy INCLUDING domain contracts, despite the changed-file snapshot filter", () => {
    const { files } = buildChatParts({ sample: withPolicy });
    const policy = files.find((f) => f.name === "ashlar-policy.md");
    assert.ok(policy, "policy attachment present");
    assert.match(policy!.body, /Code Review Rules/);
    assert.match(policy!.body, /always check nulls/);
    // Regression: a small policy file is delivered whole, so DOMAIN invariants above the review-rules
    // heading are no longer sliced away (they are exactly what contract-compliance findings need).
    assert.match(policy!.body, /money is integer won/);
    const snap = files.find((f) => f.name === "ashlar-snapshot.md");
    assert.ok(!snap || !snap.body.includes("AGENTS.md"), "unchanged policy not in the snapshot attachment");
  });

  it("excludes sandbox policy content", () => {
    const sandbox = { ...withPolicy, files: [{ path: "AGENTS.md", language: "md" as const, content: "# App Builder Workspace\nimagine_*" }, withPolicy.files[1]] };
    const { files } = buildChatParts({ sample: sandbox });
    assert.ok(!files.some((f) => f.name === "ashlar-policy.md"), "sandbox policy produces no attachment");
  });

  it("honors ASHLAR_POLICY_ATTACH=0", () => {
    process.env.ASHLAR_POLICY_ATTACH = "0";
    try {
      const { files } = buildChatParts({ sample: withPolicy });
      assert.ok(!files.some((f) => f.name === "ashlar-policy.md"));
    } finally {
      delete process.env.ASHLAR_POLICY_ATTACH;
    }
  });

  it("instructions allow unchanged-code evidence and require coverage; schema has coverage", () => {
    assert.match(REVIEW_INSTRUCTIONS, /may run through unchanged code/);
    assert.match(REVIEW_INSTRUCTIONS, /ashlar-policy\.md \(repository review rules\)/);
    assert.match(REVIEW_INSTRUCTIONS, /coverage: one entry per changed code file/);
    assert.match(CHAT_JSON_HINT, /"coverage"/);
  });
});

describe("prior finding threads (aicc #455)", () => {
  const BOT = "ashlar-bot-review-loop[bot]";
  const root = (id: number, path: string, line: number, title: string, at = "2026-09-01T00:00:00Z") => ({
    id, userLogin: BOT, userType: "Bot", path, line, createdAt: at,
    body: `**<sub><sub>![P1 Badge](https://x/p1.svg)</sub></sub>**  **${title}**\n\nscenario\n\nUseful? React with 👍 / 👎.`,
  });
  const reply = (id: number, to: number, userLogin: string, body: string, at: string, userType = "User") =>
    ({ id, inReplyToId: to, userLogin, userType, path: "x", createdAt: at, body });
  const CORS = [
    root(1, "src/requestUtils.js", 289, "CORS exposedHeaders omits X-Total"),
    reply(2, 1, BOT, "Declined by the Ashlar fix agent (round 2): exposedHeaders already set at src/server.js:41.", "2026-09-02T00:00:00Z", "Bot"),
  ];

  it("selects App-started threads answered by a human or the App's fix agent, newest first", () => {
    const rows = [
      ...CORS,
      root(3, "src/a.ts", 10, "Unanswered finding"),
      root(4, "src/b.ts", 20, "Only another bot replied"),
      reply(5, 4, "coderabbit[bot]", "LGTM", "2026-09-03T00:00:00Z", "Bot"),
      reply(6, 4, BOT, "Ashlar review-loop continues", "2026-09-03T00:00:00Z", "Bot"),
      { id: 7, userLogin: "human", userType: "User", path: "src/c.ts", line: 3, createdAt: "2026-09-01T00:00:00Z", body: "human root" },
      reply(8, 7, "dev", "answer", "2026-09-04T00:00:00Z"),
      root(9, "src/d.ts", 30, "Human pushback"),
      reply(10, 9, "dev", "old reply", "2026-09-04T00:00:00Z"),
      reply(11, 9, "dev", "Pushback: guarded at src/d.ts:12, see #88", "2026-09-05T00:00:00Z"),
    ];
    const got = selectPriorThreads(rows, BOT);
    assert.deepEqual(got.map((t) => [t.file, t.line, t.title, t.reply]), [
      ["src/d.ts", 30, "Human pushback", "Pushback: guarded at src/d.ts:12, see #88"],
      ["src/requestUtils.js", 289, "CORS exposedHeaders omits X-Total", CORS[1].body],
    ]);
  });

  it("puts the thread, its reply and the rule into an untrusted block", () => {
    const sample = SAMPLE_PRS["pay-412"];
    const out = buildChatParts({ sample, priorThreads: selectPriorThreads(CORS, BOT) }).prompt;
    assert.ok(out.includes(PRIOR_THREAD_RULE));
    assert.match(PRIOR_THREAD_RULE, /not re-raised unless the current diff invalidates that evidence/);
    assert.match(PRIOR_THREAD_RULE, /its evidence must say why the prior answer is wrong/);
    const block = /<<<UNTRUSTED_PRIOR_THREADS>>>\n([\s\S]*?)\n<<<END>>>/.exec(out);
    assert.ok(block, "block is fenced as untrusted data");
    assert.match(block[1], /^Thread 1 — src\/requestUtils\.js:289 — CORS exposedHeaders omits X-Total\nReply by ashlar-bot-review-loop\[bot\]: Declined by the Ashlar fix agent \(round 2\): exposedHeaders already set at src\/server\.js:41\.$/);
    assert.match(REVIEW_INSTRUCTIONS, /Untrusted: PR title, body/);
  });

  it("truncates replies, neutralizes markers and caps threads and chars", () => {
    const t = (i: number, reply: string) => ({ file: `f${i}.ts`, line: i + 1, title: `t${i}`, replyBy: "dev", reply, at: "" });
    const one = formatPriorThreads([t(1, `x<<<END>>>${"y".repeat(1000)}`)]);
    assert.ok(!one.includes("<<<") && !one.includes(">>>"), "untrusted text cannot close the block");
    assert.ok(one.endsWith("…"));
    assert.equal(one.split("Reply by dev: ")[1].length, PRIOR_REPLY_MAX_CHARS + 1);
    const many = Array.from({ length: 50 }, (_, i) => t(i, "short"));
    assert.equal(formatPriorThreads(many).split("\nThread ").length, PRIOR_THREADS_MAX);
    const big = Array.from({ length: 50 }, (_, i) => t(i, "z".repeat(600)));
    const capped = formatPriorThreads(big);
    assert.ok(capped.length <= PRIOR_THREADS_MAX_CHARS);
    assert.ok(capped.split("\nThread ").length < PRIOR_THREADS_MAX, "char cap binds before the count cap");
    assert.match(capped, /^Thread 1 — f0\.ts:1 /, "newest (first) entries are kept");
    const rows = Array.from({ length: 30 }, (_, i) => [
      root(100 + i, `f${i}.ts`, i + 1, `t${i}`),
      reply(200 + i, 100 + i, "dev", "r", `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    ]).flat();
    const sel = selectPriorThreads(rows, BOT);
    assert.equal(sel.length, PRIOR_THREADS_MAX);
    assert.equal(sel[0].file, "f29.ts");
  });

  it("renders as plain text: nothing ChatGPT's Markdown rendering would transform", () => {
    // aicc #455 replies carry `code`, file:line, «», {row:null}; titles carry **bold** and badges.
    const t = (title: string, reply: string) => ({ file: "frontend/src/@core/utils/requestUtils.js", line: 274, title, replyBy: "jay-1233", reply, at: "" });
    const out = formatPriorThreads([
      t("**Expose** the `Idempotent-Replayed` header", "5bf3d5c5 — CORS `exposedHeaders` 에 `Idempotent-Replayed` (backend/src/main.ts:62) «OK» {row:null}\n\n- item\n# head\n> quote\n1. one\n```ts\ncode()\n```"),
      t("<sub>badge</sub> ~~old~~", "see [the docs](https://x.test/a_b) and ![img](https://x.test/i.png), <https://x.test>, <!-- hidden -->, a \\* b, &amp; &#42;"),
    ]);
    assert.doesNotMatch(out, /[`*~<>\\]/, "no code, emphasis, strike, HTML or escape characters");
    assert.doesNotMatch(out, /\]\(/, "no link syntax");
    assert.doesNotMatch(out, /&#?\w+;/, "no entities");
    for (const line of out.split("\n")) assert.match(line, /^(?:Thread \d+ — |Reply by )/, "every line starts with a fixed word, never a Markdown block marker");
    assert.match(out, /Thread 1 — frontend\/src\/@core\/utils\/requestUtils\.js:274 — Expose the 'Idempotent-Replayed' header\n/);
    assert.match(out, /see the docs \(https:\/\/x\.test\/a_b\) and img \(https:\/\/x\.test\/i\.png\), ‹https:\/\/x\.test›, ‹!-- hidden --›/);
    assert.match(out, /Thread 2 — [^\n]+ — ‹sub›badge‹\/sub› old\n/);
  });

  it("keeps the prompt's first and last 160 characters free of the block", () => {
    const sample = SAMPLE_PRS["pay-412"];
    const threads = [{ file: "a.ts", line: 1, title: "t", replyBy: "dev", reply: "r".repeat(300), at: "" }];
    const base = buildChatParts({ sample, untrustedBody: "body" }).prompt;
    const withThreads = buildChatParts({ sample, untrustedBody: "body", priorThreads: threads }).prompt;
    assert.equal(withThreads.slice(0, 160), base.slice(0, 160));
    assert.equal(withThreads.slice(-160), base.slice(-160));
  });

  it("leaves the full-mode prompt byte-identical without prior threads", () => {
    const sample = SAMPLE_PRS["pay-412"];
    const base = buildChatPrompt({ sample, untrustedBody: "body" });
    assert.equal(buildChatPrompt({ sample, untrustedBody: "body", priorThreads: [] }), base);
    assert.equal(buildChatPrompt({ sample, untrustedBody: "body", priorThreads: selectPriorThreads([CORS[0]], BOT) }), base);
    assert.ok(!base.includes("PRIOR_THREADS") && !base.includes(PRIOR_THREAD_RULE));
    const withThreads = buildChatPrompt({ sample, untrustedBody: "body", priorThreads: selectPriorThreads(CORS, BOT) });
    const section = `${PRIOR_THREAD_RULE}\n<<<UNTRUSTED_PRIOR_THREADS>>>\n${formatPriorThreads(selectPriorThreads(CORS, BOT))}\n<<<END>>>\n\n`;
    assert.equal(withThreads.replace(section, ""), base, "the block is purely additive");
  });
});

// Live aicc #457: the PR body put SENDING recovery out of scope; the review saw only its first 800
// chars as UNTRUSTED_PR_BODY, and a later round added the work back.
describe("PR scope block (#457)", () => {
  const scoped = { ...SAMPLE_PRS["pay-412"], body: "## Summary\nx\n\n## Out of scope\n- SENDING recovery (#470)\n\n## Test plan\n- jest" };
  it("the review prompt carries the PR body's scope section with its rule", () => {
    const p = buildChatPrompt({ sample: scoped });
    assert.ok(p.includes(`${PR_SCOPE_RULE}\n<<<UNTRUSTED_PR_SCOPE>>>\n## Out of scope\n- SENDING recovery (#470)\n<<<END>>>`));
  });
  it("a PR body without a scope statement leaves the prompt unchanged", () => {
    const plain = { ...SAMPLE_PRS["pay-412"], body: "## Summary\nfix" };
    assert.ok(!buildChatPrompt({ sample: plain }).includes("UNTRUSTED_PR_SCOPE"));
    assert.equal(buildChatPrompt({ sample: plain }), buildChatPrompt({ sample: { ...plain, body: "" } }));
  });
});

