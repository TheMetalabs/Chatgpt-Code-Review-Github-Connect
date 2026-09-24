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
 * without the created row's id — outcome unknown). */
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
