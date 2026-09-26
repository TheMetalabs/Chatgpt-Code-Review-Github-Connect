/**
 * Local escrow of a fix answer the deterministic parser rejected (parse-failed). Live aicc #455
 * (job-muiae0es-23): two chatgpt fix answers ended "no fix JSON object found" and nothing of them
 * was kept, so the harvest or the model could not be told apart. The raw collected answer is now
 * stored locally, bounded, with its full length and SHA-256, so the next failure is diagnosable.
 *
 * INVARIANTS: local only (never posted, never sent anywhere); the stored text is at most
 * FIX_RAW_MAX_BYTES of UTF-8 (the length and hash always describe the WHOLE answer); at most
 * FIX_RAW_KEEP records are kept (oldest removed); a failed write never affects the round.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIX_RAW_MAX_BYTES = 256 * 1024;
export const FIX_RAW_KEEP = 20;
const EDGE_CHARS = 120;

export interface FixRawRecord {
  jobId: string;
  attempt: number;
  at: number;
  error: string;
  /** The whole answer's length (chars) and UTF-8 SHA-256, even when `text` is cut. */
  chars: number;
  sha256: string;
  truncated: boolean;
  head: string;
  tail: string;
  text: string;
}

/** The whole answer's length, hash and its first / last 120 chars (the log line). */
export function fixRawSummary(raw: string): Pick<FixRawRecord, "chars" | "sha256" | "head" | "tail"> {
  const s = String(raw ?? "");
  return { chars: s.length, sha256: createHash("sha256").update(s, "utf8").digest("hex"), head: s.slice(0, EDGE_CHARS), tail: s.length > EDGE_CHARS ? s.slice(-EDGE_CHARS) : "" };
}

/** `text` cut to at most `maxBytes` of UTF-8, never inside a surrogate pair. */
function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let cut = text.slice(0, maxBytes); // every char is at least one byte
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, Math.floor(cut.length * 0.95));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const memory: FixRawRecord[] = [];
/** Records kept in memory when no directory is configured (tests). Newest last. */
export function recentFixRawAnswers(): readonly FixRawRecord[] {
  return memory;
}

/** Where the records go: `<history dir>/fix-raw`, or memory under the test runner. */
export function defaultFixRawDir(): string | null {
  const base = process.env.ASHLAR_HISTORY_DIR || (process.env.NODE_TEST_CONTEXT ? null : ".data/review-history");
  return base ? join(base, "fix-raw") : null;
}

const safeName = (s: string) => s.replace(/[^\w.-]/g, "_").slice(0, 80);

/** Store one rejected answer; returns the record (without throwing) and the file written, if any. */
export function archiveFixRaw(
  dir: string | null,
  input: { jobId: string; attempt: number; raw: string; error: string },
): { record: FixRawRecord; file?: string; writeError?: string } {
  const raw = String(input.raw ?? "");
  const text = capBytes(raw, FIX_RAW_MAX_BYTES);
  const record: FixRawRecord = {
    jobId: input.jobId,
    attempt: input.attempt,
    at: Date.now(),
    error: String(input.error ?? "").slice(0, 500),
    ...fixRawSummary(raw),
    truncated: text.length < raw.length,
    text,
  };
  if (!dir) {
    memory.push(record);
    memory.splice(0, Math.max(0, memory.length - FIX_RAW_KEEP));
    return { record };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${record.at}-${safeName(input.jobId)}-a${input.attempt}.json`);
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    // The names start with the timestamp: a lexical sort is oldest first.
    const all = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - FIX_RAW_KEEP))) rmSync(join(dir, old), { force: true });
    return { record, file };
  } catch (e) {
    return { record, writeError: (e as Error)?.message ?? String(e) };
  }
}
