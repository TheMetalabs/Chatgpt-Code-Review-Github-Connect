import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryWrite } from "./write-retry.ts";

const unknown = Object.assign(new Error("GitHub issue comment 502: Bad Gateway"), { outcome: "unknown" });
const rejected = Object.assign(new Error("GitHub issue comment 0: connect ECONNREFUSED"), { outcome: "rejected" });
const noSleep = async () => {};

/** A write whose POSTs fail as scripted; `landedAfter` makes the row visible from that scan on. */
function harness(failures: unknown[], landedAfter = Infinity) {
  let posts = 0;
  let scans = 0;
  return {
    run: (delays = [0, 2_000, 5_000]) =>
      retryWrite({
        delays,
        sleep: noSleep,
        seen: async () => ++scans > landedAfter,
        post: async () => {
          const failure = failures[posts++];
          if (failure) throw failure;
        },
      }),
    posts: () => posts,
  };
}

describe("retryWrite (control writes under the GitHub write contract)", () => {
  it("a rejected write is retried; the retry lands", async () => {
    const h = harness([rejected]);
    assert.deepEqual(await h.run(), { posted: true });
    assert.equal(h.posts(), 2);
  });

  it("an unknown outcome is never sent again: a row that stays invisible is reported ambiguous", async () => {
    const h = harness([unknown]);
    const r = await h.run();
    assert.equal(h.posts(), 1, "one POST only");
    assert.ok("error" in r && r.ambiguous && r.error === unknown);
  });

  it("an unknown outcome whose row shows up later resolves as exists, without another POST", async () => {
    const h = harness([unknown], 1); // the first scan misses (lag), the next one sees it
    assert.deepEqual(await h.run(), { exists: true });
    assert.equal(h.posts(), 1);
  });

  it("a row already there is never posted; scanFirst:false skips only the first scan", async () => {
    const seen = harness([], 0);
    assert.deepEqual(await seen.run(), { exists: true });
    assert.equal(seen.posts(), 0);
    let scans = 0;
    const r = await retryWrite({ delays: [0], sleep: noSleep, scanFirst: false, seen: async () => (scans++, true), post: async () => {} });
    assert.deepEqual(r, { posted: true });
    assert.equal(scans, 0);
  });

  it("an attempt that withdraws the write ends the schedule: nothing more is scanned or sent", async () => {
    let posts = 0;
    let scans = 0;
    const r = await retryWrite<string>({
      delays: [0, 2_000, 5_000],
      sleep: noSleep,
      seen: async () => (scans++, false),
      post: async () => {
        if (++posts === 1) throw rejected;
        return { withdrawn: "newer" };
      },
    });
    assert.deepEqual(r, { withdrawn: "newer" });
    assert.deepEqual([posts, scans], [2, 2], "the refused attempt, then the one that withdrew it");
  });

  it("rejected on every attempt: the last error, not ambiguous", async () => {
    const h = harness([rejected, rejected, rejected]);
    const r = await h.run();
    assert.equal(h.posts(), 3);
    assert.ok("error" in r && !r.ambiguous);
  });
});
