import type { Job, RawCause, ReviewProvider } from "./types.ts";
import { PROVIDER_LABEL } from "./types.ts";
import { localVerifies } from "./local-fallback.ts";
import { SALVAGE_TRUNCATED_MARK } from "./extract-chat-json.ts";

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
  Partial<Pick<Job, "localReviewRole" | "chatFpRound" | "localVerifyStartedAt" | "localFallbackAt" | "localVerified" | "skippedProviders" | "incompleteProviders" | "rawCauses" | "rawTruncated">>;

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

/** The lines the body lists for reviewers that did not run or returned no complete verdict. Read from
 * the structured `skippedProviders` / `incompleteProviders` the merge stamped, never from assumptions:
 * those also carry reviewer-written text, and a reviewer noting it "skipped" generated fixtures is not
 * a reviewer that did not run. */
export function skippedNotes(job: Pick<Job, "skippedProviders" | "incompleteProviders">): string[] {
  return [
    job.skippedProviders?.length ? skippedNote(job.skippedProviders) : "",
    job.incompleteProviders?.length ? `No complete review from ${job.incompleteProviders.join(", ")} (reply posted as evidence)` : "",
  ].filter(Boolean);
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

const TRUNCATED_TEXT = "truncated below to fit GitHub's review body limit, full original in review history";

/** Why a review's verbatim block is posted, from the causes its merge stamped (Job.rawCauses): one
 * clause per salvaged leg, labeled with its reviewer when there is more than one. Fixed text only,
 * never model output. Cause-neutral when no cause was recorded: the body and the loop handoff never
 * claim a cause the merge did not report (a parse failure, say, for rows the gate did not read). A
 * leg whose reply the block holds only in part (Job.rawTruncated) says so in its clause. */
export function rawCauseText(causes: Job["rawCauses"], truncated: readonly ReviewProvider[] = []): string {
  const rows = Object.entries(causes ?? {}).filter(
    (row): row is [ReviewProvider, RawCause] => Object.hasOwn(PROVIDER_LABEL, row[0]) && Object.hasOwn(RAW_CAUSE_TEXT, String(row[1])),
  );
  const cut = (p: ReviewProvider) => (truncated.includes(p) ? ` (${TRUNCATED_TEXT})` : "");
  // A truncated leg with no recorded cause still gets its clause: the header never hides a cut.
  const unlisted = truncated.filter((p) => !rows.some(([provider]) => provider === p));
  const tail = unlisted.length ? ` (${TRUNCATED_TEXT})` : "";
  if (!rows.length) return `a reply could not be used as structured review JSON${tail}`;
  if (rows.length === 1) return `${RAW_CAUSE_TEXT[rows[0][1]]}${cut(rows[0][0])}${tail}`;
  return `${rows.map(([provider, cause]) => `${PROVIDER_LABEL[provider]}: ${RAW_CAUSE_TEXT[cause]}${cut(provider)}`).join("; ")}${tail}`;
}

/** `findings` is the gated (publishable) count. An FP round always merges as race, and local run
 * as the chat-down fallback is an ordinary reviewer, so neither is a verifier. A reviewer whose payload
 * was not its complete verdict (`incompleteProviders`) never leaves the result clean or starts a
 * verification round, on any role: its reply posts as evidence (raw), and without that evidence the
 * result is still incomplete. `raw-unverified` says the raw block holds local verification's own
 * reply, so it needs local's leg among the salvaged ones (`rawCauses`) and in the block in full (not in
 * `rawTruncated`): a chat run that started before the round can land during it with evidence of its
 * own while local returns nothing, and that reply is posted as plain `raw`, never credited to local;
 * a local reply cut to fit the body limit is plain `raw` too, and its header names the cut. */
export function reviewOutcome(job: OutcomeJob, findings: number): ReviewOutcome {
  const role = job.chatFpRound ? "race" : job.localReviewRole;
  const verifier = localVerifies({ role, providers: job.reviewProviders ?? [] }) && !job.localFallbackAt;
  const raw = Boolean(job.rawReview?.trim());
  const incomplete = Boolean(job.incompleteProviders?.length);
  if (verifier && !job.localVerifyStartedAt) return findings > 0 ? "findings" : raw ? "raw" : incomplete ? "incomplete" : "verify";
  if (findings > 0) return "findings";
  if (raw) {
    const localInFull = Object.hasOwn(job.rawCauses ?? {}, "local") && !(job.rawTruncated ?? []).includes("local");
    return verifier && !job.localVerified && localInFull ? "raw-unverified" : "raw";
  }
  if (job.skippedProviders?.length || incomplete) return "incomplete";
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
 * only the chat reviewers whose structured result was clean (a skipped one found nothing by absence).
 * `findingsBy` is each merged reviewer's accepted (gated) finding count, so findings are attributed to
 * the reviewer that reported them. */
export function outcomeNote(
  outcome: ReviewOutcome,
  input: {
    chat: readonly ReviewProvider[];
    verifying: boolean;
    findings: number;
    findingsBy: Partial<Record<ReviewProvider, number>>;
    localError?: string;
    localVerified?: boolean;
    /** The reviewers whose reply is in the raw block (the salvaged legs). */
    rawBy?: readonly ReviewProvider[];
    /** Those whose reply the block holds only in part (salvagedReview's `truncated`). */
    rawTruncated?: readonly ReviewProvider[];
  },
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
  if (outcome === "findings" && input.verifying) return verificationFindingsNote(input);
  if (outcome === "unverified-clean") {
    return `${chat} found nothing; local verification did not complete (${input.localError || "unavailable"}), so this is ${chat}'s unverified clean result.`;
  }
  if (outcome === "raw-unverified") {
    return `${chat} found nothing; local verification's reply could not be used as a review (${input.localError || "not review JSON"}); it is posted verbatim below. Not a clean pass.`;
  }
  if (outcome === "raw" && input.verifying) return verificationRawNote(input);
  return "";
}

/** A verification round posted as plain `raw`: its block holds another reviewer's reply (a chat run
 * that landed during the round), or local verification's own reply cut to fit the body limit. The
 * note says what local verification did and whose reply is posted, never that local's reply is posted
 * verbatim, and names every reply the block holds only in part. */
function verificationRawNote(input: Parameters<typeof outcomeNote>[1]): string {
  const chat = input.chat.join(" + ") || "chat";
  const rawBy = input.rawBy ?? [];
  const by = rawBy.filter((p) => p !== "local");
  const cut = (input.rawTruncated ?? []).filter((p) => rawBy.includes(p));
  const truncated = cut.length ? ` (${cut.map((p) => (p === "local" ? "local verification" : p)).join(" + ")} truncated to fit GitHub's review body limit, full originals in review history)` : "";
  if (rawBy.includes("local") && !input.localVerified) {
    const others = by.length ? `; ${by.join(" + ")}'s reply could not be used as a review either` : "";
    return `${chat} found nothing; local verification's reply could not be used as a review (${input.localError || "not review JSON"})${others}; posted below${truncated}. Not a clean pass.`;
  }
  const localPart = input.localVerified
    ? "local verification found nothing"
    : `local verification did not complete (${input.localError || "unavailable"})`;
  const whose = by.length ? `${by.join(" + ")}'s reply` : "a reviewer's reply";
  return `${chat} found nothing; ${localPart}; ${whose} could not be used as a review and is posted ${truncated ? `below${truncated}` : "verbatim below"}. Not a clean pass.`;
}

/** A verification round's findings, each credited to the reviewer whose gated reply carried it: a
 * chat run that started before the round can land during it, so local verification is credited only
 * with its own findings, and a clean chat reviewer is named clean only while it reports none. With no
 * reviewer to credit, the wording is provider-neutral. */
function verificationFindingsNote(input: Parameters<typeof outcomeNote>[1]): string {
  const count = (p: ReviewProvider) => input.findingsBy[p] ?? 0;
  const clean = input.chat.filter((p) => !count(p));
  const others = (Object.keys(input.findingsBy) as ReviewProvider[]).filter((p) => p !== "local" && count(p) > 0);
  const cleanPart = clean.length ? `${clean.join(" + ")} found nothing` : "";
  if (!others.length && !count("local")) return `${cleanPart || "chat found nothing"}; the review found ${input.findings}.`;
  const localPart = count("local")
    ? `local verification found ${count("local")}`
    : input.localVerified
      ? "local verification found nothing"
      : `local verification did not return a verdict (${input.localError || "unavailable"})`;
  return `${[cleanPart, ...others.map((p) => `${p} found ${count(p)}`), localPart].filter(Boolean).join("; ")}.`;
}

/** The verbatim block posted for every leg whose reply could not be parsed, labeled when more than
 * one. It combines EVERY salvaged leg on purpose: which reviewer wrote it (including a verifier)
 * decides only the outcome kind, never whether the evidence is posted. Held under `max` (GitHub's
 * review body limit) per leg, never by cutting the concatenation: an earlier long reply could
 * otherwise crowd a later one out of the block while the outcome still credits it. Each leg gets an
 * equal share of the room, and a reply shorter than its share passes the rest to the others; a reply
 * over its share keeps its start and ends in its own truncation marker. `truncated` names those legs,
 * and a leg salvageReviewJson already cut (SALVAGE_TRUNCATED_MARK), so the outcome, header and note
 * describe the block as posted. The full originals stay in review history. */
export function salvagedReview(
  legs: ReadonlyArray<{ provider: ReviewProvider; rawReview?: string }>,
  max: number,
): { text: string; truncated: ReviewProvider[] } | undefined {
  const salvaged = legs.filter((l): l is { provider: ReviewProvider; rawReview: string } => Boolean(l.rawReview));
  if (!salvaged.length) return undefined;
  const labeled = salvaged.length > 1;
  const SEPARATOR = "\n\n---\n\n";
  const heads = salvaged.map((l) => (labeled ? `**${PROVIDER_LABEL[l.provider]}:**\n\n` : ""));
  const frame = heads.reduce((n, h) => n + h.length, 0) + SEPARATOR.length * (salvaged.length - 1);
  const shares = fairShares(salvaged.map((l) => l.rawReview.length), Math.max(0, max - frame));
  const truncated: ReviewProvider[] = [];
  const text = salvaged
    .map((l, i) => {
      if (l.rawReview.length <= shares[i]) {
        if (l.rawReview.endsWith(SALVAGE_TRUNCATED_MARK.trim())) truncated.push(l.provider);
        return `${heads[i]}${l.rawReview}`;
      }
      truncated.push(l.provider);
      const whose = labeled ? `${PROVIDER_LABEL[l.provider]} reply truncated` : "truncated";
      return `${heads[i]}${l.rawReview.slice(0, shares[i])}\n\n…(${whose} to fit GitHub's review body limit; full original responses retained in review history)`;
    })
    .join(SEPARATOR);
  return { text, truncated };
}

/** Split `room` among replies of these lengths: equal shares, a reply shorter than its share keeping
 * only its length and passing the rest on (water-filling). */
function fairShares(lengths: readonly number[], room: number): number[] {
  const shares = lengths.map(() => 0);
  let open = lengths.map((_, i) => i);
  let left = room;
  while (open.length) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => lengths[i] <= share);
    if (!fits.length) {
      for (const i of open) shares[i] = share;
      break;
    }
    for (const i of fits) {
      shares[i] = lengths[i];
      left -= lengths[i];
    }
    open = open.filter((i) => lengths[i] > share);
  }
  return shares;
}
