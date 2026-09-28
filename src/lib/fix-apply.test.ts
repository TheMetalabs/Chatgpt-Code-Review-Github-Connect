import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyFixEdits, FIX_BLOCK_BREAK, FIX_UNFENCED_MARK, fixAnswerDiagnosis, fixAnswerParts, fixReplyCanary, fixReplySignal, isSafeFixPath, parseDispositions, parseFixResponse } from "./fix-apply.ts";

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
  // Live aicc #455 (job-muiae0es-23): a long chatgpt fix answer ended "no fix JSON object found"
  // twice. The JSON is found wherever the reply puts it, never only as one intact object.
  const FIX = { summary: "guard the refund", edits: [{ path: "src/a.ts", search: "const a = 1;", replace: "const a = 2;" }], dispositions: [{ finding: "F1", action: "fixed", note: "guarded" }] };
  const pretty = JSON.stringify(FIX, null, 2);

  it("parses a fix JSON split across two code blocks (the page's block break), cut between tokens or inside a string", () => {
    const betweenTokens = pretty.indexOf('"dispositions"');
    const insideString = pretty.indexOf("refund") + 3;
    for (const cut of [betweenTokens, insideString]) {
      const raw = `${pretty.slice(0, cut)}\n${FIX_BLOCK_BREAK}\n${pretty.slice(cut)}`;
      assert.deepEqual(ok(raw).edits, FIX.edits, `cut at ${cut}`);
    }
  });

  it("parses a fix JSON split across two ``` fenced blocks with prose between them", () => {
    const cut = pretty.indexOf('"dispositions"');
    const raw = `Here is the fix:\n\`\`\`json\n${pretty.slice(0, cut)}\n\`\`\`\nand the rest:\n\`\`\`json\n${pretty.slice(cut)}\n\`\`\`\nDone.`;
    assert.equal(ok(raw).summary, FIX.summary);
  });

  it("parses prose around a fenced fix block", () => {
    const raw = `I re-audited the file {see below}.\n\n\`\`\`json\n${pretty}\n\`\`\`\n\nThe test covers the {edge} case.`;
    assert.deepEqual(ok(raw).dispositions, FIX.dispositions);
  });

  it("repairs the review path's stray-quote slip in a fix answer (escapeStrayQuotes)", () => {
    const slipped = '{"summary":"s","edits":[{"path":"src/a.ts","search":"const a = 1;","replace":"const re = \\\\"x\\\\";"}]}';
    assert.throws(() => JSON.parse(slipped), "the answer itself is not JSON");
    assert.equal(ok(slipped).edits[0].replace, 'const re = \\"x\\";');
    assert.equal(fixReplyCanary(slipped), undefined);
  });

  it("still fails closed when no candidate holds a fix object", () => {
    assert.match(err(`prose only\n${FIX_BLOCK_BREAK}\n{"summary":"no edits key"}`), /no fix JSON object found/);
  });

  it("parses targeted edits and new files (bare JSON)", () => {
    const fix = ok('{"summary":"fix null deref","edits":[{"path":"src/a.ts","search":"const a = 1;","replace":"const a = 2;"}],"newFiles":[{"path":"src/b.ts","content":"export const b = 1;\\n"}]}');
    assert.equal(fix.summary, "fix null deref");
    assert.deepEqual(fix.edits, [{ path: "src/a.ts", search: "const a = 1;", replace: "const a = 2;" }]);
    assert.deepEqual(fix.newFiles, [{ path: "src/b.ts", content: "export const b = 1;\n" }]);
  });

  it("rejects the retired full-file schema: an existing file never comes back whole (aicc #439)", () => {
    assert.match(err('{"summary":"s","files":[{"path":"src/a.ts","content":"export const a = 2;\\n"}]}'), /full-file "files" output is not accepted/);
    // an empty legacy array is still a plain no-change answer
    assert.equal(parseFixResponse('{"summary":"all pushed back","files":[]}').ok, true);
  });

  it("rejects a malformed edit: empty search, missing replace, a no-op, a bad path or a bad baseBlobSha", () => {
    const edit = (e: Record<string, unknown>) => err(JSON.stringify({ summary: "s", edits: [{ path: "a.ts", search: "x", replace: "y", ...e }] }));
    assert.match(edit({ search: "" }), /empty or missing "search"/);
    assert.match(edit({ replace: undefined }), /missing "replace"/);
    assert.match(edit({ replace: "x" }), /changes nothing/);
    assert.match(edit({ path: "../x.ts" }), /unsafe or missing path/);
    assert.match(edit({ path: ".github/workflows/ci.yml" }), /sensitive/);
    assert.match(edit({ baseBlobSha: "nope" }), /baseBlobSha/);
    assert.match(err(JSON.stringify({ summary: "s", edits: [{ path: "a.ts", search: "x", replace: "y" }], newFiles: [{ path: "a.ts", content: "z" }] })), /both edited and created/);
  });

  it("extracts JSON from a fenced chat reply (reuses the review extractor)", () => {
    const raw = "Sure, here is the fix:\n```json\n{\"newFiles\":[{\"path\":\"x.ts\",\"content\":\"y\"}]}\n```\nDone.";
    const fix = ok(raw);
    assert.deepEqual(fix.newFiles, [{ path: "x.ts", content: "y" }]);
  });

  it("rejects an unparseable reply (caller falls back)", () => {
    assert.match(err("not json at all"), /no fix JSON object|unparseable|empty/);
  });

  it("accepts a no-change round (files:[] WITH a rationale) but rejects a bare empty response (J3)", () => {
    const fix = ok('{"summary":"all findings are false positives; pushed back","files":[]}');
    assert.deepEqual(fix.newFiles, []);
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

  it("a no-change decline/defer must cite evidence: issue #, file:line or a quote (fix recipe 5)", () => {
    const parse = (note: string, action = "decline") => parseFixResponse(`{"summary":"nothing to change","files":[],"dispositions":[{"finding":"F1","action":"pushback","note":"n"},{"finding":"F2","action":"${action}","note":${JSON.stringify(note)}}]}`, { findingCount: 2 });
    for (const bare of ["out of scope", "will do later", "by design", "see ##", "``", "a.ts:"]) {
      for (const action of ["decline", "defer"]) {
        const r = parse(bare, action);
        assert.ok(!r.ok && /decline\/defer without evidence .* for F2$/.test(r.error), `${action} ${JSON.stringify(bare)}`);
      }
    }
    for (const cited of ["tracked in #88", "guard at src/a.ts:12", "contract mandates `FIXED_LITERAL`", 'spec says "fixed literal"', "per \u201cfixed literal\u201d"]) {
      assert.equal(parse(cited, "defer").ok, true, cited);
      assert.equal(parse(cited, "decline").ok, true, cited);
    }
    // pushback is rule 1's rebuttal, not a decline/defer: a plain reason still stands
    assert.equal(parseFixResponse('{"summary":"s","files":[],"dispositions":[{"finding":"F1","action":"pushback","note":"false positive"}]}', { findingCount: 1 }).ok, true);
  });

  it("rejects a no-change round that marks a finding fixed (nothing changed, so nothing was fixed)", () => {
    const fixedNoFiles = '{"summary":"done","files":[],"dispositions":[{"finding":"F1","action":"fixed","note":"done"},{"finding":"F2","action":"pushback","note":"n"}]}';
    assert.match(err(fixedNoFiles), /no files changed, yet F1 marked fixed/);
    const declined = ok('{"summary":"false positive","files":[],"dispositions":[{"finding":"F1","action":"pushback","note":"n"}]}');
    assert.deepEqual(declined.newFiles, []);
  });

  it("rejects a sensitive repo-control path at the parser boundary (J6)", () => {
    assert.match(err('{"newFiles":[{"path":".github/workflows/ci.yml","content":"x"}]}'), /sensitive/);
    assert.match(err('{"newFiles":[{"path":".github/actions/x/action.yml","content":"x"}]}'), /sensitive/);
  });

  it("rejects unsafe paths (traversal, absolute, drive, backslash)", () => {
    for (const p of ["../etc/passwd", "/abs/x.ts", "C:/win.ts", "a\\\\b.ts", "~/x"]) {
      assert.match(err(`{"newFiles":[{"path":"${p}","content":"x"}]}`), /unsafe or missing path/, p);
    }
  });

  it("rejects empty content (likely truncation)", () => {
    assert.match(err('{"newFiles":[{"path":"a.ts","content":""}]}'), /empty|truncation/);
  });

  it("rejects content that looks elided/truncated", () => {
    assert.match(err('{"newFiles":[{"path":"a.ts","content":"const x = 1;\\n// ... rest unchanged"}]}'), /truncated|elided/);
    assert.match(err('{"newFiles":[{"path":"a.ts","content":"line\\n..."}]}'), /truncated|elided/);
  });

  it("H7: allows consecutive dots in a filename but still rejects traversal segments", () => {
    ok('{"newFiles":[{"path":"src/archive..old.ts","content":"x"}]}');
    assert.match(err('{"newFiles":[{"path":"../../etc/passwd","content":"x"}]}'), /unsafe or missing path/);
    assert.match(err('{"newFiles":[{"path":"src/../secret","content":"x"}]}'), /unsafe or missing path/);
  });

  it("H8: does not flag a legit trailing '...' string or a mid-file elision comment", () => {
    ok('{"newFiles":[{"path":"a.ts","content":"console.log(\\"Loading...\\")\\n"}]}');
    ok('{"newFiles":[{"path":"a.ts","content":"// remaining work in #42\\nexport const x = 1;\\n"}]}');
    // a genuine trailing truncation is still caught
    assert.match(err('{"newFiles":[{"path":"a.ts","content":"const y = 1;\\n// ... rest unchanged"}]}'), /truncated|elided/);
  });

  it("rejects content over the per-file size cap (bounded resource use)", () => {
    const huge = "x".repeat(1_000_001);
    assert.match(err(JSON.stringify({ newFiles: [{ path: "a.ts", content: huge }] })), /exceeds .* bytes/);
  });

  it("rejects duplicate paths", () => {
    assert.match(err('{"newFiles":[{"path":"a.ts","content":"1"},{"path":"a.ts","content":"2"}]}'), /duplicate/);
  });
});

describe("applyFixEdits (server-side, against the head content)", () => {
  const head = new Map([["src/a.ts", "const a = 1;\nconst b = 1;\nconst b2 = 1;\n"]]);
  const apply = (edits: Array<{ search: string; replace: string }>, newFiles: Array<{ path: string; content: string }> = []) =>
    applyFixEdits({ edits: edits.map((e) => ({ path: "src/a.ts", ...e })), newFiles }, head);

  it("replaces each unique snippet and keeps every other byte", () => {
    const r = apply([{ search: "const a = 1;", replace: "const a = 2;" }, { search: "const b2 = 1;", replace: "" }]);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.files, [{ path: "src/a.ts", content: "const a = 2;\nconst b = 1;\n\n" }]);
      assert.equal(r.before.get("src/a.ts"), head.get("src/a.ts"));
    }
  });

  it("rejects a missing or non-unique search, and overlapping edits, with a reason the model can act on", () => {
    const e = (r: ReturnType<typeof apply>) => (r.ok ? "" : r.error);
    assert.match(e(apply([{ search: "const c = 1;", replace: "x" }])), /"search" not found in the current file/);
    assert.match(e(apply([{ search: "const b", replace: "x" }])), /matches more than one place/);
    assert.match(e(apply([{ search: "const a = 1;\nconst b", replace: "x" }, { search: "b = 1;\nconst b2", replace: "y" }])), /overlap/);
  });

  it("an edit needs an existing file; a new file must not exist", () => {
    const r1 = applyFixEdits({ edits: [{ path: "src/new.ts", search: "a", replace: "b" }], newFiles: [] }, head);
    assert.ok(!r1.ok && /does not exist at the head/.test(r1.error));
    const r2 = apply([], [{ path: "src/a.ts", content: "x" }]);
    assert.ok(!r2.ok && /already exists at the head/.test(r2.error));
    const r3 = apply([], [{ path: "src/new.ts", content: "export const n = 1;\n" }]);
    assert.ok(r3.ok && r3.files[0].path === "src/new.ts" && !r3.before.has("src/new.ts"));
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
      '{"summary":"s","newFiles":[{"path":"a.ts","content":"x"}],"dispositions":[{"finding":"F1","action":"fixed","note":"  guarded  "}]}',
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
    const r = parseFixResponse('{"summary":"s","newFiles":[{"path":"a.ts","content":"x"}],"dispositions":"garbage"}');
    assert.ok(r.ok, "a garbage dispositions field does not fail the parse");
    if (r.ok) assert.deepEqual(r.fix.dispositions, []);
  });

  it("notes are capped", () => {
    const [d] = parseDispositions([{ finding: "F1", action: "fixed", note: "x".repeat(5000) }]);
    assert.equal(d.note.length, 1000);
  });
});

// Live aicc #439 (job-muigs9hp-171, extension 1.1.49): three chatgpt fix answers had no fenced code
// block, the page delivered a placeholder and the server parse-failed twice on it. The page now
// delivers the visible text under FIX_UNFENCED_MARK and its flags (extension/json.js boundAnswerText).
describe("unfenced chat fix answers (#439)", () => {
  const unfenced = (text: string, flags: Record<string, unknown> = {}) =>
    `${FIX_UNFENCED_MARK} ${JSON.stringify({ unfenced: true, fileLinks: 0, canvas: false, formatted: 0, truncated: false, ...flags })}\n${text}`;
  const FIX = '{"summary":"guard","edits":[{"path":"src/a.ts","search":"const a = 1;","replace":"const a = 2;"}],"dispositions":[{"finding":"F1","action":"fixed","note":"guarded"}]}';

  it("an unfenced JSON answer is parsed (prose around it, the mark line stripped)", () => {
    const r = parseFixResponse(unfenced(`I verified the SHA-256.\n\n${FIX}\n\nDone.`));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.deepEqual(r.ok && r.fix.edits.map((e) => e.replace), ["const a = 2;"]);
    assert.deepEqual(fixAnswerParts(unfenced("x")), { body: "x", shape: { unfenced: true, fileLinks: 0, canvas: false, formatted: 0, truncated: false } });
    assert.deepEqual(fixAnswerParts(FIX), { body: FIX }, "a fenced harvest has no mark");
  });

  it("an unfenced answer whose text the chat rendered as Markdown is never applied (retried)", () => {
    const r = parseFixResponse(unfenced(FIX, { formatted: 2 }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /^unfenced_rewritten: .*```json block/);
  });

  it("exactly ATTACHMENT_MISMATCH or CONNECTOR_UNAVAILABLE says what it is; a mention in prose does not", () => {
    for (const raw of ["ATTACHMENT_MISMATCH", unfenced("ATTACHMENT_MISMATCH"), unfenced("`ATTACHMENT_MISMATCH`."), "ATTACHMENT_MISMATCH\n"]) {
      assert.equal(fixReplySignal(raw), "attachment_mismatch", raw);
    }
    assert.equal(fixReplySignal(unfenced("CONNECTOR_UNAVAILABLE")), "connector_unavailable");
    assert.equal(fixReplySignal(unfenced("The SHA-256 matches, so no ATTACHMENT_MISMATCH. Working on it.")), undefined);
    assert.equal(fixReplySignal("sorry, I cannot"), undefined);
  });

  it("an answer given as a file, a download link or a canvas with no JSON in the chat is answer_as_file", () => {
    assert.equal(fixReplySignal(unfenced("Here is the fix file: ashlar-fix.json", { fileLinks: 1 })), "answer_as_file");
    assert.equal(fixReplySignal(unfenced("I wrote the fix in the canvas.", { canvas: true })), "answer_as_file");
    assert.equal(fixReplySignal("Download it: sandbox:/mnt/data/fix.json"), "answer_as_file");
    assert.equal(fixReplySignal(unfenced(`${FIX} (also as a file)`, { fileLinks: 1 })), undefined, "a JSON in the chat is parsed, not a file");
  });
});

// Live aicc #455 (job-muikyyt7-185, extension 1.1.51): the fenced answer was harvested whole
// (blocks=1), but the model wrote ChatGPT's citation marker inside the summary string; its bare
// quotes broke the JSON and both attempts parse-failed "no fix JSON object found".
describe("chat citation markers in a fix answer (#455)", () => {
  const edit = { path: "src/a.ts", search: "const a = 1;", replace: "const a = 2;" };
  const cited = `{\n  "summary": "Guarded the refund path. :chatgpt-content-reference{index="0"}",\n  "edits": ${JSON.stringify([edit])},\n  "dispositions": [{"finding":"F1","action":"fixed","note":"guarded :chatgpt-content-reference{index="1"}"}]\n}`;

  it("a JSON broken only by citation markers parses once they are removed", () => {
    const r = parseFixResponse(cited, { findingCount: 1 });
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal(r.fix.summary, "Guarded the refund path.");
    assert.deepEqual(r.fix.edits, [edit]);
    assert.equal(r.fix.dispositions[0].note, "guarded");
  });

  it("a valid JSON keeps every byte, a marker inside a string included", () => {
    const valid = JSON.stringify({ summary: 's :chatgpt-content-reference{index="0"}', edits: [edit], dispositions: [{ finding: "F1", action: "fixed", note: "n" }] });
    const r = parseFixResponse(valid, { findingCount: 1 });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.fix.summary, 's :chatgpt-content-reference{index="0"}');
  });

  it("the answer's shape is logged without its content, and names how the JSON was found", () => {
    const d = fixAnswerDiagnosis(cited);
    assert.deepEqual(d, { mode: "blocks", blocks: 1, chars: cited.length, formatted: 0, fileLinks: 0, canvas: false, truncated: false, citations: 2, json: "cleaned" });
    assert.equal(fixAnswerDiagnosis(`{"a":1}${"\n" + FIX_BLOCK_BREAK + "\n"}{"b":2}`).blocks, 2);
    assert.equal(fixAnswerDiagnosis(JSON.stringify({ summary: "s", edits: [edit] })).json, "plain");
    assert.equal(fixAnswerDiagnosis("no json here").json, "none");
    const unfenced = fixAnswerDiagnosis(`${FIX_UNFENCED_MARK} {"unfenced":true,"fileLinks":1,"canvas":false,"formatted":3,"truncated":false}\nprose`);
    assert.deepEqual([unfenced.mode, unfenced.blocks, unfenced.formatted, unfenced.fileLinks, unfenced.chars], ["unfenced", 0, 3, 1, 5]);
  });
});
