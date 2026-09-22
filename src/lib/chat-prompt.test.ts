import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412, SAMPLE_PRS } from "./samples.ts";
import { fullFileContext } from "./context-slice.ts";
import {
  CHAT_JSON_HINT,
  MERGE_FALLBACK_NOTE,
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

describe("REVIEW_INSTRUCTIONS recall guidance", () => {
  it("does not let an uncleared helper suppress a finding", () => {
    assert.match(REVIEW_INSTRUCTIONS, /never justifies withholding a finding/);
    assert.match(REVIEW_INSTRUCTIONS, /name the unverified helper\/dependency in evidence/);
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
