import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskDeclarations, notAdditionsOnly, outsideDeclarations } from "./boundary-scope.mjs";

const OLD = [
  "import x from 'x';",
  "export async function requestChatFix() {",
  "  return 'chat';",
  "}",
  "/** Routes a fix. */",
  "export function productionRequestFix() {",
  "  if (chat) return requestChatFix();",
  "  return local();",
  "}",
  "",
  "function productionDeps() {",
  "  return {};",
  "}",
  "function loopControl() {}",
].join("\n");
const SCOPE = ["productionRequestFix"];

test("a change inside productionRequestFix (or its JSDoc) is confined", () => {
  const inside = OLD.replace("  return local();", "  const m = await load();\n  return m.local();").replace("Routes a fix.", "Routes a fix (lease).");
  assert.equal(outsideDeclarations(OLD, inside, SCOPE), null);
});

test("the chat fix transport, loop control and new top-level statements stay frozen", () => {
  assert.match(outsideDeclarations(OLD, OLD.replace("'chat'", "'CHAT'"), SCOPE), /edits outside/);
  assert.match(outsideDeclarations(OLD, OLD.replace("function loopControl() {}", "function loopControl() { changed(); }"), SCOPE), /edits outside/);
  assert.match(outsideDeclarations(OLD, `import y from 'y';\n${OLD}`, SCOPE), /edits outside/);
});

test("statements appended on the declaration's closing line are outside it (#142 review)", () => {
  const lines = OLD.split("\n");
  lines[8] = '};\nthrow new Error("outside declaration");';
  assert.match(outsideDeclarations(OLD, lines.join("\n"), SCOPE), /edits outside/);
  lines[8] = "}; changed();";
  assert.match(outsideDeclarations(OLD, lines.join("\n"), SCOPE), /edits outside/);
});

test("a CRLF checkout of an LF base is not an edit outside the scope; real edits still are", () => {
  const crlf = OLD.replace(/\n/g, "\r\n");
  assert.equal(outsideDeclarations(OLD, crlf, SCOPE), null);
  assert.match(outsideDeclarations(OLD, crlf.replace("'chat'", "'CHAT'"), SCOPE), /edits outside/);
});

test("an unparsable or missing declaration fails closed", () => {
  assert.match(outsideDeclarations(OLD, OLD.replace("  return local();", "  return local(;"), SCOPE), /does not parse/);
  assert.match(outsideDeclarations(OLD, OLD.replace("productionRequestFix", "renamed"), SCOPE), /no top-level/);
  assert.match(outsideDeclarations(OLD, `${OLD}\nexport function productionRequestFix() {}`, SCOPE), /2 times/);
  assert.throws(() => maskDeclarations("function (", SCOPE), /does not parse/);
});

test("a NUL byte in a comment does not hide an edit outside the scope (#142 review)", () => {
  const withNul = OLD.replace("import x from 'x';", "/* \u0000 */\nimport x from 'x';");
  assert.match(outsideDeclarations(OLD, withNul.replace("'chat'", "'CHAT'"), SCOPE), /edits outside/);
});

test("notAdditionsOnly accepts inserted lines and flags any removed or changed line", () => {
  assert.equal(notAdditionsOnly("a\nb\nc", "a\nx\nb\ny\nc\nz"), null);
  assert.match(notAdditionsOnly("a\nb\nc", "a\nB\nc"), /line 2/);
  assert.match(notAdditionsOnly("a\nb\nc", "a\nc"), /line 2/);
  assert.match(notAdditionsOnly("a\nb", "b\na"), /line 2/);
  assert.equal(notAdditionsOnly("a\nb", "a\r\nb\r\nc"), null, "CRLF alone is not a change");
});

// End to end: the real checker on a throwaway repository whose scoped runtime file is edited with a
// NUL byte (Git then reports a binary diff with no hunks) — it must still exit non-zero.
test("check-local-llm-boundary rejects a binary-diffed scoped edit outside productionRequestFix", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "boundary-"));
  try {
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const file = join(dir, "src/lib/review-loop-runtime.server.ts");
    writeFileSync(file, OLD);
    const test = join(dir, "src/lib/review-loop-runtime.server.test.ts");
    writeFileSync(test, "a\nb\n");
    g("add", "."); g("commit", "-qm", "base");
    const run = () => spawnSync(process.execPath, [join(here, "check-local-llm-boundary.mjs")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, BOUNDARY_BASE: "main" },
    });
    // Inside the scope, binary or not: accepted.
    writeFileSync(file, OLD.replace("  return local();", "  return local(); /* \u0000 */"));
    assert.match(g("diff", "--stat", "main"), /Bin/);
    let r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // Outside the scope with a NUL byte: rejected.
    writeFileSync(file, OLD.replace("'chat'", "'CHAT'").replace("import x from 'x';", "/* \u0000 */ import x from 'x';"));
    r = run();
    assert.notEqual(r.status, 0, "a binary diff must not pass as confined");
    assert.match(r.stdout + r.stderr, /review-loop-runtime\.server\.ts/);
    // Additions-only test file changed through a binary diff: rejected.
    writeFileSync(file, OLD);
    writeFileSync(test, "a\n\u0000B\n");
    r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /review-loop-runtime\.server\.test\.ts/);
    // #142 review: the index is checked as well as the working tree.
    writeFileSync(test, "a\nb\n");
    writeFileSync(file, OLD.replace("'chat'", "'CHAT'"));
    g("add", "src/lib/review-loop-runtime.server.ts"); // stage a frozen-transport edit...
    writeFileSync(file, OLD.replace("  return local();", "  return local2();")); // ...then restore it in the tree
    r = run();
    assert.notEqual(r.status, 0, "a staged violation is not cleared by a permitted working-tree copy");
    assert.match(r.stdout + r.stderr, /staged version edits outside/);
    writeFileSync(file, OLD); // working tree exactly the base: an index-only violation
    r = run();
    assert.notEqual(r.status, 0, "an index-only violation is still found");
    g("reset", "-q", "--", "src/lib/review-loop-runtime.server.ts");
    r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // A staged symlink whose working-tree replacement is a regular file.
    rmSync(test);
    symlinkSync("elsewhere.ts", test);
    g("add", "src/lib/review-loop-runtime.server.test.ts");
    rmSync(test);
    writeFileSync(test, "a\nb\n");
    r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /staged version is not a regular file \(mode 120000, symbolic link\)/);
    g("reset", "-q", "--", "src/lib/review-loop-runtime.server.test.ts");
    // #142 review: a CRLF checkout of an LF blob with only an appended line is additions-only...
    writeFileSync(test, "a\r\nb\r\nc\r\n");
    r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // ...while changing an existing line is still rejected, CRLF or not.
    writeFileSync(test, "a\r\nB\r\nc\r\n");
    r = run();
    assert.notEqual(r.status, 0);
    // #142 review: a symlink to a byte-identical copy outside the repository replaces the scoped file.
    const outside = mkdtempSync(join(tmpdir(), "boundary-target-"));
    try {
      writeFileSync(join(outside, "copy.ts"), "a\nb\n");
      rmSync(test);
      symlinkSync(join(outside, "copy.ts"), test);
      r = run();
      assert.notEqual(r.status, 0, "a symlinked scoped file must not pass");
      assert.match(r.stdout + r.stderr, /review-loop-runtime\.server\.test\.ts.*symbolic link/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
