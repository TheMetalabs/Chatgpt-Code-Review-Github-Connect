/**
 * Coarse liveness gate for an in-flight local review leg — NOT per-request tracking.
 *
 * A local leg sits in "waiting" (accepted, no output token yet) until its first token. From one HTTP
 * stream we cannot tell "the server is prefilling my request" from "my request was lost" (a racing or
 * transport error swallowed it) — both look like keepalive-only. With no deadline (the default) and a
 * liveness abort that only fires on TOTAL silence, a lost request would keep the leg "waiting" forever,
 * and a finished peer reviewer never posts (stillRacing waits on it).
 *
 * OpenAI-style local servers (oMLX, vLLM) expose GET /api/status with aggregate `active_requests` /
 * `waiting_requests`. When BOTH are zero the server has NO work at all — so a leg we still believe is in
 * flight never landed. "Nothing anywhere" is unambiguous under concurrency and needs no request-id
 * matching: it cannot be another job's slot, because there are no slots. The caller uses this to skip a
 * lost leg and post the peers' result instead of hanging.
 */

export type LocalServerLoad = { activeRequests: number; waitingRequests: number };

/** GET /api/status poll interval while a leg has produced no output. */
export const LOCAL_IDLE_POLL_MS = 15_000;
/** Grace before the lost-request watchdog starts, so a just-sent request has time to register. */
export const LOCAL_IDLE_GRACE_MS = 30_000;
/** Consecutive "server has no work at all" observations required before skipping (debounces the brief
 * window between the server accepting a request and it appearing in active/waiting). */
export const LOCAL_IDLE_CONFIRMATIONS = 2;

/** On unless ASHLAR_LOCAL_IDLE_SKIP="false". Lets an operator keep the old wait-forever behaviour. */
export function localIdleSkipEnabled(
  env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined,
): boolean {
  return env?.ASHLAR_LOCAL_IDLE_SKIP !== "false";
}

/** Read `active_requests` / `waiting_requests` from an /api/status body. Returns null when the shape is
 * not what we expect, so an older/other server never triggers a spurious skip. */
export function parseLocalServerLoad(body: unknown): LocalServerLoad | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const a = b.active_requests;
  const w = b.waiting_requests;
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  if (typeof w !== "number" || !Number.isFinite(w)) return null;
  return { activeRequests: Math.max(0, Math.floor(a)), waitingRequests: Math.max(0, Math.floor(w)) };
}

/** Fetch the server's aggregate load, or null on any failure (unreachable, non-2xx, bad shape). A null
 * result MUST never be read as "idle" — the caller only skips on a positive zero/zero reading, so a
 * status the poll cannot confirm leaves the existing liveness/ceiling aborts in charge. */
export async function fetchLocalServerLoad(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  deps: { fetch?: typeof fetch } = {},
): Promise<LocalServerLoad | null> {
  const doFetch = deps.fetch ?? fetch;
  let url: string;
  // /api/status lives at the server root, while baseUrl is the OpenAI base (…/v1); resolve against the
  // origin so "http://host:port/v1" → "http://host:port/api/status".
  try { url = new URL("/api/status", baseUrl).toString(); } catch { return null; }
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey || "local"}`, accept: "application/json" },
      signal,
    });
    if (!res.ok) return null;
    return parseLocalServerLoad(await res.json());
  } catch {
    return null;
  }
}
