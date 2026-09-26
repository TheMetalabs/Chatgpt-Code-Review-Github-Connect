/**
 * Fix-agent response parsing (design §6 mechanism A: script-apply, LLM-free).
 *
 * The fix provider (chat/local) returns TARGETED EDITS — per change, the path, an exact snippet of
 * the current file (`search`, unique in that file) and its replacement — plus full content only for
 * NEW files. It never returns an existing file whole: a whole-file rewrite of a 2,754-line file
 * dropped every WHY comment on aicc PR #439 (f02ec26c, +155/-1046) for a one-clause fix. The edits
 * are applied here, server-side, against the head-pinned content (applyFixEdits). Extraction reuses
 * the review JSON extractor (extract-chat-json); the caller falls back (json-repair → another
 * provider → coding agent → ESCALATE) when this returns { ok: false }. Parsing is deterministic; the
 * scope guard (fix-scope-guard) and the §7 CI/test gate catch a well-formed-but-wrong fix.
 *
 * INVARIANTS (fail-closed): parse returns { ok:false } on ANY anomaly — unparseable JSON, a legacy
 * full-file `files` entry, unsafe/traversal/absolute path, a sensitive repo-control path, an empty
 * search or a no-op edit, empty/duplicate/truncated new-file content, or content over the size cap.
 * applyFixEdits returns { ok:false } when a search snippet is missing or not unique, when edits
 * overlap, when an edit targets a file absent at the head or a new file already exists. Neither
 * ever partially accepts.
 * NON-GOALS (owned elsewhere): semantic correctness of the fix (the validate/CI gate, §7);
 * choosing script-apply vs the coding-agent fallback for oversized files (the caller/§6).
 * Per-finding `dispositions` are ADVISORY metadata for the thread replies (design §5 step 6):
 * malformed entries are dropped, never a parse failure — they cannot gate or change a push.
 */
import { lastJsonObject } from "./extract-chat-json.ts";
import { escapeStrayQuotes } from "./review-json-repair.ts";
import { FIX_ATTACHMENT_MISMATCH_REPLY } from "./fix-attachment.ts";

/** The one reply the GitHub-source prompt asks for when the model cannot read the repository at that
 * commit (fix-source-github.ts re-exports it). */
export const CONNECTOR_UNAVAILABLE_REPLY = "CONNECTOR_UNAVAILABLE";

/** The first line of a chat fix answer the page delivered WITHOUT a fenced block (extension/json.js
 * boundAnswerText, live aicc #439): the mark, one JSON object of flags, then the answer's visible
 * text (bounded to 256 KB). The flags say what the answer held besides text. */
export const FIX_UNFENCED_MARK = "<<<ASHLAR_UNFENCED_ANSWER>>>";

export interface FixAnswerShape {
  unfenced: boolean;
  /** Links or controls to a file (sandbox:/files links, a download attribute, a Download button). */
  fileLinks: number;
  /** A ChatGPT canvas in the answer. */
  canvas: boolean;
  /** Inline Markdown formatting outside code (the rendered text may differ from what was written). */
  formatted: number;
  truncated: boolean;
}

/** The answer text without the page's unfenced mark line, and that line's flags (a fenced or
 * non-chat answer has none). */
export function fixAnswerParts(raw: string): { body: string; shape?: FixAnswerShape } {
  const text = String(raw ?? "");
  const m = /^<<<ASHLAR_UNFENCED_ANSWER>>> (\{[^\n]*\})(?:\n|$)/.exec(text);
  if (!m) return { body: text };
  let flags: Record<string, unknown> = {};
  try {
    flags = JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    /* an unreadable flag line still marks the answer unfenced */
  }
  const count = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const shape = { unfenced: true, fileLinks: count(flags.fileLinks), canvas: flags.canvas === true, formatted: count(flags.formatted), truncated: flags.truncated === true };
  return { body: text.slice(m[0].length), shape };
}

/** Fixed error codes of a fix reply that is not a fix JSON object but says what it is. */
export const ATTACHMENT_MISMATCH = "attachment_mismatch";
export const ANSWER_AS_FILE = "answer_as_file";
export type FixReplySignal = typeof ATTACHMENT_MISMATCH | "connector_unavailable" | typeof ANSWER_AS_FILE;

/** What a reply with no usable fix JSON said instead: exactly ATTACHMENT_MISMATCH or
 * CONNECTOR_UNAVAILABLE (the replies the prompts ask for; quotes, backticks and a final period
 * aside), or the answer as a file (a download link, a file card or a canvas) with no fix JSON in
 * the chat. undefined otherwise. */
export function fixReplySignal(raw: string): FixReplySignal | undefined {
  const { body, shape } = fixAnswerParts(raw);
  const bare = body.replace(/[\s`*"'.]/g, "");
  if (bare === FIX_ATTACHMENT_MISMATCH_REPLY) return ATTACHMENT_MISMATCH;
  if (bare === CONNECTOR_UNAVAILABLE_REPLY) return "connector_unavailable";
  if (findFixJson(body)) return undefined;
  if ((shape && (shape.fileLinks > 0 || shape.canvas)) || /\bsandbox:\/|\/mnt\/data\//.test(body)) return ANSWER_AS_FILE;
  return undefined;
}

/** The line the chat page puts between two fenced code blocks of one fix answer (extension/json.js
 * boundAnswerText): the reply's blocks joined back in order are one more candidate for the JSON. */
export const FIX_BLOCK_BREAK = "<<<ASHLAR_CODE_BLOCK_BREAK>>>";

/** The bodies of the ```fenced blocks in `text`, in order (a local or raw reply that kept its fences). */
function fencedBodies(text: string): string[] {
  return [...text.matchAll(/^[ \t]*```[^\n`]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$/gm)].map((m) => m[1]);
}

/** The texts the fix JSON is looked for in, in order: the reply as it is, then its blocks joined
 * back (the page's FIX_BLOCK_BREAK, or ``` fences in the raw text) with nothing and with a newline
 * (live aicc #455: a long fix answer never parsed; one JSON split over two blocks is one cause). */
function fixJsonCandidates(raw: string): string[] {
  const out = [raw];
  const join = (parts: string[]) => {
    if (parts.length > 1) out.push(parts.join(""), parts.join("\n"));
  };
  if (raw.includes(FIX_BLOCK_BREAK)) join(raw.split(FIX_BLOCK_BREAK).map((p) => p.replace(/^\n/, "").replace(/\n$/, "")));
  join(fencedBodies(raw.split(FIX_BLOCK_BREAK).join("\n")));
  return out;
}

/** The deterministic JSON repair the review path already uses (review-json-repair
 * escapeStrayQuotes: a `\\"` whose quote lost its escape), applied to the fix object's span. */
function repairedFixJson(text: string): string | null {
  const start = text.search(/\{\s*"(?:summary|edits|newFiles|dispositions|canary)"\s*:/);
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  const fixed = escapeStrayQuotes(text.slice(start, end + 1));
  return fixed ? lastJsonObject(fixed, isFixObject) : null;
}

/** ChatGPT's citation marker (live aicc #455 job-muikyyt7-185): the model wrote
 * `:chatgpt-content-reference{index="0"}` inside a JSON string of its fenced answer, and the marker's
 * bare quotes broke the JSON. It cites the attachment and is never part of a fix. */
const CITATION_MARKER = /[ \t]*:chatgpt-content-reference\{[^{}\n]*\}/g;

/** How a reply's fix JSON was found: as written, once the chat's citation markers were removed,
 * by the stray-quote repair, or not at all. */
export type FixJsonVia = "plain" | "cleaned" | "repaired" | "none";

function locateFixJson(raw: string): { json: string | null; via: FixJsonVia } {
  const candidates = fixJsonCandidates(fixAnswerParts(raw).body);
  for (const c of candidates) {
    const json = lastJsonObject(c, isFixObject);
    if (json) return { json, via: "plain" };
  }
  // Only a reply that did not parse as written is cleaned: a valid one keeps every byte.
  const cleaned = candidates.filter((c) => c.search(CITATION_MARKER) >= 0).map((c) => c.replace(CITATION_MARKER, ""));
  for (const c of cleaned) {
    const json = lastJsonObject(c, isFixObject);
    if (json) return { json, via: "cleaned" };
  }
  for (const c of [...candidates, ...cleaned]) {
    const json = repairedFixJson(c);
    if (json) return { json, via: "repaired" };
  }
  return { json: null, via: "none" };
}

/** The fix JSON object of a reply, wherever it sits: prose around it, split over blocks, with the
 * chat's citation markers in it, or with a stray-quote slip the review repair also fixes. null when
 * none of these yields one. */
export function findFixJson(raw: string): string | null {
  return locateFixJson(raw).json;
}

/** One fix answer's shape for the log, never its content: how the page delivered it (code blocks
 * or unfenced text), its size, what the chat did to it (Markdown formatting, file links, a canvas,
 * citation markers) and how its JSON was found. Each parse failure today had a different cause
 * (no block, a block without <pre>, rendered Markdown, a citation marker); this line tells them apart. */
export function fixAnswerDiagnosis(raw: string): Record<string, string | number | boolean> {
  const text = String(raw ?? "");
  const { body, shape } = fixAnswerParts(text);
  return {
    mode: shape ? "unfenced" : "blocks",
    blocks: shape ? 0 : body.split(FIX_BLOCK_BREAK).length,
    chars: body.length,
    formatted: shape?.formatted ?? 0,
    fileLinks: shape?.fileLinks ?? 0,
    canvas: shape?.canvas ?? false,
    truncated: shape?.truncated ?? false,
    citations: (body.match(CITATION_MARKER) ?? []).length,
    json: locateFixJson(text).via,
  };
}

export interface FixFile {
  path: string;
  content: string; // the COMPLETE file content to commit (a new file, or an existing one after its edits)
}

/** One targeted edit: replace the ONE occurrence of `search` in the head content of `path`. */
export interface FixEdit {
  path: string;
  search: string;
  replace: string;
  /** GitHub-source fixes only (fix-source-github.ts): the git blob SHA of the file the model read
   * and edited. The server checks it against the head tree before any commit (stale read = reject). */
  baseBlobSha?: string;
}

/** GitHub-source fixes only: the connector check the model echoes (the blob it read for the canary). */
export interface FixCanary {
  path: string;
  blobSha: string;
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
  /** Targeted edits of existing files, in reply order. */
  edits: FixEdit[];
  /** Full content of files that do not exist at the head. */
  newFiles: FixFile[];
  dispositions: FixDisposition[];
  /** Present only when the reply carries a well-formed `canary` echo (GitHub-source fixes). */
  canary?: FixCanary;
}

const BLOB_SHA_RE = /^[0-9a-f]{40}$/i;

function canaryOf(raw: unknown): FixCanary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { path, blobSha } = raw as { path?: unknown; blobSha?: unknown };
  if (typeof path !== "string" || typeof blobSha !== "string" || !BLOB_SHA_RE.test(blobSha)) return undefined;
  return { path, blobSha: blobSha.toLowerCase() };
}

/** The canary echo of a reply's fix JSON object, read even when the rest of the object would not
 * parse as a fix (a truncated file still proves the connector read the canary). */
export function fixReplyCanary(raw: string): FixCanary | undefined {
  const json = findFixJson(String(raw ?? ""));
  return json ? canaryOf((JSON.parse(json) as { canary?: unknown }).canary) : undefined;
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

// Load-bearing evidence for a decline/defer (fix recipe 5): an issue number, a file:line, or a
// quoted code reference (backticks or quotes, 3+ chars). A bare "later"/"out of scope" is not.
const EVIDENCE_RE = /#\d+|[\w./-]+\.\w+:\d+|`[^`\n]{3,}`|"[^"\n]{3,}"|\u201c[^\u201d\n]{3,}\u201d/;

export function citesEvidence(note: string): boolean {
  return EVIDENCE_RE.test(note);
}

export type FixParse = { ok: true; fix: FixResponse } | { ok: false; error: string };

function isFixObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["edits", "newFiles", "files"].some((k) => Array.isArray((value as Record<string, unknown>)[k]))
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

/** Why a path cannot be written, or null. */
function pathProblem(path: unknown): string | null {
  if (!isSafeFixPath(path)) return `unsafe or missing path: ${JSON.stringify(String(path).slice(0, 80))}`;
  if (isSensitivePath(path)) return `sensitive repo-control path: ${path}`;
  return null;
}

function parseEdits(raw: unknown[]): { ok: true; edits: FixEdit[] } | { ok: false; error: string } {
  const edits: FixEdit[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") return { ok: false, error: `edit #${i + 1} is not an object` };
    const { path, search, replace, baseBlobSha } = entry as Record<string, unknown>;
    const bad = pathProblem(path);
    if (bad) return { ok: false, error: `edit #${i + 1}: ${bad}` };
    const p = path as string;
    if (typeof search !== "string" || search.length === 0) return { ok: false, error: `edit #${i + 1} (${p}): empty or missing "search" — quote the exact current lines to replace` };
    if (typeof replace !== "string") return { ok: false, error: `edit #${i + 1} (${p}): missing "replace" (use "" to delete the lines)` };
    if (search === replace) return { ok: false, error: `edit #${i + 1} (${p}): "replace" equals "search" (the edit changes nothing)` };
    if (Buffer.byteLength(search, "utf8") > MAX_FILE_BYTES || Buffer.byteLength(replace, "utf8") > MAX_FILE_BYTES) {
      return { ok: false, error: `edit #${i + 1} (${p}) exceeds ${MAX_FILE_BYTES} bytes` };
    }
    if (baseBlobSha !== undefined && (typeof baseBlobSha !== "string" || !BLOB_SHA_RE.test(baseBlobSha))) {
      return { ok: false, error: `baseBlobSha for ${p} is not a 40-hex git blob SHA` };
    }
    edits.push({ path: p, search, replace, ...(typeof baseBlobSha === "string" ? { baseBlobSha: baseBlobSha.toLowerCase() } : {}) });
  }
  return { ok: true, edits };
}

function parseNewFiles(raw: unknown[]): { ok: true; files: FixFile[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const files: FixFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "newFiles entry is not an object" };
    const { path, content } = entry as Record<string, unknown>;
    const bad = pathProblem(path);
    if (bad) return { ok: false, error: bad };
    const p = path as string;
    if (seen.has(p)) return { ok: false, error: `duplicate path: ${p}` };
    if (typeof content !== "string" || content.length === 0) return { ok: false, error: `empty/non-string content for ${p} (possible truncation)` };
    if (looksTruncated(content)) return { ok: false, error: `content for ${p} looks truncated/elided` };
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return { ok: false, error: `content for ${p} exceeds ${MAX_FILE_BYTES} bytes` };
    seen.add(p);
    files.push({ path: p, content });
  }
  return { ok: true, files };
}

/**
 * Parse a fix provider's reply into validated edits + new files, LLM-free. Returns
 * { ok: false, error } on any anomaly so the caller can retry or fall back rather than push a bad tree.
 */
/** `findingCount`: the findings the prompt listed (F1..Fn). A no-change response must then give
 * every one of them exactly one pushback / decline / defer disposition. */
export function parseFixResponse(raw: string, opts: { findingCount?: number } = {}): FixParse {
  const json = findFixJson(String(raw ?? ""));
  if (!json) return { ok: false, error: "no fix JSON object found (deterministic path; caller may json-repair)" };
  const shape = fixAnswerParts(raw).shape;
  const parsed: unknown = JSON.parse(json); // lastJsonObject only returns a slice that already parsed
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "response is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  // The retired full-file schema: an existing file must never come back whole (it is how a fix
  // silently drops comments, tests and formatting). An empty legacy array is just "no change".
  if (Array.isArray(obj.files) && obj.files.length > 0) {
    return { ok: false, error: 'full-file "files" output is not accepted: change existing files with "edits" (search/replace) and put only files that do not exist yet in "newFiles"' };
  }
  const editsRaw = obj.edits === undefined ? [] : obj.edits;
  const newRaw = obj.newFiles === undefined ? [] : obj.newFiles;
  if (!Array.isArray(editsRaw)) return { ok: false, error: '"edits" is not an array' };
  if (!Array.isArray(newRaw)) return { ok: false, error: '"newFiles" is not an array' };
  const summaryRaw = typeof obj.summary === "string" ? obj.summary : "";
  const dispositions = parseDispositions(obj.dispositions);
  const canary = canaryOf(obj.canary);
  const extra = canary ? { canary } : {};
  if (editsRaw.length === 0 && newRaw.length === 0) {
    // A no-change round is valid ONLY when the agent gave a rationale (push-back/decline/defer of
    // every finding); a bare empty response with no summary is malformed → fail closed. Nothing
    // changed, so no finding can be "fixed": a response that says so contradicts itself (retry).
    if (summaryRaw.trim().length === 0) return { ok: false, error: "empty response (no edits, no rationale)" };
    const claimed = dispositions.filter((d) => d.action === "fixed").map((d) => d.finding);
    if (claimed.length) return { ok: false, error: `no files changed, yet ${claimed.join(", ")} marked fixed` };
    // Every finding must be classified (a dropped malformed entry counts as missing): an incomplete
    // no-change response is malformed and retried, never a terminal fix-declined handoff.
    // Each classification must carry its reason: it is the thread reply a human reads.
    const given = new Set(dispositions.filter((d) => d.note.trim().length > 0).map((d) => d.finding));
    const missing = Array.from({ length: opts.findingCount ?? 0 }, (_, i) => `F${i + 1}`).filter((id) => !given.has(id));
    if (missing.length) return { ok: false, error: `no-change response has no valid disposition with a note for ${missing.join(", ")}` };
    // A decline/defer that cites nothing is re-flagged next round; on a no-change round it is the
    // whole answer, so it is malformed (retried) rather than a terminal fix-declined handoff.
    const bare = dispositions.filter((d) => (d.action === "decline" || d.action === "defer") && !citesEvidence(d.note)).map((d) => d.finding);
    if (bare.length) return { ok: false, error: `decline/defer without evidence (issue #, file:line or quote) for ${bare.join(", ")}` };
    return { ok: true, fix: { summary: summaryRaw, edits: [], newFiles: [], dispositions, ...extra } };
  }
  // An unfenced answer was read from rendered Markdown: inline formatting there means the text may
  // no longer be what the model wrote (emphasis markers dropped), so its edits are never applied.
  if (shape?.formatted) {
    return { ok: false, error: `unfenced_rewritten: the fix JSON was not in a code block and the chat rendered it as Markdown (${shape.formatted} formatted spans), so its edits cannot be trusted; put the JSON object in one \`\`\`json block` };
  }
  const edits = parseEdits(editsRaw);
  if (!edits.ok) return edits;
  const newFiles = parseNewFiles(newRaw);
  if (!newFiles.ok) return newFiles;
  const both = newFiles.files.map((f) => f.path).filter((p) => edits.edits.some((e) => e.path === p));
  if (both.length) return { ok: false, error: `path both edited and created: ${both.join(", ")}` };
  const totalBytes =
    newFiles.files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0) + edits.edits.reduce((n, e) => n + Buffer.byteLength(e.replace, "utf8"), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return { ok: false, error: `change set exceeds ${MAX_TOTAL_BYTES} bytes total` };
  }
  return { ok: true, fix: { summary: summaryRaw, edits: edits.edits, newFiles: newFiles.files, dispositions, ...extra } };
}

/** The start index of every occurrence of `needle` in `hay` (overlapping ones too), up to `cap`. */
function occurrences(hay: string, needle: string, cap: number): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && at.length < cap; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

export type FixMaterialized =
  | { ok: true; files: FixFile[]; before: ReadonlyMap<string, string> }
  | { ok: false; error: string };

/**
 * Apply parsed edits to the head-pinned contents (`base`: path → head content), deterministically.
 * Every search is located in the ORIGINAL head content and must occur exactly once; edits of one
 * file must not overlap. The result is the full content of every changed file (for the commit) and
 * the head content it came from (for the scope guard). New files must not exist at the head.
 */
export function applyFixEdits(fix: Pick<FixResponse, "edits" | "newFiles">, base: ReadonlyMap<string, string>): FixMaterialized {
  const byPath = new Map<string, FixEdit[]>();
  for (const e of fix.edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  const files: FixFile[] = [];
  const before = new Map<string, string>();
  for (const [path, edits] of byPath) {
    const head = base.get(path);
    if (head === undefined) return { ok: false, error: `edit for ${path}: the file does not exist at the head; a new file goes in "newFiles"` };
    const spans: Array<{ from: number; to: number; replace: string; n: number }> = [];
    for (const [i, e] of edits.entries()) {
      const at = occurrences(head, e.search, 2);
      const which = `edit #${i + 1} for ${path}`;
      if (at.length === 0) return { ok: false, error: `${which}: "search" not found in the current file — copy the lines exactly (whitespace included) from the current content: ${JSON.stringify(e.search.slice(0, 120))}` };
      if (at.length > 1) return { ok: false, error: `${which}: "search" matches more than one place — add surrounding lines until it is unique: ${JSON.stringify(e.search.slice(0, 120))}` };
      spans.push({ from: at[0], to: at[0] + e.search.length, replace: e.replace, n: i + 1 });
    }
    spans.sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i].from < spans[i - 1].to) return { ok: false, error: `edits #${spans[i - 1].n} and #${spans[i].n} for ${path} overlap — merge them into one edit` };
    }
    let out = "";
    let cursor = 0;
    for (const s of spans) {
      out += head.slice(cursor, s.from) + s.replace;
      cursor = s.to;
    }
    out += head.slice(cursor);
    if (Buffer.byteLength(out, "utf8") > MAX_FILE_BYTES) return { ok: false, error: `content for ${path} exceeds ${MAX_FILE_BYTES} bytes after the edits` };
    files.push({ path, content: out });
    before.set(path, head);
  }
  for (const f of fix.newFiles) {
    if (base.has(f.path)) return { ok: false, error: `newFiles entry ${f.path} already exists at the head; change it with "edits"` };
    files.push(f);
  }
  return { ok: true, files, before };
}
