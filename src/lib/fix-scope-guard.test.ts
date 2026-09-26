import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFixRound } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";
import { checkFixScope, commentLines, diffLines, FLAG_MARGIN, REFORMAT_MAX_LINES, testBlocks } from "./fix-scope-guard.ts";

// ---------- fixtures modeled on aicc PR #439 (f02ec26c, +155/-1046) ----------

const SMS = "backend/src/modules/sms/sms.service.ts";
const E2E = "backend/test/e2e/sms-retention.e2e-spec.ts";
const RETENTION = "backend/src/modules/sms/retention-reminder.ts";

/** A large service whose methods carry WHY comments (JSDoc blocks and line comments, Korean too). */
function smsService(methods = 60): string {
  const out = ["import { Injectable } from '@nestjs/common';", "", "@Injectable()", "export class SmsService {"];
  for (let i = 0; i < methods; i += 1) {
    out.push(
      "  /**",
      `   * WHY: 발송 ${i} 은 매장 스코프 안에서만 조회한다 — 교차 매장 발송을 막는다.`,
      "   */",
      `  async send${i}(storeId: number, memberId: number) {`,
      `    // WHY: 재시도 ${i} 는 멱등 키로 중복 발송을 막는다`,
      `    const rows = await this.db.query('SELECT id FROM sms_queue WHERE store_id = ? AND member_id = ?', [storeId, memberId, ${i}]);`,
      "    if (rows.length === 0) return null;",
      `    return this.dispatch(rows[0].id, ${i});`,
      "  }",
      "",
    );
  }
  out.push("}", "");
  return out.join("\n");
}

const SMS_HEAD = smsService();
const SMS_LINES = SMS_HEAD.split("\n");
/** The flagged line: send30's query (1-based). */
const FLAGGED_LINE = SMS_LINES.findIndex((l) => l.includes("send30(")) + 3;
const QUERY_30 = SMS_LINES[FLAGGED_LINE - 1];
/** The real fix: one NOT EXISTS clause plus a recovery branch. */
const QUERY_30_FIXED = QUERY_30.replace("AND member_id = ?'", "AND member_id = ? AND NOT EXISTS (SELECT 1 FROM sms_sent s WHERE s.queue_id = sms_queue.id)'");
const RECOVERY = "    if (rows.length === 0) return this.recoverOrphan(storeId, memberId);";

function e2eSpec(): string {
  const block = (id: string) => [`  it('${id}: retention reminder is sent once', async () => {`, `    const res = await request(app).post('/sms/${id}');`, "    expect(res.status).toBe(201);", "  });", ""];
  return ["describe('sms retention (e2e)', () => {", "", ...["R7", "R8", "R8b", "R9", "R10"].flatMap(block), "});", ""].join("\n");
}

function retention(): string {
  const out = ["import { schedule } from './scheduler';", ""];
  for (let i = 0; i < 20; i += 1) out.push(`export const reminder${i} = schedule('retention-${i}', { hour: ${i % 24} });`);
  out.push("");
  return out.join("\n");
}

/** A fake Git Data API recording the committed blobs. */
function gitApi() {
  const blobs: string[] = [];
  let moved = false;
  const api: GitDataApi = {
    baseTreeSha: async () => "base-tree",
    createBlob: async (content) => (blobs.push(content), `blob${blobs.length}`),
    createTree: async () => "tree",
    createCommit: async () => "c".repeat(40),
    updateBranchRef: async () => {
      moved = true;
    },
  };
  return { api, blobs, get moved() { return moved; } };
}

const reply = (edits: Array<{ path: string; search: string; replace: string }>, newFiles: Array<{ path: string; content: string }> = []) =>
  JSON.stringify({ summary: "s", edits, newFiles, dispositions: [{ finding: "F1", action: "fixed", note: "added NOT EXISTS" }] });

async function round(answer: string, heads: Record<string, string>, flagged = [{ path: SMS, line: FLAGGED_LINE }], extraPaths: string[] = []) {
  const git = gitApi();
  const res = await runFixRound(
    { requestFix: async () => answer, api: git.api, validate: async () => ({ ok: true }) },
    {
      prompt: "p",
      mode: "apply",
      branch: "feat",
      baseCommitSha: "b".repeat(40),
      message: "fix",
      allowedPaths: [...Object.keys(heads), ...extraPaths],
      baseFiles: new Map(Object.entries(heads)),
      flagged,
      findingCount: 1,
    },
  );
  return { res, git };
}

describe("scope guard: the aicc #439 incident shapes are rejected before any commit", () => {
  it("a rewrite of a big file that drops its WHY comments is rejected, and the reason names the comment removal", async () => {
    const stripped = SMS_LINES.filter((_, i) => !commentLines(SMS, SMS_LINES)[i])
      .map((l) => (l === QUERY_30 ? QUERY_30_FIXED : l))
      .join("\n");
    const { res, git } = await round(reply([{ path: SMS, search: SMS_HEAD, replace: stripped }]), { [SMS]: SMS_HEAD });
    assert.equal(res.outcome, "validation-failed");
    assert.match(res.error ?? "", /^scope guard: backend\/src\/modules\/sms\/sms\.service\.ts: \d+ comment line\(s\) removed outside the flagged lines \(first at line 6: "\* WHY: 발송 0/);
    assert.match(res.error ?? "", /keep every existing comment/);
    assert.equal(git.blobs.length, 0);
    assert.equal(git.moved, false);
  });

  it("removing an existing regression test (R8b) is rejected", async () => {
    const head = e2eSpec();
    const r8b = head.slice(head.indexOf("  it('R8b"), head.indexOf("  it('R9"));
    const { res, git } = await round(reply([{ path: E2E, search: r8b, replace: "" }]), { [E2E]: head }, [{ path: E2E, line: 1 }]);
    assert.equal(res.outcome, "validation-failed");
    assert.match(res.error ?? "", /1 existing test block\(s\) removed or renamed \(it\("R8b: retention reminder is sent once"\)\); keep every existing test/);
    assert.equal(git.moved, false);
  });

  it("renaming a test block is rejected too", async () => {
    const head = e2eSpec();
    const { res } = await round(reply([{ path: E2E, search: "it('R9: retention", replace: "it('R9 renamed: retention" }]), { [E2E]: head }, []);
    assert.match(res.error ?? "", /test block\(s\) removed or renamed \(it\("R9: retention reminder is sent once"\)\)/);
  });

  it("a reformat (re-quoting and re-indenting lines) is rejected", async () => {
    const head = retention();
    const requoted = head.replace(/'/g, '"').replace(/\{ hour/g, "{hour");
    const { res, git } = await round(reply([{ path: RETENTION, search: head.slice(0, -1), replace: requoted.slice(0, -1) }]), { [RETENTION]: head }, [{ path: SMS, line: 1 }]);
    assert.equal(res.outcome, "validation-failed");
    assert.match(res.error ?? "", new RegExp(`21 line\\(s\\) outside the flagged lines changed only in whitespace or quote style \\(max ${REFORMAT_MAX_LINES};.*never reformat`));
    assert.equal(git.moved, false);
  });

  it("the correct targeted fix commits with the minimal diff", async () => {
    const edits = [
      { path: SMS, search: QUERY_30, replace: QUERY_30_FIXED },
      { path: SMS, search: "    if (rows.length === 0) return null;\n    return this.dispatch(rows[0].id, 30);", replace: `${RECOVERY}\n    return this.dispatch(rows[0].id, 30);` },
    ];
    const { res, git } = await round(reply(edits), { [SMS]: SMS_HEAD });
    assert.equal(res.outcome, "applied", res.error);
    assert.equal(git.blobs.length, 1);
    const d = diffLines(SMS_LINES, git.blobs[0].split("\n"));
    assert.deepEqual([d.deleted.length, d.added.length], [2, 2], "exactly the query line and the empty-rows line change");
    assert.equal(git.blobs[0].length - SMS_HEAD.length, QUERY_30_FIXED.length - QUERY_30.length + RECOVERY.length - "    if (rows.length === 0) return null;".length);
    assert.equal(git.blobs[0].split("\n").filter((l) => l.includes("WHY")).length, SMS_LINES.filter((l) => l.includes("WHY")).length, "every WHY comment kept");
  });

  it("a new file is allowed (nothing to preserve)", async () => {
    const created = "// WHY: new helper\nexport const recover = () => null;\n";
    const { res, git } = await round(reply([{ path: SMS, search: QUERY_30, replace: QUERY_30_FIXED }], [{ path: "backend/src/modules/sms/recover.ts", content: created }]), { [SMS]: SMS_HEAD }, undefined, ["backend/src/modules/sms/recover.ts"]);
    assert.equal(res.outcome, "applied", res.error);
    assert.equal(git.blobs[1], created);
  });

  it("a missing or non-unique search is a precise validation-failed (the runtime retries it with this reason)", async () => {
    const missing = await round(reply([{ path: SMS, search: "SELECT nothing", replace: "x" }]), { [SMS]: SMS_HEAD });
    assert.equal(missing.res.outcome, "validation-failed");
    assert.match(missing.res.error ?? "", /"search" not found in the current file/);
    const dup = await round(reply([{ path: SMS, search: "    if (rows.length === 0) return null;", replace: RECOVERY }]), { [SMS]: SMS_HEAD });
    assert.equal(dup.res.outcome, "validation-failed");
    assert.match(dup.res.error ?? "", /matches more than one place — add surrounding lines until it is unique/);
    assert.equal(dup.git.moved, false);
  });
});

describe("checkFixScope rules", () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);

  it("comments inside the flagged lines (± margin) may be rewritten; a moved comment is not a removal", () => {
    const before = ["// WHY: a", ...code(40), "// WHY: b", ""].join("\n");
    const lines = before.split("\n");
    const nearB = lines.indexOf("// WHY: b") + 1; // 1-based
    const withoutB = lines.filter((l) => l !== "// WHY: b").join("\n");
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: withoutB }], [{ path: "a.ts", line: nearB }]), { ok: true });
    const r = checkFixScope([{ path: "a.ts", before, after: withoutB }], [{ path: "a.ts", line: 1 }]);
    assert.ok(!r.ok && /1 comment line\(s\) removed .* line 42: "\/\/ WHY: b"/.test(r.error));
    const moved = ["// WHY: b", ...lines.filter((l) => l !== "// WHY: b")].join("\n");
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: moved }], []), { ok: true });
  });

  it("detects comments by language: #, <!-- -->, SQL --, and never enters a block from a glob inside a string", () => {
    assert.deepEqual(commentLines("x.py", ["# why", "x = 1", "  # indented"]), [true, false, true]);
    assert.deepEqual(commentLines("x.md", ["<!-- a", "b", "-->", "text"]), [true, true, true, false]);
    assert.deepEqual(commentLines("q.sql", ["-- why", "SELECT 1"]), [true, false]);
    assert.deepEqual(commentLines("a.ts", ['const g = "src/**/*.ts";', "const x = 1;", "/**", " * doc", " */", "x();"]), [false, false, true, true, true, false]);
    assert.deepEqual(commentLines("data.bin", ["// x"]), [false]);
  });

  it("test identities cover it/test/describe and their skip/only/each variants, plus pytest functions", () => {
    const src = "describe.skip('A', () => {});\nit.only(\"B\", f);\ntest.each([1])('C %s', f);\nxit(`D`, f);\n";
    assert.deepEqual(testBlocks("a.test.ts", src), ['describe("A")', 'it("B")', 'test("C %s")', 'it("D")']);
    assert.deepEqual(testBlocks("t.py", "def test_one():\n    pass\nasync def test_two():\n"), ["def test_one", "def test_two"]);
  });

  it("a few whitespace-only lines are tolerated; past the threshold it is a reformat", () => {
    const before = code(40).join("\n");
    const reindent = (n: number) => before.split("\n").map((l, i) => (i < n ? `  ${l}` : l)).join("\n");
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: reindent(REFORMAT_MAX_LINES) }], []), { ok: true });
    const r = checkFixScope([{ path: "a.ts", before, after: reindent(REFORMAT_MAX_LINES + 1) }], []);
    assert.ok(!r.ok && /never reformat/.test(r.error));
    // inside a flagged range (a block wrapped in a new branch) re-indenting is part of the fix
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: reindent(REFORMAT_MAX_LINES + 1) }], [{ path: "a.ts", line: 6 }]), { ok: true });
  });

  it("deletions far beyond additions are rejected unless every deleted line is inside a flagged range", () => {
    const before = code(200).join("\n");
    const lines = before.split("\n");
    const cut = (from: number, n: number) => [...lines.slice(0, from), "const added = 1;", ...lines.slice(from + n)].join("\n");
    const r = checkFixScope([{ path: "a.ts", before, after: cut(100, 30) }], [{ path: "a.ts", line: 10 }]);
    assert.ok(!r.ok && /deletes 30 line\(s\) but adds 1 \(limit 3x added \+ 20/.test(r.error));
    // the same deletion, wholly within FLAG_MARGIN of a finding, is the fix itself
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: cut(100, 2 * FLAG_MARGIN) }], [{ path: "a.ts", line: 101 + FLAG_MARGIN }]), { ok: true });
    assert.deepEqual(checkFixScope([{ path: "a.ts", before, after: cut(100, 20) }], []), { ok: true }, "within the slack");
  });

  it("a new file is never guarded", () => {
    assert.deepEqual(checkFixScope([{ path: "a.ts", after: "x" }], []), { ok: true });
  });

  it("the line diff is minimal and survives a very large rewrite", () => {
    assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "c"]), { deleted: [1], added: [1] });
    const big = Array.from({ length: 6000 }, (_, i) => `l${i}`);
    const other = Array.from({ length: 6000 }, (_, i) => `m${i}`);
    const d = diffLines(big, other);
    assert.deepEqual([d.deleted.length, d.added.length], [6000, 6000]);
  });
});
