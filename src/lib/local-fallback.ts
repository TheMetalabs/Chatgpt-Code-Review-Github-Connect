import type { Job, LocalReviewRole, ReviewProvider, ProviderError } from "./types.ts";
import { isChatProvider } from "./types.ts";

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
 * bridge is disconnected past BRIDGE_CONNECTED_MS, or the job stayed unclaimed past BRIDGE_CLAIM_MS.
 * stillRacing treats `disconnected` as non-terminal, so without this the held local leg would never
 * be released and the review would never complete. */
export function chatStalled(input: {
  chatProgress: boolean;
  connected: boolean;
  claimed: boolean;
  waitedMs: number;
  connectedGraceMs: number;
  claimGraceMs: number;
}): boolean {
  if (input.chatProgress) return false;
  if (!input.connected) return input.waitedMs >= input.connectedGraceMs;
  return !input.claimed && input.waitedMs >= input.claimGraceMs;
}

export type VerifyCleanStep =
  /** Not a verifier job (race, local-only, chat-only) or local ran as the chat fallback: post as today. */
  | "post"
  /** Chat had findings (or a salvaged unparseable reply, which is not clean): post the chat result now. */
  | "post-chat"
  /** Chat parsed clean: hold the post and start the local verification round on the same prompt. */
  | "start-verify"
  /** Verification returned: post the merged result (local's findings, or the clean review). */
  | "post-verified"
  /** Verification failed / was skipped / aborted: post chat's clean result with a visible note. */
  | "post-chat-unverified";

/** What to do with a merged, gated result. Pure: callers pass the job's pinned role, never live settings. */
export function verifyCleanStep(input: {
  role?: LocalReviewRole;
  providers: readonly ReviewProvider[];
  verifyStarted: boolean;
  fallback: boolean;
  findings: number;
  salvagedRaw: boolean;
  /** Local returned a STRUCTURED result. A salvaged, unparseable local reply is not a verification. */
  localStructured: boolean;
}): VerifyCleanStep {
  if (!localVerifies(input) || input.fallback) return "post";
  if (!input.verifyStarted) return input.findings > 0 || input.salvagedRaw ? "post-chat" : "start-verify";
  return input.localStructured ? "post-verified" : "post-chat-unverified";
}

/** Review/ops line saying which reviewer produced a verification round's result. */
export function verifyCleanNote(input: {
  chat: readonly ReviewProvider[];
  step: VerifyCleanStep;
  localFindings: number;
  localError?: string;
}): string {
  const chat = input.chat.join(" + ") || "chat";
  if (input.step === "post-verified") {
    return input.localFindings > 0
      ? `${chat} found nothing; local verification found ${input.localFindings}.`
      : `${chat} found nothing; local verification agreed.`;
  }
  if (input.step === "post-chat-unverified") {
    return `${chat} found nothing; local verification did not complete (${input.localError || "unavailable"}), so this is ${chat}'s unverified clean result.`;
  }
  return "";
}

