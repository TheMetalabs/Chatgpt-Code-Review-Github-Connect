import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFixRaw, FIX_RAW_KEEP, FIX_RAW_MAX_BYTES, fixRawSummary } from "./fix-raw-archive.server.ts";

// Live aicc #455 (job-muiae0es-23): two fix answers failed to parse and nothing of them was kept.
describe("archiveFixRaw", () => {
  it("stores a rejected answer on disk with its whole length, hash, head and tail", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fix-raw-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const raw = `prose ${"x".repeat(500)} {"summary":"cut`;
    const { file, record } = archiveFixRaw(dir, { jobId: "job-muiae0es-23", attempt: 2, raw, error: "no fix JSON object found" });
    assert.ok(file && file.startsWith(dir));
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored, record);
    assert.equal(stored.text, raw);
    assert.equal(stored.chars, raw.length);
    assert.equal(stored.sha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(stored.head, raw.slice(0, 120));
    assert.equal(stored.tail, raw.slice(-120));
    assert.equal(stored.truncated, false);
  });

  it("bounds the stored text to 256 KB of UTF-8 while length and hash describe the whole answer", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fix-raw-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const raw = "한".repeat(200_000); // 600 KB of UTF-8
    const { record } = archiveFixRaw(dir, { jobId: "j", attempt: 1, raw, error: "e" });
    assert.ok(Buffer.byteLength(record.text, "utf8") <= FIX_RAW_MAX_BYTES);
    assert.ok(record.text.length > 0 && raw.startsWith(record.text));
    assert.equal(record.truncated, true);
    assert.deepEqual([record.chars, record.sha256], [fixRawSummary(raw).chars, fixRawSummary(raw).sha256]);
  });

  it(`keeps the newest ${FIX_RAW_KEEP} records`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fix-raw-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (let i = 0; i < FIX_RAW_KEEP + 3; i += 1) archiveFixRaw(dir, { jobId: `job-${String(i).padStart(2, "0")}`, attempt: 1, raw: "r", error: "e" });
    const names = readdirSync(dir);
    assert.equal(names.length, FIX_RAW_KEEP);
    assert.ok(names.some((n) => n.includes(`job-${FIX_RAW_KEEP + 2}`)), "the newest is kept");
  });

  it("a write failure is reported, never thrown", () => {
    const r = archiveFixRaw("/dev/null/not-a-dir", { jobId: "j", attempt: 1, raw: "r", error: "e" });
    assert.ok(r.writeError);
    assert.equal(r.file, undefined);
  });
});
