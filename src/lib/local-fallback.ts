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

/** Whether a job released as the chat-down fallback (Job.localFallbackAt) waives chat: true while
 * that local leg can still produce a payload (running, or finished with one). The release itself is
 * permanent, whatever the bridge does later (a reconnect included), but the waiver lasts only as long
 * as local can still deliver the review: once local ends with no payload (a failure, "Skipped local"),
 * chat is the only reviewer left, so it is awaited and offered to the bridge again. */
export function fallbackWaivesChat(
  job: Pick<Job, "localFallbackAt" | "storedLegs" | "assumptions" | "providerErrors">,
): boolean {
  if (!job.localFallbackAt) return false;
  if ((job.storedLegs ?? []).some((l) => l.provider === "local" && l.raw.trim())) return true;
  const error = job.providerErrors?.local;
  return !skippedProvider(job.assumptions, "local") && !(error && error.code !== "disconnected");
}

/** The providers the job waits on right now: a held-back local leg counts only once it is released.
 * While a fallback release waives chat (`localFallback` = fallbackWaivesChat), the job waits only on
 * local: a chat payload that still lands before local posts is merged; it is never waited for. */
export function racingProviders(input: {
  role?: LocalReviewRole;
  providers: readonly ReviewProvider[];
  localReleased: boolean;
  localFallback?: boolean;
}): ReviewProvider[] {
  if (!localVerifies(input)) return [...input.providers];
  if (input.localFallback) return input.providers.filter((p) => !isChatProvider(p));
  if (input.localReleased) return [...input.providers];
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

/** A verify-clean job's held local leg that has been released (verification round or fallback). */
export function heldLocalReleased(
  job: Pick<Job, "localReviewRole" | "reviewProviders" | "localVerifyStartedAt" | "localFallbackAt">,
): boolean {
  const released = Boolean(job.localVerifyStartedAt || job.localFallbackAt);
  return released && localVerifies({ role: job.localReviewRole, providers: job.reviewProviders ?? [] });
}

/** Why a reviewer leg's gated reply is not its reviewer's complete verdict (docs/local-verify-clean.md
 * §1), or undefined when it is one. Every leg, chat or local, on race or verify-clean: only a
 * complete verdict earns clean credit (a clean result, a verification round, verified-clean), and
 * a leg that is not one is gated as evidence (verdictEvidence) and posted verbatim. It must pass the
 * gate with every finding it reported intact: a reviewer whose finding the gate dropped for its shape
 * did not return a clean result. No completed reply may have been set aside to get it: the JSON
 * correction does not see the first reply, so a clean correction says nothing about the finding that
 * reply may carry. Nor may any text of the reply itself be set aside: prose the model wrote outside
 * the accepted JSON object (`residualReplies`) can be a finding that object does not carry. Every row
 * it reported must have been inspected, too: a finding past the gate's row cap (`overflow`) was set
 * aside unread. A reply the gate rejected is no verdict at all. */
export function incompleteVerdict(
  gate: { ok: true; malformed?: number; overflow?: number; rawReview?: string } | { ok: false; reason: string },
  leg: { unparsedText?: string; residualReplies?: string },
): string | undefined {
  if (!gate.ok) return gate.reason;
  if (gate.rawReview) return undefined; // already salvaged verbatim
  if (leg.unparsedText?.trim()) return "a completed reply was not review JSON";
  if (leg.residualReplies?.trim()) return "a completed reply carried text outside its review JSON";
  if (gate.malformed) return `${gate.malformed} finding(s) missing required fields`;
  return gateUnreadRows(gate);
}

/** Why ANY leg's gated result (chat or local, race or verify-clean) is not its reviewer's full verdict
 * because the gate set rows past its cap (`overflow`) aside unread, or undefined. Such a leg is gated
 * as evidence (verdictEvidence): an unread row may be the finding, so a result that skipped one can
 * never read as clean, start or support a verification round, or converge. */
export function gateUnreadRows(gate: { ok: true; overflow?: number; rawReview?: string } | { ok: false; reason: string }): string | undefined {
  if (!gate.ok || gate.rawReview || !gate.overflow) return undefined;
  return `${gate.overflow} finding(s) past the gate's row cap were not inspected`;
}

/** What to gate in place of a reply that is not a complete verdict (incompleteVerdict): whatever
 * parsed, with every completed reply attached verbatim as raw_review, so it posts as evidence and
 * never counts as a verdict. */
export function verdictEvidence(
  parsed: Record<string, unknown> | null,
  leg: { raw: string; originalText?: string; unparsedText?: string; residualReplies?: string },
): Record<string, unknown> {
  const replies = localReplies({ unparsedText: leg.unparsedText, residualReplies: leg.residualReplies, originalText: leg.originalText || leg.raw });
  const salvaged = JSON.parse(salvageReviewJson(replies));
  return { ...salvaged, ...(parsed ?? {}), raw_review: salvaged.raw_review };
}

/** Every completed reply of a local leg, each once, in the order the model wrote them. */
export function localReplies(leg: { unparsedText?: string; residualReplies?: string; originalText?: string }): string {
  return [...new Set([leg.unparsedText, leg.residualReplies, leg.originalText].map((t) => t?.trim() ?? "").filter(Boolean))].join("\n\n---\n\n");
}

/** A local leg that failed after the model completed a reply that is not review JSON, on any role
 * (race, or a released held leg: verification round or chat-down fallback): that reply is the only
 * evidence it produced, possibly a real finding, so it becomes a salvaged leg (posted verbatim)
 * instead of a "Skipped local". The same first reply is evidence when its JSON correction parses
 * (incompleteVerdict), so a correction that fails cannot lose it. Both the failed JSON correction
 * (`originalText`) and the reply before it (`unparsedText`) count, so a correction that itself fails
 * (HTTP 500, transport error, abort) still keeps the first reply. A failure with no completed reply
 * stays a failure. */
export function failedLocalSalvage(failure: { originalText?: string; unparsedText?: string }): string | undefined {
  const replies = localReplies(failure);
  return replies ? salvageReviewJson(replies) : undefined;
}
