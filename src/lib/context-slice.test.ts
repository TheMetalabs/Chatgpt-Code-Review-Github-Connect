import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crossFileDefs, parseHunks, sliceContext } from "./context-slice.ts";

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

describe("sliceContext 1-hop and scale", () => {
  it("includes same-file definitions of helpers the added lines call", () => {
    const src = ["export class S {", "  run() {", "    return this.helper();", "  }", "", "  helper(): number {", "    return 1;", "  }", "}"].join("\n");
    const patch = "@@ -2,2 +2,3 @@\n   run() {\n+    return this.helper();\n   }";
    const out = sliceContext({ path: "s.ts", content: src, hunks: parseHunks(patch), padLines: 1, maxChars: 0, patch });
    assert.ok(out.ranges.some((r) => r.reason.includes("def:helper")), "helper definition pulled in");
    assert.ok(out.text.includes("6| ") && out.text.includes("helper(): number"));
  });

  it("does not pull cross-file (undefined-in-file) callees", () => {
    const src = ["export function run() {", "  return externalThing();", "}"].join("\n");
    const patch = "@@ -1,2 +1,3 @@\n export function run() {\n+  return externalThing();\n }";
    const out = sliceContext({ path: "s.ts", content: src, hunks: parseHunks(patch), padLines: 1, maxChars: 0, patch });
    assert.ok(!out.ranges.some((r) => r.reason.includes("def:externalThing")));
  });

  it("includes readers of an added property", () => {
    const src = ["export interface Doc {", "  title: string;", "}", "", "export function render(d: Doc) {", "  return d.title.trim();", "}"].join("\n");
    const patch = "@@ -1,2 +1,3 @@\n export interface Doc {\n+  title: string;\n }";
    const out = sliceContext({ path: "d.ts", content: src, hunks: parseHunks(patch), padLines: 1, maxChars: 0, patch });
    assert.ok(out.ranges.some((r) => r.reason.includes("reader:title")), "reader of .title pulled in");
    assert.ok(out.text.includes("d.title"));
  });

  it("on a 300KB+ file, captures the tail hunk's function and not the head", () => {
    const N = 8000;
    const methods: string[] = [];
    for (let i = 0; i < N; i += 1) methods.push(`  m${i}(): number {`, `    return ${i};`, "  }");
    const bigLines = ["export class Big {", ...methods, "}"];
    const bigSrc = bigLines.join("\n");
    assert.ok(bigSrc.length > 300_000, `synthetic file is ${bigSrc.length} bytes`);
    const hunkLine = bigLines.lastIndexOf(`    return ${N - 1};`) + 1;
    const out = sliceContext({ path: "big.ts", content: bigSrc, hunks: [{ newStart: hunkLine, newLines: 1 }], padLines: 2, maxChars: 0 });
    assert.ok(out.text.includes(`m${N - 1}(`), "last method captured");
    assert.ok(!out.text.includes("m0("), "first method NOT included (proves hunk-anchored, not head slice)");
  });
});

describe("crossFileDefs", () => {
  const changed = [{
    path: "src/pay.ts",
    content: ["import { addCalendarMonths } from './date';", "export function issue() {", "  const e = addCalendarMonths(start, 12);", "  return e;", "}"].join("\n"),
    patch: "--- src/pay.ts\n@@ -1,2 +1,3 @@\n function issue() {\n+  const e = addCalendarMonths(start, 12);\n   return e;",
  }];
  const dateUtil = {
    path: "src/date.ts",
    content: ["export function addCalendarMonths(ymd, months) {", "  return ymd; // clamps to last day", "}", "export function unrelatedHelper() {", "  return 0;", "}"].join("\n"),
  };

  it("pulls the definition of a cross-file helper the changed hunk calls", () => {
    const out = crossFileDefs(changed, [dateUtil], 10_000);
    assert.match(out, /addCalendarMonths/);
    assert.match(out, /src\/date\.ts/);
    assert.match(out, /clamps to last day/); // the body came through, not just the signature
  });

  it("does not pull definitions the change never references", () => {
    assert.doesNotMatch(crossFileDefs(changed, [dateUtil], 10_000), /unrelatedHelper/);
  });

  it("returns empty with no changed files or no budget", () => {
    assert.equal(crossFileDefs([], [dateUtil], 10_000), "");
    assert.equal(crossFileDefs(changed, [dateUtil], 0), "");
  });

  it("pulls a constructed imported class definition (new X resolves class X)", () => {
    // Regression: crossFileDefs collected `new Membership` but findDefinitionLine could not find a
    // top-level `export class Membership`, so the entity definition was silently omitted.
    const changedNew = [{
      path: "src/pay.ts",
      content: ["import { Membership } from './membership';", "function issue() {", "  return new Membership(1);", "}"].join("\n"),
      patch: "--- src/pay.ts\n@@ -1,2 +1,3 @@\n function issue() {\n+  return new Membership(1);\n }",
    }];
    const entity = {
      path: "src/membership.ts",
      content: ["export class Membership {", "  isUsableOn(d) {", "    return d <= this.expiresAt; // inclusive", "  }", "}"].join("\n"),
    };
    const out = crossFileDefs(changedNew, [entity], 10_000);
    assert.match(out, /class Membership/);
    assert.match(out, /isUsableOn/);
    assert.match(out, /inclusive/); // the class body came through, so its semantics are visible
  });

  it("resolves an aliased import to the exported declaration name", () => {
    // `import { addCalendarMonths as addMonths }` — the hunk calls addMonths, the module declares
    // addCalendarMonths; the lookup must follow the alias.
    const changedAlias = [{
      path: "src/pay.ts",
      content: ["import { addCalendarMonths as addMonths } from './date';", "function issue() {", "  return addMonths(1);", "}"].join("\n"),
      patch: "--- src/pay.ts\n@@ -1,2 +1,3 @@\n function issue() {\n+  return addMonths(1);\n }",
    }];
    assert.match(crossFileDefs(changedAlias, [dateUtil], 10_000), /addCalendarMonths/);
  });

  it("finds a helper defined in ANOTHER changed file, skipping the origin file", () => {
    // A calls a helper from changed file B (not a referenceFile); B's def sits outside its own hunk.
    // crossFileDefs must search changed files too, and skip A's own defs (already in the snapshot).
    const two = [
      {
        path: "src/a.ts",
        content: ["import { sharedHelper } from './b';", "function run() {", "  return sharedHelper();", "}"].join("\n"),
        patch: "--- src/a.ts\n@@ -1,2 +1,3 @@\n function run() {\n+  return sharedHelper();\n }",
      },
      {
        path: "src/b.ts",
        content: ["export function sharedHelper() {", "  return 42; // cross-changed contract", "}"].join("\n"),
        patch: "--- src/b.ts\n@@ -9,1 +9,1 @@\n unrelated line",
      },
    ];
    const out = crossFileDefs(two, [], 10_000);
    assert.match(out, /sharedHelper/);
    assert.match(out, /cross-changed contract/);
  });

  it("resolves a default import to the module's default export", () => {
    const changedDef = [{
      path: "src/pay.ts",
      content: ["import makeId from './id';", "function issue() {", "  return makeId();", "}"].join("\n"),
      patch: "--- src/pay.ts\n@@ -1,2 +1,3 @@\n function issue() {\n+  return makeId();\n }",
    }];
    const idMod = { path: "src/id.ts", content: ["export default function newTransferId() {", "  return 'x'; // default export body", "}"].join("\n") };
    assert.match(crossFileDefs(changedDef, [idMod], 10_000), /default export body/);
  });

  it("looks a name up only in its imported module, not every module exporting that name", () => {
    // Precision: two modules export `format`; only the imported one's definition is attached.
    const changedSpec = [{
      path: "src/pay.ts",
      content: ["import { format } from './money';", "function issue() {", "  return format(1);", "}"].join("\n"),
      patch: "--- src/pay.ts\n@@ -1,2 +1,3 @@\n function issue() {\n+  return format(1);\n }",
    }];
    const money = { path: "src/money.ts", content: ["export function format(n) {", "  return `won ${n}`; // money format", "}"].join("\n") };
    const dates = { path: "src/dates.ts", content: ["export function format(d) {", "  return `date ${d}`; // date format", "}"].join("\n") };
    const out = crossFileDefs(changedSpec, [money, dates], 10_000);
    assert.match(out, /money format/);
    assert.doesNotMatch(out, /date format/); // unrelated same-named export not attached
  });
});
