import type { Job, LocalReviewRole, ReviewProvider, ProviderError } from "./types.ts";
import { isChatProvider } from "./types.ts";
import { salvageReviewJson } from "./extract-chat-json.ts";

export function shouldStartLocalRace(input: {
  providers: readonly ReviewProvider[];
  status: Job["status"];
  localDone: boolean;
  localStarted: boolean;
}): boolean {
  if (input.localDone || input.localStarted) return false;
  if (input.status !== "awaiting_chat" && input.status !== "reviewer") return false;
  return input.providers.includes("local");
}

export function skippedProvider(assumptions: readonly string[] | undefined, provider: ReviewProvider): boolean {
  const rows = assumptions ?? [];
  if (provider === "local") return rows.some((a) => /^Skipped local/i.test(a));
  return rows.some((a) => new RegExp(`Skipped ${provider}`, "i").test(a));
}

/**
 * Wait only while an enabled racer has not finished.
 * Finished = JSON payload or explicit terminal outcome. A bare false/expired heartbeat is not evidence.
 * Unknown generating (not yet pinged) counts as still running. No wall clock.
 */
export function stillRacing(input: {
  providers: readonly ReviewProvider[];
  payloads: readonly ReviewProvider[];
  assumptions?: readonly string[];
  localInFlight: boolean;
  generating?: Partial<Record<ReviewProvider, boolean>>;
  providerErrors?: Partial<Record<ReviewProvider, ProviderError>>;
  claimed?: boolean;
  connected?: boolean;
}): boolean {
  for (const p of input.providers) {
    if (input.payloads.includes(p)) continue;
    if (skippedProvider(input.assumptions, p)) continue;
    const error = input.providerErrors?.[p];
    if (error && error.code !== "disconnected") continue;
    return true;
  }
  return false;
}

// settings.localReviewRole = "verify-clean" (pinned on the job at snapshot as Job.localReviewRole):
// the chat reviewers run first, local is held back and is "released" either as a verification round
// (merged chat result parsed clean) or as today's fallback (chat produced no usable result).

/** Local is a verifier only when the job's role says so AND both a chat reviewer and local are enabled. */
export function localVerifies(input: { role?: LocalReviewRole; providers: readonly ReviewProvider[] }): boolean {
  return input.role === "verify-clean" && input.providers.includes("local") && input.providers.some(isChatProvider);
}

/** The providers the job waits on right now: a held-back local leg counts only once it is released. */
export function racingProviders(input: {
  role?: LocalReviewRole;
  providers: readonly ReviewProvider[];
  localReleased: boolean;
}): ReviewProvider[] {
  if (!localVerifies(input) || input.localReleased) return [...input.providers];
  return input.providers.filter((p) => p !== "local");
}

/** Race: start local alongside chat (as today). Verify-clean: start it only once it is released. */
export function shouldStartLocalLeg(input: {
  role?: LocalReviewRole;
  providers: readonly ReviewProvider[];
  localReleased: boolean;
  status: Job["status"];
  localDone: boolean;
  localStarted: boolean;
}): boolean {
  if (localVerifies(input) && !input.localReleased) return false;
  return shouldStartLocalRace(input);
}

/** Chat finished without a usable result (quota / disconnected / no JSON), or it is stalled with no
 * progress because the Chrome bridge is offline / never claimed the job: release local as the fallback. */
export function releaseLocalAsFallback(input: {
  role?: LocalReviewRole;
  providers: readonly ReviewProvider[];
  localReleased: boolean;
  chatRacing: boolean;
  usableChat: boolean;
  /** chatStalled(): chat is nominally racing but cannot progress (bridge offline / job unclaimed). */
  chatStalled?: boolean;
}): boolean {
  return localVerifies(input) && !input.localReleased && !input.usableChat && (!input.chatRacing || Boolean(input.chatStalled));
}

/** A held verify-clean chat leg that has made no progress (no payload, not generating) while the
 * bridge has been disconnected for at least `graceMs`, measured from the moment it disconnected
 * (never from job age). A connected bridge never releases local by time: BRIDGE_CLAIM_MS is an
 * ownership lease, not a reviewer deadline. stillRacing treats `disconnected` as non-terminal, so
 * without this the held local leg would never be released while the bridge is offline. */
export function chatStalled(input: {
  chatProgress: boolean;
  connected: boolean;
  /** When the bridge disconnected (epoch ms); undefined when unknown. */
  disconnectedAt?: number;
  now: number;
  graceMs: number;
}): boolean {
  if (input.chatProgress || input.connected || input.disconnectedAt === undefined) return false;
  return input.now - input.disconnectedAt >= input.graceMs;
}

/** Every completed reply of a local leg, each once, in the order the model wrote them. */
export function localReplies(leg: { unparsedText?: string; originalText?: string }): string {
  return [...new Set([leg.unparsedText, leg.originalText].map((t) => t?.trim() ?? "").filter(Boolean))].join("\n\n---\n\n");
}

/** A RELEASED held local leg (verification round or chat-down fallback) that failed after the model
 * completed a reply that is not review JSON: that reply is the only evidence it produced, possibly a
 * real finding, so it becomes a salvaged leg (posted verbatim) instead of a "Skipped local". Both the
 * failed JSON correction (`originalText`) and the reply before it (`unparsedText`) count, so a
 * correction that itself fails (HTTP 500, transport error, abort) still keeps the first reply. A
 * failure with no completed reply stays a failure. Race is unchanged: its local leg is not held. */
export function heldLocalSalvage(
  job: Pick<Job, "localReviewRole" | "reviewProviders" | "localVerifyStartedAt" | "localFallbackAt">,
  failure: { originalText?: string; unparsedText?: string },
): string | undefined {
  const released = Boolean(job.localVerifyStartedAt || job.localFallbackAt);
  if (!released || !localVerifies({ role: job.localReviewRole, providers: job.reviewProviders ?? [] })) return undefined;
  const replies = localReplies(failure);
  return replies ? salvageReviewJson(replies) : undefined;
}
