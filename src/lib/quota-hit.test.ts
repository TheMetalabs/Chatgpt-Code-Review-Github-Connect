import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { quotaHitText } from "./quota-hit.ts";

describe("quotaHitText", () => {
  it("ignores upgrade upsell and matches a real cap", () => {
    assert.equal(quotaHitText("Upgrade to ChatGPT Plus. Try again later."), false);
    assert.equal(quotaHitText("You've reached your limit. Limit resets in 3 hours."), true);
    assert.equal(quotaHitText("You're out of credits"), true);
    assert.equal(quotaHitText("You've reached a limit"), true);
    assert.equal(quotaHitText("You've hit your usage limit. Upgrade your plan or try again later."), true);
    assert.equal(quotaHitText("You've reached your weekly limit"), true);
  });

  it("matches the Grok weekly-limit card (Korean)", () => {
    assert.equal(quotaHitText("주간 한도에 도달했습니다"), true);
    assert.equal(
      quotaHitText("주간 한도에 도달했습니다. 9월 17일에 초기화됩니다. 지금 한도를 늘려 계속 이용하세요. 한도 늘리기"),
      true,
    );
  });
});
