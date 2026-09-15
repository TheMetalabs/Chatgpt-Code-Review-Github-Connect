import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412 } from "./samples.ts";
import { inlineFindingComment, reviewSummaryBody, severityBadgeMarkdown } from "./review-format.ts";

describe("review-format", () => {
  it("matches Codex P1 badge markup on inline comments", () => {
    const body = inlineFindingComment(FINDING_412, {
      owner: "acme",
      repo: "pay",
      headSha: "abc1234ffff",
    });
    assert.match(body, /!\[P1 Badge\]\(https:\/\/img\.shields\.io\/badge\/P1-orange\?style=flat\)/);
    assert.match(body, /Webhook can capture twice/);
    assert.match(body, /Useful\? React with 👍 \/ 👎/);
    assert.match(body, /blob\/abc1234ffff\/src\/payment\/webhook\.ts#L10/);
    assert.equal(severityBadgeMarkdown("P0").includes("P0-red"), true);
    assert.equal(severityBadgeMarkdown("P2").includes("P2-yellow"), true);
  });

  it("uses a Codex-style summary for zero and non-zero findings", () => {
    const empty = reviewSummaryBody({ headSha: "bd663b721d", reviewProviders: ["chatgpt", "grok"], assumptions: [] }, [], "ashlar-bot");
    assert.match(empty, /### 💡 Ashlar Review/);
    assert.match(empty, /Reviewed commit:\*\* `bd663b7`/);
    assert.match(empty, /Didn't find any major issues/);
    const full = reviewSummaryBody({ headSha: "bd663b721d", reviewProviders: ["chatgpt", "grok", "local"], assumptions: [] }, [FINDING_412], "ashlar-bot");
    assert.match(full, /Here are some automated review suggestions/);
    assert.match(full, /\| P1 \| 1 \|/);
  });
});
