import type { ClientRequest } from "node:http";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";

/** A GitHub API transport failure (no HTTP response), with whether the request may have reached
 * GitHub. `requestSent` is false only when the connection never came up (DNS, connect, TLS). */
export class GithubTransportError extends Error {
  readonly requestSent: boolean;
  constructor(message: string, requestSent: boolean) {
    super(message);
    this.name = "GithubTransportError";
    this.requestSent = requestSent;
  }
}

/** Tracks whether `req`'s bytes may have reached the server: true once its (TLS) connection is up,
 * and for a reused keep-alive socket from the start. Unsure → true (never re-send on a guess). */
export function trackRequestSent(req: ClientRequest): () => boolean {
  let sent = false;
  req.once("socket", (socket: Socket) => {
    if (!socket.connecting) {
      sent = true;
      return;
    }
    socket.once(socket instanceof TLSSocket ? "secureConnect" : "connect", () => {
      sent = true;
    });
  });
  return () => sent;
}

const IDEMPOTENT = new Set(["GET", "HEAD"]);

/** Whether a failed call may be re-sent to another GitHub address. A write (POST/PATCH/PUT/DELETE)
 * whose request may have reached GitHub is never re-sent: a lost response to a comment, review or
 * ref update would otherwise post it twice. */
export function mayResendOnOtherHost(method: string, err: unknown): boolean {
  if (IDEMPOTENT.has(method.toUpperCase())) return true;
  return err instanceof GithubTransportError && !err.requestSent;
}

/** Whether a failed GitHub write created nothing ("rejected") or may have been applied ("unknown").
 * GitHub answered 1xx/3xx/4xx → rejected (a redirect is never followed, a 4xx is a refusal). A 5xx
 * is unknown: GitHub may have created the row before failing (a 502 after a comment landed is
 * routine). No response → rejected only when the request never left; otherwise unknown. */
export type GithubWriteOutcome = "rejected" | "unknown";

export function githubWriteOutcome(status: number, notSent?: boolean): GithubWriteOutcome {
  if (status === 0) return notSent === true ? "rejected" : "unknown";
  return status < 500 ? "rejected" : "unknown";
}

/** A failed GitHub write: `status` is the HTTP status (0 when there was no response, or a 2xx
 * without a usable created row — outcome unknown, see createdRow). */
export class GithubWriteError extends Error {
  readonly status: number;
  readonly outcome: GithubWriteOutcome;
  constructor(message: string, status: number, outcome: GithubWriteOutcome, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GithubWriteError";
    this.status = status;
    this.outcome = outcome;
  }
}

/** A created issue comment as GitHub answered it (a created_at GitHub did not report reads as ""). */
export type PostedIssueComment = { id: number; userLogin: string; createdAt: string; body?: string };
/** A created review as GitHub answered it (a field GitHub did not report reads as ""). */
export type PostedReviewRow = { id: number; userLogin: string; submittedAt: string; commitId: string };

type Row = { id: number; [field: string]: unknown };

const isRow = (data: unknown): data is Row => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const id = (data as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The created row in a write's 2xx answer (`body`, as received): a JSON object carrying GitHub's
 * id, a positive integer. Anything else — an empty body, JSON null, a primitive, an array, an
 * object without a usable id — cannot be that row, yet GitHub accepted the request: the write may
 * have landed. That is GithubWriteError outcome "unknown" (status 0: no usable response, as for a
 * body that is not JSON) under the write's own message prefix — never a TypeError from reading the
 * row, which a caller would take for a refusal and send the write again.
 */
export function createdRow(api: string, status: number, body: string): Row {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    data = undefined;
  }
  if (isRow(data)) return data;
  throw new GithubWriteError(`${api} 0: no created row in the ${status} response: ${body.slice(0, 200) || "(empty body)"}`, 0, "unknown");
}

/** The issue comment a 2xx POST created (see createdRow). */
export function postedIssueComment(status: number, body: string): PostedIssueComment {
  const row = createdRow("GitHub issue comment", status, body);
  return {
    id: row.id,
    userLogin: text((row.user as { login?: unknown } | null | undefined)?.login),
    createdAt: text(row.created_at),
    ...(typeof row.body === "string" ? { body: row.body } : {}),
  };
}

/** The review a 2xx POST created (see createdRow). */
export function postedReviewRow(status: number, body: string): PostedReviewRow {
  const row = createdRow("GitHub Reviews API", status, body);
  return {
    id: row.id,
    userLogin: text((row.user as { login?: unknown } | null | undefined)?.login),
    submittedAt: text(row.submitted_at),
    commitId: text(row.commit_id),
  };
}
