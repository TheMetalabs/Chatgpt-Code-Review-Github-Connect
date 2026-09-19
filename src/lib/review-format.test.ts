import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412 } from "./samples.ts";
import { CLEAN_REVIEW_BODY, inlineFindingComment, reviewSummaryBody, severityBadgeMarkdown } from "./review-format.ts";

describe("review-format", () => {
  it("surfaces a salvaged raw review in the body and is not a clean pass", () => {
    const body = reviewSummaryBody(
      { headSha: "abc1234ffff", reviewProviders: ["chatgpt"], assumptions: [], coverage: [], rawReview: "P1 real bug in pay.ts when amount is 0" },
      [],
      "ashlar-bot",
      [],
    );
    assert.doesNotMatch(body, new RegExp(CLEAN_REVIEW_BODY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body, /P1 real bug in pay\.ts/);
    assert.match(body, /raw=1/);
    assert.match(body, /not parseable JSON/i);
  });

  it("neutralizes a clean-pass sentinel embedded in the salvaged reply (no false-converge)", () => {
    const body = reviewSummaryBody(
      { headSha: "abc1234ffff", reviewProviders: ["chatgpt"], assumptions: [], coverage: [], rawReview: "Didn't find any major issues." },
      [],
      "ashlar-bot",
      [],
    );
    assert.doesNotMatch(body, /Didn.t find any major issues/); // the poller's clean regex must not match a salvaged body
    assert.match(body, /reported no major issues/);
    assert.match(body, /raw=1/);
  });

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
    const empty = reviewSummaryBody({ headSha: "bd663b721d", reviewProviders: ["chatgpt", "grok"], assumptions: [], coverage: [] }, [], "ashlar-bot");
    assert.equal(empty.split("\n")[0], CLEAN_REVIEW_BODY);
    assert.match(empty, /Didn.t find any major issues/);
    assert.match(empty, /Reviewed commit: `bd663b7`/);
    assert.doesNotMatch(empty, /Codex/);
    const partial = reviewSummaryBody(
      {
        headSha: "bd663b721d",
        reviewProviders: ["chatgpt", "grok", "local"],
        assumptions: ["Skipped grok, local (quota or unavailable)"],
      },
      [],
      "ashlar-bot",
    );
    assert.notEqual(partial, CLEAN_REVIEW_BODY);
    assert.match(partial, /Not a clean pass/);
    const full = reviewSummaryBody({ headSha: "bd663b721d", reviewProviders: ["chatgpt", "grok", "local"], assumptions: [] }, [FINDING_412], "ashlar-bot");
    assert.match(full, /Here are some automated review suggestions/);
    assert.match(full, /\| P1 \| 1 \|/);
  });

  it("clean body keeps the first line, adds reviewed sha and a coverage comment", () => {
    const clean = reviewSummaryBody(
      {
        headSha: "abcdef012345",
        reviewProviders: ["chatgpt"],
        assumptions: [],
        coverage: [{ file: "a.ts", status: "cleared", reason: "" }, { file: "b.ts", status: "not_cleared", reason: "unverified" }],
      },
      [],
      "ashlar-bot",
    );
    // Loop poller does a partial match on the first line — must stay byte-identical.
    assert.equal(clean.split("\n")[0], CLEAN_REVIEW_BODY);
    assert.match(clean, /Didn.t find any major issues/);
    assert.match(clean, /Reviewed commit: `abcdef0`/);
    assert.match(clean, /<!-- ashlar-coverage cleared=1\/2 not_cleared=b\.ts -->/);
  });
});
