import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412, SAMPLE_PRS } from "./samples.ts";
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

describe("ashlar-policy.md attachment", () => {
  const base = { key: "k", owner: "o", repo: "r", pr: 1, title: "t", body: "", sender: "s", headSha: "abc1234", baseSha: "def5678", isFork: false, isDraft: false, labels: [] as string[] };
  const withPolicy = {
    ...base,
    changedPaths: ["src/x.ts"],
    files: [
      { path: "AGENTS.md", language: "md" as const, content: "# Repo\n\n## Code Review Rules\n\n- always check nulls\n\n## Other\n\nnoise" },
      { path: "src/x.ts", language: "ts" as const, content: ["export function f() {", "  return 1;", "}"].join("\n") },
    ],
    diff: "--- src/x.ts\n@@ -1,2 +1,3 @@\n export function f() {\n+  return 1;\n }",
  };

  it("delivers unchanged repo policy despite the changed-file snapshot filter", () => {
    const { files } = buildChatParts({ sample: withPolicy });
    const policy = files.find((f) => f.name === "ashlar-policy.md");
    assert.ok(policy, "policy attachment present");
    assert.match(policy!.body, /Code Review Rules/);
    assert.match(policy!.body, /always check nulls/);
    assert.doesNotMatch(policy!.body, /noise/);
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
