import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_COMMENT_MARK, buildOpsComment, llmWorkAllowed, opsCommentAllowed, reviewPostedNotes } from "./ops-comment.ts";

describe("buildOpsComment", () => {
  it("says reviewers run in parallel and names a disconnected bridge", () => {
    const body = buildOpsComment({
      phase: "blocked",
      providers: ["chatgpt", "grok", "local"],
      notes: ["Chrome bridge is not connected. ChatGPT/Grok start when the extension reconnects."],
    });
    assert.match(body, new RegExp(OPS_COMMENT_MARK));
    assert.match(body, /chatgpt \+ grok in parallel \(Chrome\)/);
    assert.match(body, /local racing/);
    assert.match(body, /not connected/);
    assert.doesNotMatch(body, /127\.0\.0\.1|jwhy\.net|Qwen|sk-/);
  });

  it("does not mention Grok when the setting is off", () => {
    const body = buildOpsComment({
      phase: "running",
      providers: ["chatgpt", "local"],
      notes: ["Chrome bridge claimed this job. ChatGPT is running the review."],
    });
    assert.match(body, /chatgpt \(Chrome\)/);
    assert.doesNotMatch(body, /grok/i);
  });

  it("only posts ops comments on @ashlar-bot mention or inline follow-up", () => {
    assert.equal(opsCommentAllowed({ trigger: "issue_comment.mention" }), true);
    assert.equal(opsCommentAllowed({ trigger: "pull_request_review_comment.followup" }), true);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.opened" }), false);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.synchronize" }), false);
    assert.equal(opsCommentAllowed({ trigger: "pull_request.ready_for_review" }), false);
  });

  it("allows LLM work only on mention / follow-up", () => {
    assert.equal(llmWorkAllowed({ trigger: "issue_comment.mention" }), true);
    assert.equal(llmWorkAllowed({ trigger: "pull_request_review_comment.followup" }), true);
    assert.equal(llmWorkAllowed({ trigger: "pull_request.opened" }), false);
    assert.equal(llmWorkAllowed({ trigger: "pull_request.synchronize" }), false);
  });
});

describe("reviewPostedNotes", () => {
  it("summarizes prompt sizes, coverage and dropped findings", () => {
    const notes = reviewPostedNotes(
      {
        headSha: "abcdef012345",
        promptStats: { diffChars: 1000, contextChars: 2000, policyChars: 300, diffFilesFull: 3, diffFilesTotal: 4 },
        coverageDeterministic: [{ path: "a.ts", inDiff: true, inContext: true }, { path: "b.ts", inDiff: false, inContext: false }],
        coverage: [{ file: "a.ts", status: "cleared", reason: "" }, { file: "b.ts", status: "not_cleared", reason: "x" }],
        droppedCount: 2,
      },
      1,
    );
    assert.equal(notes[0], "Reviewed abcdef0");
    assert.ok(notes.some((n) => /Prompt: diff 1000 chars \(3\/4 files full\), context 2000 chars, policy 300 chars/.test(n)));
    assert.ok(notes.some((n) => /Coverage \(deterministic\): 1\/2 code files with full diff, 1\/2 with context/.test(n)));
    assert.ok(notes.some((n) => /Coverage \(model\): not_cleared = b\.ts/.test(n)));
    assert.ok(notes.some((n) => /Findings: 1 returned, 2 dropped by precision policy/.test(n)));
    assert.ok(notes.length <= 8);
  });

  it("notes when HEAD moved and stays minimal without stats", () => {
    const moved = reviewPostedNotes({ headSha: "abcdef012345", headMovedTo: "999888777666" }, 0);
    assert.match(moved[0], /Reviewed abcdef0 \(HEAD moved to 9998887\)/);
    assert.deepEqual(reviewPostedNotes({ headSha: "abcdef012345" }, 0), ["Reviewed abcdef0"]);
  });

  // #77 job 989: the merge gate (cc_merge.py COVERAGE_RE) saw ~7 of 42 not_cleared files and a cut
  // last name («packag») because every note was cut to 200 chars.
  it("keeps a 42-file not_cleared line whole and still caps every other note", () => {
    const files = [
      ...Array.from({ length: 41 }, (_, i) => `src/lib/review-loop/module-${String(i).padStart(2, "0")}.server.ts`),
      "package.json",
    ];
    const notes = reviewPostedNotes(
      {
        headSha: "abcdef012345",
        headMovedTo: "999888777666",
        // WHY cast: numbers alone never reach 200 chars; this proves the cap still applies to other notes.
        promptStats: { diffChars: "9".repeat(300) as unknown as number, contextChars: 2000, policyChars: 300, diffFilesFull: 3, diffFilesTotal: 4 },
        coverageDeterministic: [{ path: "a.ts", inDiff: true, inContext: true }],
        coverage: files.map((file) => ({ file, status: "not_cleared" as const, reason: "x" })),
        droppedCount: 2,
      },
      1,
    );
    const line = `Coverage (model): not_cleared = ${files.join(", ")}`;
    assert.ok(line.length > 200);
    assert.ok(notes.includes(line), "the not_cleared note is emitted whole, byte for byte");
    const others = notes.filter((n) => n !== line);
    assert.ok(others.every((n) => n.length <= 200), "every other note stays at 200 chars or less");
    assert.ok(others.some((n) => n.startsWith("Prompt: diff ") && n.length === 200));
    assert.ok(notes.length <= 8);

    // The gate parses the posted body, not the notes: the same regex must recover all 42 names.
    const body = buildOpsComment({ phase: "posted", providers: ["chatgpt"], notes: ["Job: j1", ...notes] });
    assert.ok(body.includes(`\n- ${line}\n`));
    const m = /Coverage \(model\):\s*not_cleared\s*=\s*(.+)/.exec(body);
    assert.ok(m);
    assert.deepEqual(m[1].trim().split(",").map((p) => p.trim()).filter(Boolean), files);
  });
});
