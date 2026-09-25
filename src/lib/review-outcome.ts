import type { Job, RawCause, ReviewProvider } from "./types.ts";
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
  Partial<Pick<Job, "localReviewRole" | "chatFpRound" | "localVerifyStartedAt" | "localFallbackAt" | "localVerified" | "skippedProviders">>;

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

/** The system line naming the reviewers that did not run (harbor records it with the merge). */
export function skippedNote(providers: readonly ReviewProvider[]): string {
  return `Skipped ${providers.join(", ")} (quota or unavailable)`;
}

/** The lines the body lists for reviewers that did not run. Read from the structured
 * `skippedProviders` the merge stamped, never from assumptions: those also carry reviewer-written
 * text, and a reviewer noting it "skipped" generated fixtures is not a reviewer that did not run. */
export function skippedNotes(job: Pick<Job, "skippedProviders">): string[] {
  return job.skippedProviders?.length ? [skippedNote(job.skippedProviders)] : [];
}

/** The fixed text for each raw cause: a Record over the closed type, so a new cause cannot render
 * without deciding what it says. `unparseable` covers every salvage before the gate, and the bridge
 * (repair off) and a multi-turn group salvage a reply that parsed as JSON but failed the review
 * schema too, so its text claims only what holds for both: the reply was not valid review JSON. */
const RAW_CAUSE_TEXT: Record<RawCause, string> = {
  unparseable: "the reply was not valid review JSON",
  "unread-rows": "the reply parsed, but its findings past the gate's row cap were not inspected",
  "not-a-verdict": "the reply could not be used as a complete structured review",
};

/** Why a review's verbatim block is posted, from the causes its merge stamped (Job.rawCauses): one
 * clause per salvaged leg, labeled with its reviewer when there is more than one. Fixed text only,
 * never model output. Cause-neutral when no cause was recorded: the body and the loop handoff never
 * claim a cause the merge did not report (a parse failure, say, for rows the gate did not read). */
export function rawCauseText(causes: Job["rawCauses"]): string {
  const rows = Object.entries(causes ?? {}).filter(
    (row): row is [ReviewProvider, RawCause] => Object.hasOwn(PROVIDER_LABEL, row[0]) && Object.hasOwn(RAW_CAUSE_TEXT, String(row[1])),
  );
  if (!rows.length) return "a reply could not be used as structured review JSON";
  if (rows.length === 1) return RAW_CAUSE_TEXT[rows[0][1]];
  return rows.map(([provider, cause]) => `${PROVIDER_LABEL[provider]}: ${RAW_CAUSE_TEXT[cause]}`).join("; ");
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
  if (job.skippedProviders?.length) return "incomplete";
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
  input: { chat: readonly ReviewProvider[]; verifying: boolean; findings: number; localError?: string; localVerified?: boolean },
): string {
  const chat = input.chat.join(" + ") || "chat";
  if (outcome === "verified-clean") return `${chat} found nothing; local verification agreed.`;
  // A skipped chat peer makes the round incomplete whatever local did, so the note is what tells an
  // agreeing verification from a failed one.
  if (outcome === "incomplete" && input.verifying) {
    return input.localVerified
      ? `${chat} found nothing; local verification agreed.`
      : `${chat} found nothing; local verification did not complete (${input.localError || "unavailable"}).`;
  }
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
