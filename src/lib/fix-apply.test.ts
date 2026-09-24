import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeFixPath, parseDispositions, parseFixResponse } from "./fix-apply.ts";

const ok = (raw: string) => {
  const r = parseFixResponse(raw);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.fix : (undefined as never);
};
const err = (raw: string) => {
  const r = parseFixResponse(raw);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.error;
};

describe("parseFixResponse", () => {
  it("parses a full-file change set (bare JSON)", () => {
    const fix = ok('{"summary":"fix null deref","files":[{"path":"src/a.ts","content":"export const a = 1;\\n"}]}');
    assert.equal(fix.summary, "fix null deref");
    assert.deepEqual(fix.files, [{ path: "src/a.ts", content: "export const a = 1;\n" }]);
  });

  it("extracts JSON from a fenced chat reply (reuses the review extractor)", () => {
    const raw = "Sure, here is the fix:\n```json\n{\"files\":[{\"path\":\"x.ts\",\"content\":\"y\"}]}\n```\nDone.";
    const fix = ok(raw);
    assert.deepEqual(fix.files, [{ path: "x.ts", content: "y" }]);
  });

  it("rejects an unparseable reply (caller falls back)", () => {
    assert.match(err("not json at all"), /no fix JSON object|unparseable|empty/);
  });

  it("accepts a no-change round (files:[] WITH a rationale) but rejects a bare empty response (J3)", () => {
    const fix = ok('{"summary":"all findings are false positives; pushed back","files":[]}');
    assert.deepEqual(fix.files, []);
    assert.match(err('{"summary":"","files":[]}'), /no rationale/);
    assert.match(err('{"files":[]}'), /no rationale/);
  });

  it("a no-change round must classify EVERY listed finding (missing or malformed entries are retried)", () => {
    const parse = (dispositions: string) => parseFixResponse(`{"summary":"nothing to change","files":[],"dispositions":${dispositions}}`, { findingCount: 2 });
    const errOf = (r: ReturnType<typeof parse>) => (r.ok ? "" : r.error);
    assert.match(errOf(parse("[]")), /no valid disposition with a note for F1, F2/);
    assert.match(errOf(parse('[{"finding":"F1","action":"pushback","note":"n"}]')), /no valid disposition with a note for F2$/);
    assert.match(errOf(parse('[{"finding":"F1","action":"pushback","note":"n"},{"finding":"F2","action":"bogus"}]')), /no valid disposition with a note for F2$/);
    for (const note of ['', '"note":"",', '"note":"   ",']) {
      const noReason = `[{"finding":"F1","action":"pushback","note":"n"},{${note}"finding":"F2","action":"decline"}]`;
      assert.match(errOf(parse(noReason)), /with a note for F2$/, `F2 without a reason (${note || "no note"})`);
    }
    const full = parse('[{"finding":"F1","action":"pushback","note":"n"},{"finding":"F2","action":"defer","note":"#88"}]');
    assert.ok(full.ok && full.fix.dispositions.length === 2);
    // without a count (a caller that lists no findings) only the summary + no-"fixed" rules apply
    assert.equal(parseFixResponse('{"summary":"s","files":[]}').ok, true);
  });

  it("rejects a no-change round that marks a finding fixed (nothing changed, so nothing was fixed)", () => {
    const fixedNoFiles = '{"summary":"done","files":[],"dispositions":[{"finding":"F1","action":"fixed","note":"done"},{"finding":"F2","action":"pushback","note":"n"}]}';
    assert.match(err(fixedNoFiles), /no files changed, yet F1 marked fixed/);
    const declined = ok('{"summary":"false positive","files":[],"dispositions":[{"finding":"F1","action":"pushback","note":"n"}]}');
    assert.deepEqual(declined.files, []);
  });

  it("rejects a sensitive repo-control path at the parser boundary (J6)", () => {
    assert.match(err('{"files":[{"path":".github/workflows/ci.yml","content":"x"}]}'), /sensitive/);
    assert.match(err('{"files":[{"path":".github/actions/x/action.yml","content":"x"}]}'), /sensitive/);
  });

  it("rejects unsafe paths (traversal, absolute, drive, backslash)", () => {
    for (const p of ["../etc/passwd", "/abs/x.ts", "C:/win.ts", "a\\\\b.ts", "~/x"]) {
      assert.match(err(`{"files":[{"path":"${p}","content":"x"}]}`), /unsafe or missing path/, p);
    }
  });

  it("rejects empty content (likely truncation)", () => {
    assert.match(err('{"files":[{"path":"a.ts","content":""}]}'), /empty|truncation/);
  });

  it("rejects content that looks elided/truncated", () => {
    assert.match(err('{"files":[{"path":"a.ts","content":"const x = 1;\\n// ... rest unchanged"}]}'), /truncated|elided/);
    assert.match(err('{"files":[{"path":"a.ts","content":"line\\n..."}]}'), /truncated|elided/);
  });

  it("H7: allows consecutive dots in a filename but still rejects traversal segments", () => {
    ok('{"files":[{"path":"src/archive..old.ts","content":"x"}]}');
    assert.match(err('{"files":[{"path":"../../etc/passwd","content":"x"}]}'), /unsafe or missing path/);
    assert.match(err('{"files":[{"path":"src/../secret","content":"x"}]}'), /unsafe or missing path/);
  });

  it("H8: does not flag a legit trailing '...' string or a mid-file elision comment", () => {
    ok('{"files":[{"path":"a.ts","content":"console.log(\\"Loading...\\")\\n"}]}');
    ok('{"files":[{"path":"a.ts","content":"// remaining work in #42\\nexport const x = 1;\\n"}]}');
    // a genuine trailing truncation is still caught
    assert.match(err('{"files":[{"path":"a.ts","content":"const y = 1;\\n// ... rest unchanged"}]}'), /truncated|elided/);
  });

  it("rejects content over the per-file size cap (bounded resource use)", () => {
    const huge = "x".repeat(1_000_001);
    assert.match(err(JSON.stringify({ files: [{ path: "a.ts", content: huge }] })), /exceeds .* bytes/);
  });

  it("rejects duplicate paths", () => {
    assert.match(err('{"files":[{"path":"a.ts","content":"1"},{"path":"a.ts","content":"2"}]}'), /duplicate/);
  });
});

describe("isSafeFixPath", () => {
  it("accepts relative POSIX repo paths", () => {
    for (const ok of ["src/a.ts", "a.b..c/x.ts", "docs/archive..old.md", "ünïcode/ファイル.ts"]) assert.equal(isSafeFixPath(ok), true, ok);
  });

  it("rejects traversal, absolute, Windows and every control or line-separator character", () => {
    const bad = ["", "/etc/passwd", "~/x", "a/../b", "..", "a\\b", "C:/x", "a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"];
    for (const p of bad) assert.equal(isSafeFixPath(p), false, JSON.stringify(p));
    assert.equal(isSafeFixPath(undefined), false);
    assert.equal(isSafeFixPath("x".repeat(401)), false);
  });
});

describe("dispositions (advisory per-finding verdicts for the thread replies)", () => {
  it("are parsed alongside files and on a no-change round", () => {
    const withFiles = parseFixResponse(
      '{"summary":"s","files":[{"path":"a.ts","content":"x"}],"dispositions":[{"finding":"F1","action":"fixed","note":"  guarded  "}]}',
    );
    assert.ok(withFiles.ok);
    if (withFiles.ok) assert.deepEqual(withFiles.fix.dispositions, [{ finding: "F1", action: "fixed", note: "guarded" }]);
    const none = parseFixResponse('{"summary":"all false positives","files":[],"dispositions":[{"finding":"F2","action":"pushback","note":"n"}]}');
    assert.ok(none.ok);
    if (none.ok) assert.equal(none.fix.dispositions[0].action, "pushback");
  });

  it("malformed entries are DROPPED, never a parse failure (they cannot gate a push)", () => {
    assert.deepEqual(parseDispositions("nope"), []);
    assert.deepEqual(
      parseDispositions([
        { finding: "F1", action: "fixed", note: "ok" },
        { finding: "F1", action: "decline", note: "dup (first wins)" },
        { finding: "f2", action: "fixed" }, // bad id
        { finding: "F0", action: "fixed" }, // bad id
        { finding: "F3", action: "rewrite" }, // unknown action
        { finding: "F4", action: "defer" }, // note missing → ""
        null,
      ]),
      [
        { finding: "F1", action: "fixed", note: "ok" },
        { finding: "F4", action: "defer", note: "" },
      ],
    );
    const r = parseFixResponse('{"summary":"s","files":[{"path":"a.ts","content":"x"}],"dispositions":"garbage"}');
    assert.ok(r.ok, "a garbage dispositions field does not fail the parse");
    if (r.ok) assert.deepEqual(r.fix.dispositions, []);
  });

  it("notes are capped", () => {
    const [d] = parseDispositions([{ finding: "F1", action: "fixed", note: "x".repeat(5000) }]);
    assert.equal(d.note.length, 1000);
  });
});
