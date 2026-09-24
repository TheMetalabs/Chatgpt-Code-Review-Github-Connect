import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeliveryClaims } from "./loop-control-claims.ts";

describe("loop-control delivery claims", () => {
  it("claims an id once; a released claim can be claimed again (a redelivery retries)", () => {
    const c = createDeliveryClaims();
    assert.equal(c.claim("d1"), true);
    assert.equal(c.claim("d1"), false, "a redelivery of a landed step is skipped");
    assert.equal(c.claim("d2"), true, "distinct deliveries are independent");
    c.release("d1");
    assert.equal(c.claim("d1"), true, "a step that did not land can be retried");
  });

  it("is bounded, dropping the oldest claims first", () => {
    const c = createDeliveryClaims(3);
    for (const id of ["a", "b", "c", "d"]) c.claim(id);
    assert.equal(c.size, 3);
    assert.equal(c.claim("a"), true, "the oldest claim was dropped");
    assert.equal(c.claim("d"), false);
  });
});
