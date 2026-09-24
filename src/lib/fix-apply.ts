/**
 * Fix-agent response parsing (design §6 mechanism A: script-apply, LLM-free).
 *
 * The fix provider (chat/local) returns a FULL-FILE schema — path + complete new content
 * per changed file — NOT a diff (diffs apply unreliably). Extraction reuses the review
 * JSON extractor (extract-chat-json), so the same tolerant fence/prose handling applies;
 * the caller falls back (json-repair → another provider → coding agent → ESCALATE) when
 * this returns { ok: false }. Parsing is deterministic; the §7 CI/test gate is what
 * catches a well-formed-but-wrong fix — this only guarantees mechanical fidelity.
 *
 * INVARIANTS (fail-closed): parse returns { ok:false } on ANY anomaly — unparseable JSON,
 * no files, unsafe/traversal/absolute path, a sensitive repo-control path, empty/duplicate/
 * truncated content, or content over the size cap. It never partially accepts.
 * NON-GOALS (owned elsewhere): semantic correctness of the fix (the validate/CI gate, §7);
 * choosing script-apply vs the coding-agent fallback for oversized files (the caller/§6).
 * Per-finding `dispositions` are ADVISORY metadata for the thread replies (design §5 step 6):
 * malformed entries are dropped, never a parse failure — they cannot gate or change a push.
 */
import { lastJsonObject } from "./extract-chat-json.ts";

export interface FixFile {
  path: string;
  content: string; // the COMPLETE new file content (overwrite), never a diff
}

export type DispositionAction = "fixed" | "pushback" | "decline" | "defer";

/** The agent's verdict on one finding (by its prompt ID "F<n>"), for the in-thread reply. */
export interface FixDisposition {
  finding: string;
  action: DispositionAction;
  note: string;
}

export interface FixResponse {
  summary: string;
  files: FixFile[];
  dispositions: FixDisposition[];
}

const DISPOSITION_ACTIONS: readonly DispositionAction[] = ["fixed", "pushback", "decline", "defer"];
const FINDING_ID_RE = /^F[1-9]\d{0,3}$/;
const NOTE_MAX = 1000;

/** Keep well-formed entries only (first per finding); anything else is dropped, not fatal. */
export function parseDispositions(raw: unknown): FixDisposition[] {
  if (!Array.isArray(raw)) return [];
  const out: FixDisposition[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const finding = (e as { finding?: unknown }).finding;
    const action = (e as { action?: unknown }).action;
    const note = (e as { note?: unknown }).note;
    if (typeof finding !== "string" || !FINDING_ID_RE.test(finding) || seen.has(finding)) continue;
    if (typeof action !== "string" || !(DISPOSITION_ACTIONS as readonly string[]).includes(action)) continue;
    seen.add(finding);
    out.push({ finding, action: action as DispositionAction, note: typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "" });
  }
  return out;
}

export type FixParse = { ok: true; fix: FixResponse } | { ok: false; error: string };

function isFixObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { files?: unknown }).files)
  );
}

/** Repository-control paths a fix must NEVER edit, independent of the caller's allowlist
 * (a workflow rewrite = CI takeover). Enforced before any commit. */
const SENSITIVE_PATH_RE = /^\.github\/(workflows|actions)\//i;

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_RE.test(p);
}

/** Reject anything that could escape the repo tree or is obviously not a repo-relative path. */
/** C0 / DEL / C1 controls and the Unicode line/paragraph separators. */
function hasControlChar(p: string): boolean {
  for (let i = 0; i < p.length; i += 1) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** A repository path the fix may write: relative POSIX, no traversal, and no control or line
 * separator characters (a path is also quoted into the fix prompt; it must never break a line). */
export function isSafeFixPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 400) return false;
  if (p.startsWith("/") || p.startsWith("~") || p.startsWith("\\")) return false;
  if (p.includes("\\")) return false; // POSIX repo paths only
  // Reject `..` only as a whole path SEGMENT (traversal), not inside a filename like archive..old.ts
  if (p === ".." || p.split("/").includes("..")) return false;
  if (hasControlChar(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // no Windows drive letters
  return true;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;

// A model that ran out of tokens ends mid-token — truncation shows up on the FINAL line.
// Check only the last non-empty line so a legit mid-file `console.log("Loading...")` or a
// `// remaining work in #42` comment is not a false positive. Cheap heuristic; the validate/
// CI gate is the real net.
const LAST_LINE_TRUNCATION = [/\.\.\.$/, /^\s*\/\/[^\n]*\b(rest|remaining|unchanged|truncated|elided|snip)\b/i, /<truncated>\s*$/i];

function looksTruncated(content: string): boolean {
  const lines = content.replace(/[ \t]+$/gm, "").split("\n").filter((l) => l.trim() !== "");
  const last = lines.length ? lines[lines.length - 1] : "";
  return LAST_LINE_TRUNCATION.some((re) => re.test(last));
}

/**
 * Parse a fix provider's reply into a validated full-file change set, LLM-free. Returns
 * { ok: false, error } on any anomaly (unparseable, no files, unsafe path, empty/truncated
 * content) so the caller can fall back rather than push a bad tree.
 */
/** `findingCount`: the findings the prompt listed (F1..Fn). A no-change response must then give
 * every one of them exactly one pushback / decline / defer disposition. */
export function parseFixResponse(raw: string, opts: { findingCount?: number } = {}): FixParse {
  const json = lastJsonObject(String(raw ?? ""), isFixObject);
  if (!json) return { ok: false, error: "no fix JSON object found (deterministic path; caller may json-repair)" };
  const parsed: unknown = JSON.parse(json); // lastJsonObject only returns a slice that already parsed
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "response is not a JSON object" };
  }
  const filesRaw = (parsed as { files?: unknown }).files;
  if (!Array.isArray(filesRaw)) {
    return { ok: false, error: "no files array in fix response" };
  }
  const summaryRaw = typeof (parsed as { summary?: unknown }).summary === "string" ? (parsed as { summary: string }).summary : "";
  const dispositions = parseDispositions((parsed as { dispositions?: unknown }).dispositions);
  if (filesRaw.length === 0) {
    // A no-change round is valid ONLY when the agent gave a rationale (push-back/decline/defer of
    // every finding); a bare empty response with no summary is malformed → fail closed. Nothing
    // changed, so no finding can be "fixed": a response that says so contradicts itself (retry).
    if (summaryRaw.trim().length === 0) return { ok: false, error: "empty response (no files, no rationale)" };
    const claimed = dispositions.filter((d) => d.action === "fixed").map((d) => d.finding);
    if (claimed.length) return { ok: false, error: `no files changed, yet ${claimed.join(", ")} marked fixed` };
    // Every finding must be classified (a dropped malformed entry counts as missing): an incomplete
    // no-change response is malformed and retried, never a terminal fix-declined handoff.
    // Each classification must carry its reason: it is the thread reply a human reads.
    const given = new Set(dispositions.filter((d) => d.note.trim().length > 0).map((d) => d.finding));
    const missing = Array.from({ length: opts.findingCount ?? 0 }, (_, i) => `F${i + 1}`).filter((id) => !given.has(id));
    if (missing.length) return { ok: false, error: `no-change response has no valid disposition with a note for ${missing.join(", ")}` };
    return { ok: true, fix: { summary: summaryRaw, files: [], dispositions } };
  }
  const seen = new Set<string>();
  const files: FixFile[] = [];
  for (const entry of filesRaw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "file entry is not an object" };
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    if (!isSafeFixPath(path)) return { ok: false, error: `unsafe or missing path: ${JSON.stringify(String(path).slice(0, 80))}` };
    if (isSensitivePath(path)) return { ok: false, error: `sensitive repo-control path: ${path}` };
    if (seen.has(path)) return { ok: false, error: `duplicate path: ${path}` };
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: `empty/non-string content for ${path} (possible truncation)` };
    }
    if (looksTruncated(content)) {
      return { ok: false, error: `content for ${path} looks truncated/elided` };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, error: `content for ${path} exceeds ${MAX_FILE_BYTES} bytes` };
    }
    seen.add(path);
    files.push({ path, content });
  }
  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, error: `change set exceeds ${MAX_TOTAL_BYTES} bytes total` };
  }
  return { ok: true, fix: { summary: summaryRaw, files, dispositions } };
}
