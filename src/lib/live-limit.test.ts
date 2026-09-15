import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_COOLDOWN_MS,
  LIVE_HOUR_CAP,
  LIVE_HOUR_MS,
  createLiveLimiter,
  liveAdmit,
  liveRelease,
} from "./live-limit.ts";

describe("liveAdmit", () => {
  it("blocks a second call until cooldown measured from release", () => {
    const lim = createLiveLimiter();
    const t0 = 1_000_000;
    assert.equal(liveAdmit(t0, lim).ok, true);
    liveRelease(t0 + 20_000, lim);
    const immediate = liveAdmit(t0 + 20_000 + 1, lim);
    assert.equal(immediate.ok, false);
    if (!immediate.ok) assert.match(immediate.error, /cooling down/);
    assert.equal(liveAdmit(t0 + 20_000 + LIVE_COOLDOWN_MS, lim).ok, true);
  });

  it("blocks a second in-flight call", () => {
    const lim = createLiveLimiter();
    assert.equal(liveAdmit(0, lim).ok, true);
    const second = liveAdmit(1, lim);
    assert.equal(second.ok, false);
    if (!second.ok) assert.match(second.error, /already running/);
  });

  it("rejects the 21st admit inside one hour", () => {
    const lim = createLiveLimiter();
    let now = 10_000;
    for (let i = 0; i < LIVE_HOUR_CAP; i++) {
      const g = liveAdmit(now, lim);
      assert.equal(g.ok, true, `admit ${i}`);
      liveRelease(now + 1, lim);
      now += LIVE_COOLDOWN_MS + 1;
    }
    const over = liveAdmit(now, lim);
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.error, /hourly cap/);
  });

  it("resets the hourly window after LIVE_HOUR_MS", () => {
    const lim = createLiveLimiter();
    const t0 = 50_000;
    assert.equal(liveAdmit(t0, lim).ok, true);
    lim.hourCount = LIVE_HOUR_CAP;
    liveRelease(t0 + 1, lim);
    const blocked = liveAdmit(t0 + LIVE_COOLDOWN_MS + 1, lim);
    assert.equal(blocked.ok, false);
    assert.equal(liveAdmit(t0 + LIVE_HOUR_MS, lim).ok, true);
  });
});
