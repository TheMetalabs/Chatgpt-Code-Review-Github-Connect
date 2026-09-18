import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBudget, orderFiles, rankChangedFile } from "./review-budget.ts";

describe("rankChangedFile", () => {
  it("classifies code, test, config, doc", () => {
    assert.equal(rankChangedFile("src/a.ts"), 0);
    assert.equal(rankChangedFile("src/a.go"), 0);
    assert.equal(rankChangedFile("src/a.spec.ts"), 1);
    assert.equal(rankChangedFile("src/a.test.tsx"), 1);
    assert.equal(rankChangedFile("__tests__/a.ts"), 1);
    assert.equal(rankChangedFile("pkg/tests/a.ts"), 1);
    assert.equal(rankChangedFile("pkg/test/a.ts"), 1);
    assert.equal(rankChangedFile("a.json"), 2);
    assert.equal(rankChangedFile("a.yaml"), 2);
    assert.equal(rankChangedFile("README.md"), 3);
    assert.equal(rankChangedFile("docs/CHANGELOG"), 3);
  });

  it("treats locales/changelog as doc even as .json", () => {
    assert.equal(rankChangedFile("src/locales/en.json"), 3);
    assert.equal(rankChangedFile("app/CHANGELOG.json"), 3);
  });
});

describe("orderFiles", () => {
  it("orders by rank then path, code before tests before docs", () => {
    const out = orderFiles([{ path: "z.ts" }, { path: "a.md" }, { path: "b.ts" }, { path: "a.spec.ts" }]);
    assert.deepEqual(out.map((f) => f.path), ["b.ts", "z.ts", "a.spec.ts", "a.md"]);
  });
});

describe("applyBudget", () => {
  it("keeps everything when the budget is disabled (<= 0)", () => {
    const items = [{ path: "a.md", size: 999 }, { path: "b.ts", size: 999 }];
    const { kept, dropped } = applyBudget(items, 0);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it("drops lower-priority whole files first", () => {
    const items = [{ path: "doc.md", size: 100 }, { path: "code.ts", size: 100 }];
    const { kept, dropped } = applyBudget(items, 100);
    assert.deepEqual(kept.map((f) => f.path), ["code.ts"]);
    assert.deepEqual(dropped.map((f) => f.path), ["doc.md"]);
  });

  it("never splits a file and honors the exact boundary", () => {
    const items = [{ path: "a.ts", size: 60 }, { path: "b.ts", size: 40 }];
    const { kept, dropped } = applyBudget(items, 100);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it("drops a single file larger than the whole budget (no minimum guarantee)", () => {
    const { kept, dropped } = applyBudget([{ path: "big.ts", size: 200 }], 100);
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped.map((f) => f.path), ["big.ts"]);
  });
});
