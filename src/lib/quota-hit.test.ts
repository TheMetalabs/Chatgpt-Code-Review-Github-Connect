import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { quotaHitText } from "./quota-hit.ts";

describe("quotaHitText", () => {
  it("ignores upgrade upsell and matches a real cap", () => {
    assert.equal(quotaHitText("Upgrade to ChatGPT Plus. Try again later."), false);
    assert.equal(quotaHitText("You've reached your limit. Limit resets in 3 hours."), true);
    assert.equal(quotaHitText("You're out of credits"), true);
    assert.equal(quotaHitText("사용량 한도에 도달했습니다. 한도가 재설정됩니다."), true);
  });
});
