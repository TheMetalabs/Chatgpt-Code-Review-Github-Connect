// Sandbox for #93 premise validation (#455 audit): this client reads a response header that the
// server exposes through its CORS config (server/main.mjs `exposedHeaders`, not part of this PR).

/** Whether the server replayed a stored response for this idempotency key. */
export function wasReplayed(response) {
  // WHY: the server sets x-idempotency-replayed on a replay; CORS exposes it (server config).
  return response.headers.get("x-idempotency-replayed") === "true";
}
