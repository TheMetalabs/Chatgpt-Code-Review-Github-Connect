import test from "node:test";
import assert from "node:assert/strict";
import { declarationSpan, hunkRanges, hunksOutside, nonAdditiveHunks } from "./boundary-scope.mjs";

const OLD = [
  "import x from 'x';",                               // 1
  "export async function requestChatFix() {",        // 2
  "  return 'chat';",                                // 3
  "}",                                               // 4
  "export function productionRequestFix() {",        // 5
  "  if (chat) return requestChatFix();",            // 6
  "  return local();",                               // 7
  "}",                                               // 8
  "function loopControl() {}",                       // 9
].join("\n");

test("hunkRanges parses -U0 headers, with and without counts", () => {
  assert.deepEqual(hunkRanges("@@ -7 +7,3 @@ x\n-a\n+b\n@@ -9,0 +12 @@\n+c"), [
    { oldStart: 7, oldCount: 1, newStart: 7, newCount: 3 },
    { oldStart: 9, oldCount: 0, newStart: 12, newCount: 1 },
  ]);
});

test("declarationSpan covers a top-level declaration through its column-0 closing brace", () => {
  assert.deepEqual(declarationSpan(OLD, "export function productionRequestFix("), [5, 8]);
  assert.equal(declarationSpan(OLD, "export function missing("), null);
});

test("a change inside productionRequestFix is confined; a change to requestChatFix or loop control is not", () => {
  const header = "export function productionRequestFix(";
  const inside = OLD.replace("  return local();", "  const m = await load();\n  return m.local();");
  assert.deepEqual(hunksOutside("@@ -7 +7,2 @@", OLD, inside, header), []);
  const chat = OLD.replace("  return 'chat';", "  return 'CHAT';");
  assert.equal(hunksOutside("@@ -3 +3 @@", OLD, chat, header).length, 1, "the chat fix transport is frozen");
  const loop = OLD.replace("function loopControl() {}", "function loopControl() { changed(); }");
  assert.equal(hunksOutside("@@ -9 +9 @@", OLD, loop, header).length, 1, "loop control is frozen");
  const imported = `import y from 'y';\n${OLD}`;
  assert.equal(hunksOutside("@@ -0,0 +1 @@", OLD, imported, header).length, 1, "a new top-level import is outside the scope");
});

test("nonAdditiveHunks flags any removed or changed line", () => {
  assert.deepEqual(nonAdditiveHunks("@@ -4,0 +5,3 @@\n+a\n+b\n+c"), []);
  assert.equal(nonAdditiveHunks("@@ -4 +4 @@\n-a\n+b").length, 1);
});
