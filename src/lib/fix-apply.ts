/**
 * Fix-agent response parsing (design §6 mechanism A: script-apply, LLM-free).
 *
 * The fix provider (chat/local) returns a FULL-FILE schema — path + complete new content
 * per changed file — NOT a diff (diffs apply unreliably). Extraction reuses the review
 * JSON extractor (extract-chat-json), so the same tolerant fence/prose handling applies;
 * the caller falls back (json-repair → another provider → coding agent → ESCALATE) when
 * this returns { ok: false }. Parsing is deterministic; the §7 CI/test gate is what
 * catches a well-formed-but-wrong fix — this only guarantees mechanical fidelity.
 */
import { lastJsonObject } from "./extract-chat-json.ts";

export interface FixFile {
  path: string;
  content: string; // the COMPLETE new file content (overwrite), never a diff
}

export interface FixResponse {
  summary: string;
  files: FixFile[];
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

/** Reject anything that could escape the repo tree or is obviously not a repo-relative path. */
function isSafeRepoPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 400) return false;
  if (p.startsWith("/") || p.startsWith("~") || p.startsWith("\\")) return false;
  if (p.includes("\\")) return false; // POSIX repo paths only
  if (p.includes("..")) return false; // no parent traversal
  if (p.includes("\0") || /[\n\r]/.test(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // no Windows drive letters
  return true;
}

// A model that ran out of tokens often ends mid-token; these are cheap, deterministic
// truncation smells. They cannot catch every truncation — the CI/test gate is the real net.
const TRUNCATION_MARKERS = [/\.\.\.$/, /\/\/[^\n]*\b(rest|remaining|unchanged|truncated|elided|snip)\b/i, /<truncated>/i, /\/\*\s*\.\.\./];

/**
 * Parse a fix provider's reply into a validated full-file change set, LLM-free. Returns
 * { ok: false, error } on any anomaly (unparseable, no files, unsafe path, empty/truncated
 * content) so the caller can fall back rather than push a bad tree.
 */
export function parseFixResponse(raw: string): FixParse {
  const json = lastJsonObject(String(raw ?? ""), isFixObject);
  if (!json) return { ok: false, error: "no fix JSON object found (deterministic path; caller may json-repair)" };
  const parsed: unknown = JSON.parse(json); // lastJsonObject only returns a slice that already parsed
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "response is not a JSON object" };
  }
  const filesRaw = (parsed as { files?: unknown }).files;
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    return { ok: false, error: "no files in fix response" };
  }
  const seen = new Set<string>();
  const files: FixFile[] = [];
  for (const entry of filesRaw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "file entry is not an object" };
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    if (!isSafeRepoPath(path)) return { ok: false, error: `unsafe or missing path: ${String(path).slice(0, 80)}` };
    if (seen.has(path)) return { ok: false, error: `duplicate path: ${path}` };
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: `empty/non-string content for ${path} (possible truncation)` };
    }
    if (TRUNCATION_MARKERS.some((re) => re.test(content.trimEnd()))) {
      return { ok: false, error: `content for ${path} looks truncated/elided` };
    }
    seen.add(path);
    files.push({ path, content });
  }
  const summary = typeof (parsed as { summary?: unknown }).summary === "string" ? (parsed as { summary: string }).summary : "";
  return { ok: true, fix: { summary, files } };
}
