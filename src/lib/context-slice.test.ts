import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHunks, sliceContext } from "./context-slice.ts";

const CLASS_SRC = [
  'import { A } from "./a";', // 1
  'import { B } from "./b";', // 2
  "", // 3
  "export class Widget {", // 4
  "  private count = 0;", // 5
  "", // 6
  "  render(): string {", // 7
  '    const s = "a } b";', // 8 string brace
  "    const re = /}{/;", // 9 regex brace
  "    return s + this.count;", // 10
  "  }", // 11
  "", // 12
  "  other(): void {", // 13
  "    this.count += 1;", // 14
  "  }", // 15
  "}", // 16
].join("\n");

describe("parseHunks", () => {
  it("parses +start,len and defaults len to 1", () => {
    assert.deepEqual(parseHunks("@@ -1,2 +3,4 @@\n context"), [{ newStart: 3, newLines: 4 }]);
    assert.deepEqual(parseHunks("@@ -10 +20 @@"), [{ newStart: 20, newLines: 1 }]);
    assert.equal(parseHunks("@@ -1,1 +1,1 @@\n@@ -5,1 +9,3 @@").length, 2);
  });
});

describe("sliceContext boundaries", () => {
  it("captures the enclosing class member without expanding on string/regex braces", () => {
    const out = sliceContext({ path: "w.ts", content: CLASS_SRC, hunks: [{ newStart: 10, newLines: 1 }], padLines: 3, maxChars: 0 });
    const member = out.ranges.find((r) => r.reason.includes("member"));
    assert.ok(member, "member range found");
    assert.deepEqual([member!.start, member!.end], [7, 11]);
    assert.ok(out.text.includes("10| "), "line gutter present");
    assert.ok(out.text.includes('8| ') && out.text.includes("a } b"), "string-brace line kept inside member");
    assert.ok(!out.text.includes("13| "), "unrelated other() method not included");
  });

  it("captures multi-line signatures", () => {
    const src = ["export class M {", "  private foo(", "    a: number,", "  ): number {", "    return a + 1;", "  }", "}"].join("\n");
    const out = sliceContext({ path: "m.ts", content: src, hunks: [{ newStart: 5, newLines: 1 }], padLines: 2, maxChars: 0 });
    const member = out.ranges.find((r) => r.reason.includes("member"));
    assert.equal(member!.start, 2);
  });

  it("falls back to a window for arrow-function class properties", () => {
    const src = ["export class P {", "  handler = (e) => {", "    doStuff(e);", "  };", "}"].join("\n");
    const out = sliceContext({ path: "p.ts", content: src, hunks: [{ newStart: 3, newLines: 1 }], padLines: 2, maxChars: 0 });
    assert.ok(out.ranges.some((r) => r.reason.includes("window")), "window fallback used");
  });

  it("falls back to a window for non-Prettier (4-space) indentation", () => {
    const src = ["export class Q {", "    doThing() {", "        return 1;", "    }", "}"].join("\n");
    const out = sliceContext({ path: "q.ts", content: src, hunks: [{ newStart: 3, newLines: 1 }], padLines: 1, maxChars: 0 });
    assert.ok(out.ranges.some((r) => r.reason.includes("window")));
  });

  it("captures a top-level const object to its closing brace", () => {
    const src = ["export const CONFIG = {", "  a: 1,", "  b: 2,", "};"].join("\n");
    const out = sliceContext({ path: "c.ts", content: src, hunks: [{ newStart: 2, newLines: 1 }], padLines: 1, maxChars: 0 });
    const top = out.ranges.find((r) => r.reason.includes("toplevel"));
    assert.deepEqual([top!.start, top!.end], [1, 4]);
  });

  it("includes the import block and handles a tail hunk", () => {
    const out = sliceContext({ path: "w.ts", content: CLASS_SRC, hunks: [{ newStart: 14, newLines: 1 }], padLines: 2, maxChars: 0 });
    assert.ok(out.ranges.some((r) => r.reason.includes("imports")), "import block present");
    assert.ok(out.text.includes("14| "), "tail hunk line present");
  });

  it("merges overlapping hunk ranges in the same member", () => {
    const out = sliceContext({ path: "w.ts", content: CLASS_SRC, hunks: [{ newStart: 8, newLines: 1 }, { newStart: 10, newLines: 1 }], padLines: 1, maxChars: 0 });
    const members = out.ranges.filter((r) => r.reason.includes("member"));
    assert.equal(members.length, 1);
  });
});

describe("sliceContext budget + modes", () => {
  it("drops the import block (lower priority) before the hunk member", () => {
    const imports = Array.from({ length: 60 }, (_, i) => `import { x${i} } from "./m${i}";`);
    const src = [...imports, "export class Big {", "  run() {", "    return 42;", "  }", "}"].join("\n");
    const hunkLine = imports.length + 3; // the `return 42;` line
    const out = sliceContext({ path: "big.ts", content: src, hunks: [{ newStart: hunkLine, newLines: 1 }], padLines: 1, maxChars: 300 });
    assert.ok(!out.ranges.some((r) => r.reason.includes("imports")), "imports dropped under budget");
    assert.ok(out.ranges.some((r) => r.reason.includes("member")), "member kept under budget");
    assert.ok(out.text.length <= 300);
  });

  it("head mode reproduces a raw head slice", () => {
    const out = sliceContext({ path: "h.ts", content: CLASS_SRC, hunks: [{ newStart: 10, newLines: 1 }], padLines: 2, maxChars: 40, mode: "head" });
    assert.ok(out.text.startsWith("--- h.ts\n"));
    assert.ok(out.text.length <= "--- h.ts\n".length + 40);
  });

  it("never throws on odd input", () => {
    assert.doesNotThrow(() => sliceContext({ path: "x.ts", content: "", hunks: [{ newStart: 5, newLines: 3 }], padLines: 2, maxChars: 0 }));
    assert.doesNotThrow(() => sliceContext({ path: "x.ts", content: "one line no newline", hunks: [{ newStart: 1, newLines: 1 }], padLines: 0, maxChars: 0 }));
  });
});
