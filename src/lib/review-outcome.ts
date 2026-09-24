import type { Job, ReviewProvider } from "./types.ts";
import { PROVIDER_LABEL } from "./types.ts";
import { localVerifies } from "./local-fallback.ts";

// The one place a merged, gated review result is classified. Harbor uses it to decide between
// holding the post for local verification and posting; review-format derives the body's first
// line, raw block header, findings marker and the CONVERGED signal from the same value. Scattered
// flags read separately at each of those points is how an unverified result used to render clean.

export const REVIEW_OUTCOMES = [
  "verify",
  "findings",
  "raw",
  "raw-unverified",
  "clean",
  "verified-clean",
  "unverified-clean",
  "incomplete",
] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
/** What a posted body can be: "verify" means "hold the post", so it is never rendered. */
export type PostedOutcome = Exclude<ReviewOutcome, "verify">;

export type OutcomeJob = Pick<Job, "reviewProviders" | "assumptions" | "rawReview"> &
  Partial<Pick<Job, "localReviewRole" | "chatFpRound" | "localVerifyStartedAt" | "localFallbackAt" | "localVerified">>;

/** A Record keyed by the closed enum: adding a kind without deciding its shape fails the typecheck. */
export const OUTCOME_SHAPE: Record<PostedOutcome, { converged: boolean; unverified: boolean }> = {
  findings: { converged: false, unverified: false },
  raw: { converged: false, unverified: false },
  "raw-unverified": { converged: false, unverified: true },
  clean: { converged: true, unverified: false },
  "verified-clean": { converged: true, unverified: false },
  "unverified-clean": { converged: false, unverified: true },
  incomplete: { converged: false, unverified: false },
};

/** Assumption lines that report a reviewer that did not run (the body lists them; any makes a
 * zero-finding result incomplete rather than clean). */
export function skippedNotes(job: Pick<Job, "assumptions">): string[] {
  return (job.assumptions ?? []).filter((a) => /skipped/i.test(a));
}

/** `findings` is the gated (publishable) count. An FP round always merges as race, and local run
 * as the chat-down fallback is an ordinary reviewer, so neither is a verifier. */
export function reviewOutcome(job: OutcomeJob, findings: number): ReviewOutcome {
  const role = job.chatFpRound ? "race" : job.localReviewRole;
  const verifier = localVerifies({ role, providers: job.reviewProviders ?? [] }) && !job.localFallbackAt;
  const raw = Boolean(job.rawReview?.trim());
  if (verifier && !job.localVerifyStartedAt) return findings > 0 ? "findings" : raw ? "raw" : "verify";
  if (findings > 0) return "findings";
  if (raw) return verifier && !job.localVerified ? "raw-unverified" : "raw";
  if (skippedNotes(job).length) return "incomplete";
  if (!verifier) return "clean";
  return job.localVerified ? "verified-clean" : "unverified-clean";
}

/** Render guard: a verify-clean result whose verification round never ran must never render as a
 * clean pass, so "verify" reaching a body renders as unverified. */
export function postedOutcome(job: OutcomeJob, findings: number): PostedOutcome {
  const outcome = reviewOutcome(job, findings);
  return outcome === "verify" ? "unverified-clean" : outcome;
}

/** The review/ops line naming which reviewer produced a verification round's result. `chat` is
 * only the chat reviewers whose structured result was clean (a skipped one found nothing by absence). */
export function outcomeNote(
  outcome: ReviewOutcome,
  input: { chat: readonly ReviewProvider[]; verifying: boolean; findings: number; localError?: string },
): string {
  const chat = input.chat.join(" + ") || "chat";
  if (outcome === "verified-clean") return `${chat} found nothing; local verification agreed.`;
  if (outcome === "findings" && input.verifying) return `${chat} found nothing; local verification found ${input.findings}.`;
  if (outcome === "unverified-clean") {
    return `${chat} found nothing; local verification did not complete (${input.localError || "unavailable"}), so this is ${chat}'s unverified clean result.`;
  }
  if (outcome === "raw-unverified") {
    return `${chat} found nothing; local verification's reply could not be used as a review (${input.localError || "not review JSON"}); it is posted verbatim below. Not a clean pass.`;
  }
  return "";
}

/** The verbatim block posted for every leg whose reply could not be parsed, labeled when more than
 * one. It combines EVERY salvaged leg on purpose: which reviewer wrote it (including a verifier)
 * decides only the outcome kind, never whether the evidence is posted. Truncated under GitHub's
 * review body limit; the full originals stay in review history. */
export function salvagedReview(legs: ReadonlyArray<{ provider: ReviewProvider; rawReview?: string }>, max: number): string | undefined {
  const salvaged = legs.filter((l) => l.rawReview);
  const combined = salvaged
    .map((l) => (salvaged.length > 1 ? `**${PROVIDER_LABEL[l.provider]}:**\n\n${l.rawReview}` : l.rawReview))
    .join("\n\n---\n\n");
  if (!combined) return undefined;
  return combined.length > max
    ? `${combined.slice(0, max)}\n\n…(truncated to fit GitHub's review body limit; full original responses retained in review history)`
    : combined;
}
