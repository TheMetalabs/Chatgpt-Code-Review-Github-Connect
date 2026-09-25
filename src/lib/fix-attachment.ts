/**
 * The chatgpt fix request as a FILE ATTACHMENT (#93). The full fix request (instructions, the
 * head-pinned content of every editable file, the findings) must reach the model byte-exact, and
 * ChatGPT's composer does not keep a typed prompt's whitespace. So the request travels as one
 * uploaded text file, and the typed prompt is one short line naming that file and its SHA-256.
 *
 * INVARIANTS:
 *   - the typed prompt is ONE canonical line (no line break, no run of whitespace, no whitespace
 *     at either end): a composer that collapses whitespace leaves it unchanged, so the page's exact
 *     (lossless) check of the typed draft and the sent turn stays meaningful (fixTypedPrompt);
 *   - it names the attachment's SHA-256 (hex, of the UTF-8 bytes), which the page recomputes over
 *     the bytes it stages before anything is uploaded or typed (extension/composer.js);
 *   - an attachment over FIX_ATTACHMENT_MAX_BYTES is refused before any bridge item exists;
 *   - the transport frame is a fix-only envelope whose single JSON line escapes every line break,
 *     so no source line can end it (fixDeliveryText). It is never the review V2 envelope: a fix is
 *     never converted by the route's attachment protocol, and a review never carries this frame;
 *   - there is no inline fallback anywhere: a page that cannot stage the file fails the run
 *     (`attachment_failed`), it never pastes the source into the typed prompt.
 */
import { createHash } from "node:crypto";

export const FIX_ATTACHMENT_NAME = "ashlar-fix-request.txt";
/**
 * 512 KiB of UTF-8. Sized for an aicc PR of 15 changed files and ~1,500 changed lines: the request
 * carries each changed file WHOLE (not its hunks). aicc caps a Service at 200 lines and a
 * controller or React component at 150; specs and fixtures run longer, so budget 15 files x ~400
 * lines x ~60 bytes (Korean comments are 3 bytes a character) = ~360 KB, plus ~10% JSON escaping and
 * ~30 KB of findings and instructions = ~430 KB. 512 KiB keeps that headroom while staying a file a
 * chat model reads whole (~130k tokens) rather than through retrieval excerpts, which would turn a
 * full-file rewrite into a confidently wrong one. A bigger PR fails fast (fix-failed with this cap
 * in the reason): use the local fix provider or split the PR.
 */
export const FIX_ATTACHMENT_MAX_BYTES = 512 * 1024;
export const FIX_ATTACHMENT_BEGIN = "<<<ASHLAR_FIX_ATTACHMENT_V1>>>";
export const FIX_ATTACHMENT_END = "<<<END_ASHLAR_FIX_ATTACHMENT_V1>>>";
/** The one reply the typed prompt asks for when the attachment is missing or does not match: it is
 * not a fix JSON object, so the round ends parse-failed and nothing is committed. */
export const FIX_ATTACHMENT_MISMATCH_REPLY = "ATTACHMENT_MISMATCH";

export interface FixAttachment {
  name: string;
  /** The full fix request, byte-exact. Dropped with the prompt when the item settles. */
  body: string;
  /** Lowercase hex SHA-256 of body's UTF-8 bytes. */
  sha256: string;
  bytes: number;
}

export type FixAttachmentCode = "attachment_too_large" | "attachment_invalid";

export class FixAttachmentError extends Error {
  readonly code: FixAttachmentCode;
  constructor(code: FixAttachmentCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Whether `text` survives any whitespace collapsing unchanged: one line, single spaces, trimmed. */
export const isCanonicalLine = (text: string) => typeof text === "string" && text.length > 0 && text === text.replace(/\s+/g, " ").trim();

function tooLarge(bytes: number): string {
  return `the fix request is ${bytes} bytes; a chatgpt fix attachment holds at most ${FIX_ATTACHMENT_MAX_BYTES} bytes (${FIX_ATTACHMENT_MAX_BYTES / 1024} KiB) — use the local fix provider or split the PR`;
}

/** The attachment for a full fix request. Throws attachment_too_large over the cap. */
export function fixAttachment(body: string): FixAttachment {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > FIX_ATTACHMENT_MAX_BYTES) throw new FixAttachmentError("attachment_too_large", tooLarge(bytes));
  return { name: FIX_ATTACHMENT_NAME, body, sha256: sha256Hex(body), bytes };
}

/** The typed prompt: one canonical line naming the attachment, its size and its SHA-256. */
export function fixTypedPrompt(attachment: Pick<FixAttachment, "name" | "sha256" | "bytes">, deliveryRule: string): string {
  const line = [
    `Ashlar fix request. The attached file ${attachment.name} (${attachment.bytes} bytes, SHA-256 ${attachment.sha256}) is the complete and authoritative request:`,
    "its instructions, the current content of every editable file and the review findings.",
    `Check that the attachment's SHA-256 is ${attachment.sha256}; if the attachment is missing, unreadable, truncated or its hash does not match, reply only with ${FIX_ATTACHMENT_MISMATCH_REPLY}.`,
    "Read the whole attachment, not an excerpt, and follow its instructions; this message adds nothing else.",
    deliveryRule,
  ].join(" ").replace(/\s+/g, " ").trim();
  return line;
}

/** Why a typed prompt and its attachment cannot be delivered (undefined = deliverable). Never
 * echoes the body. */
export function fixAttachmentProblem(prompt: string, attachment: unknown): string | undefined {
  const a = attachment as Partial<FixAttachment> | null;
  if (!a || typeof a !== "object" || a.name !== FIX_ATTACHMENT_NAME || typeof a.body !== "string" || typeof a.sha256 !== "string") {
    return "attachment_invalid: the fix attachment is malformed";
  }
  const bytes = Buffer.byteLength(a.body, "utf8");
  if (bytes > FIX_ATTACHMENT_MAX_BYTES) return `attachment_too_large: ${tooLarge(bytes)}`;
  if (a.bytes !== bytes || sha256Hex(a.body) !== a.sha256) return "attachment_invalid: the fix attachment's size or SHA-256 does not match its bytes";
  if (!isCanonicalLine(prompt)) return "attachment_invalid: the typed fix prompt must be one whitespace-canonical line";
  if (!prompt.includes(a.sha256)) return "attachment_invalid: the typed fix prompt does not name the attachment's SHA-256";
  return undefined;
}

/** The text the worker receives: the typed line, then the fix-only frame (one JSON line). */
export function fixDeliveryText(prompt: string, attachment: FixAttachment): string {
  const entry = JSON.stringify({ name: attachment.name, sha256: attachment.sha256, bytes: attachment.bytes, body: attachment.body });
  return `${prompt}\n\n${FIX_ATTACHMENT_BEGIN}\n${entry}\n${FIX_ATTACHMENT_END}`;
}
