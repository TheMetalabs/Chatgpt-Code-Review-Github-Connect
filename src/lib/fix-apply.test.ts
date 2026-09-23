import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFixResponse } from "./fix-apply.ts";

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

  it("rejects a response with no files", () => {
    assert.match(err('{"summary":"nothing","files":[]}'), /no files/);
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

  it("rejects duplicate paths", () => {
    assert.match(err('{"files":[{"path":"a.ts","content":"1"},{"path":"a.ts","content":"2"}]}'), /duplicate/);
  });
});
