import {PROGRESS_LABELS, type ProviderProgress} from "./review-progress.ts";
import { extractChatJson } from "./extract-chat-json.ts";
import { skippedProvider } from "./local-fallback.ts";
import type { Job, JobStatus, ReviewerLane, ReviewerLaneState, ReviewProvider } from "./types.ts";
import { BRIDGE_CLAIM_MS, PROVIDER_LABEL, isChatProvider } from "./types.ts";

export type { ReviewerLane, ReviewerLaneState };

const PRE_CHAT: JobStatus[] = ["queued", "snapshot", "explorer"];

function replyStats(raw: string): { jsonChars: number; findingCount?: number; parsed: boolean } {
  const jsonChars = raw.length;
  const slice = extractChatJson(raw);
  if (!slice) return { jsonChars, parsed: false };
  try {
    const parsed: unknown = JSON.parse(slice);
    const findings =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings.length
        : undefined;
    return { jsonChars, findingCount: findings, parsed: true };
  } catch {
    return { jsonChars, parsed: false };
  }
}

function providerErrorNote(
  job: Pick<Job, "assumptions" | "githubError" | "skipReason" | "providerErrors">,
  provider: ReviewProvider,
): string | undefined {
  const rows = [...(job.assumptions ?? []), job.githubError ?? "", job.skipReason ?? ""];
  const structured = job.providerErrors?.[provider];
  if (structured) return `${structured.code}: ${structured.message}`;
  const own = rows.find(row => new RegExp(`\\b${provider}\\b`, "i").test(row));
  if (own) return own.trim();
  // Common bridge notes may be shared, but never another provider's diagnostic.
  return rows.find(row => !/\b(chatgpt|grok|local)\b/i.test(row) && /bridge|disconnected/i.test(row))?.trim();
}

function emptyProviderDetail(
  job: Pick<Job, "assumptions" | "githubError" | "skipReason" | "bridgeClaimedAt" | "providerErrors">,
  provider: ReviewProvider,
  now: number,
): string {
  const note = providerErrorNote(job, provider) ?? "";
  if (/quota|usage limit|한도/i.test(note)) return "usage limit";
  if (/disconnected|bridge|claim|not connected/i.test(note)) return "connection unknown · waiting for reconnection";
  if (/tab_closed/i.test(note)) return "review tab closed";
  if (/cancelled/i.test(note)) return "cancelled";
  if (/^error:/i.test(note)) return note;
  if (/empty|without (review )?json|no json/i.test(note)) return "finished without JSON";
  if (!claimed(job, now) && provider !== "local") return "finished without JSON";
  return "finished without JSON";
}

function claimed(job: Pick<Job, "bridgeClaimedAt">, now: number): boolean {
  return Boolean(job.bridgeClaimedAt && now - job.bridgeClaimedAt < BRIDGE_CLAIM_MS);
}

/** The in-flight local leg, told apart into the three states an operator needs: queued at the model
 * server (alive, nothing generated for us yet — normal on a concurrency-1 server with other jobs
 * ahead), generating, or no sign of life. Only BINARY freshness (fresh vs stale) is reported, never
 * the live elapsed age: this text feeds the ops-comment change key, so a continuously changing value
 * would rewrite the GitHub comment every tick. */
export function localLegDetail(progress: ProviderProgress | undefined, now: number, staleMs: number): string {
  if (progress?.stage === "local_queued") {
    const aliveAt = progress.keepaliveAt ?? progress.observedAt;
    return now - aliveAt > staleMs
      ? "waiting for local LLM · no response from server"
      : "queued at local LLM · server alive, no output yet";
  }
  const observedAt = progress?.observedAt;
  const stale = observedAt !== undefined && now - observedAt > staleMs;
  return stale ? "calling local LLM · no recent progress" : "calling local LLM";
}

/** Ops-comment note for an in-flight local leg, or null when it is generating normally. */
export function localLegNote(progress: ProviderProgress | undefined, now: number, staleMs: number): string | null {
  const detail = localLegDetail(progress, now, staleMs);
  if (detail === "calling local LLM") return null;
  if (detail === "queued at local LLM · server alive, no output yet") {
    return "local reviewer: queued at the local LLM (server alive, no output yet — a concurrency-1 server serves earlier jobs first)";
  }
  if (detail === "waiting for local LLM · no response from server") {
    return "local reviewer: no response from the local LLM server (still waiting; cancel manually if stalled)";
  }
  return "local reviewer: no recent progress (still waiting; cancel manually if stalled)";
}

export function buildReviewerLanes(
  job: Pick<
    Job,
    | "status"
    | "reviewProviders"
    | "storedLegs"
    | "assumptions"
    | "generating"
    | "attemptedProviders"
    | "bridgeClaimedAt"
    | "skipReason"
    | "githubError"
    | "providerErrors"
    | "providerProgress"
  >,
  opts?: { localInFlight?: boolean; now?: number; enabled?: readonly ReviewProvider[]; staleMs?: number },
): ReviewerLane[] {
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? 300_000;
  const providers = (job.reviewProviders?.length ? job.reviewProviders : opts?.enabled ?? []) as ReviewProvider[];
  return providers.map((provider) => {
    const label = PROVIDER_LABEL[provider];
    const raw = job.storedLegs?.find((l) => l.provider === provider)?.raw?.trim() ?? "";
    const skip = skippedProvider(job.assumptions, provider);
    const skipNote = (job.assumptions ?? []).find((a) =>
      provider === "local" ? /^Skipped local/i.test(a) : new RegExp(`Skipped ${provider}`, "i").test(a),
    );

    const pendingLocal = provider === "local" && Boolean(opts?.localInFlight || job.generating?.local === true);
    if (pendingLocal) {
      return { provider, state: "generating", label, detail: localLegDetail(job.providerProgress?.local, now, staleMs), answered: false };
    }
    if (raw) {
      const stats = replyStats(raw);
      const findings =
        stats.findingCount === undefined
          ? stats.parsed
            ? "JSON back"
            : "reply received · extract failed (not review JSON)"
          : `JSON back · ${stats.findingCount} finding${stats.findingCount === 1 ? "" : "s"}`;
      return {
        provider,
        state: stats.parsed ? "answered" as const : "empty" as const,
        label,
        detail: findings,
        answered: stats.parsed,
        jsonChars: stats.jsonChars,
        findingCount: stats.findingCount,
      };
    }

    if (skip) {
      return {
        provider,
        state: "skipped" as const,
        label,
        detail: skipNote ?? "skipped",
        answered: false,
      };
    }

    if (job.status === "skipped" || job.status === "cancelled" || job.status === "dlq") {
      return {
        provider,
        state: "skipped" as const,
        label,
        detail: job.skipReason ?? job.status,
        answered: false,
      };
    }

    if (PRE_CHAT.includes(job.status)) {
      return {
        provider,
        state: "queued" as const,
        label,
        detail: job.status === "queued" ? "in queue" : `${job.status} — chat not started`,
        answered: false,
      };
    }

    const g = job.generating?.[provider];
    if (g === false && !providerErrorNote(job, provider)) {
      return {provider, state: "waiting", label, detail: "waiting for completion confirmation", answered: false};
    }
    if (provider === "local") {
      if (opts?.localInFlight || g === true || job.status === "reviewer") {
        return { provider, state: "generating", label, detail: "calling local LLM", answered: false };
      }
      if (g === false) {
        return {
          provider,
          state: "empty",
          label,
          detail: emptyProviderDetail(job, provider, now),
          answered: false,
        };
      }
      return { provider, state: "waiting", label, detail: "local in the race", answered: false };
    }

    if (job.providerErrors?.[provider]?.code === "disconnected" || (g === true && job.bridgeClaimedAt && !claimed(job, now))) {
      return {provider, state: "waiting", label, detail: "connection unknown · waiting for reconnection", answered: false};
    }
    const progress=job.providerProgress?.[provider];
    if(progress && Object.hasOwn(PROGRESS_LABELS,progress.stage)) {
      return {provider,state:progress.stage==="generating"?"generating":"waiting",label,detail:PROGRESS_LABELS[progress.stage],answered:false};
    }
    if (g === true) {
      return { provider, state: "waiting", label, detail: "Chrome task pending · submission not confirmed", answered: false };
    }
    if (g === false) {
      return { provider, state: "empty", label, detail: emptyProviderDetail(job, provider, now), answered: false };
    }
    if (job.status === "awaiting_chat" && claimed(job, now)) {
      return { provider, state: "waiting", label, detail: "Chrome claimed · waiting for JSON", answered: false };
    }
    if (job.status === "awaiting_chat") {
      return { provider, state: "waiting", label, detail: "waiting for Chrome bridge", answered: false };
    }
    if (job.status === "validator" || job.status === "posting" || job.status === "posted") {
      return { provider, state: "empty", label, detail: "no JSON from this reviewer", answered: false };
    }
    return {
      provider,
      state: "waiting",
      label,
      detail: isChatProvider(provider) ? "waiting for Chrome" : "waiting",
      answered: false,
    };
  });
}

export function laneTone(state: ReviewerLaneState): "ok" | "warn" | "danger" | "accent" | "muted" {
  if (state === "answered") return "ok";
  if (state === "generating") return "accent";
  if (state === "waiting") return "warn";
  if (state === "skipped" || state === "empty") return "danger";
  return "muted";
}

export function laneVerb(state: ReviewerLaneState): string {
  if (state === "answered") return "answered";
  if (state === "generating") return "generating";
  if (state === "waiting") return "waiting";
  if (state === "skipped") return "skipped";
  if (state === "empty") return "no JSON";
  return "queued";
}

/**
 * When a review ends with no reviewer JSON, report WHY from the per-reviewer lanes instead of a
 * blanket "finished without JSON" — that message hid usage-limit and connection causes and made an
 * infra failure look like a model that reviewed and found nothing. The ops note lists each lane so
 * the operator sees the real reason (e.g. "ChatGPT: usage limit").
 */
export function emptyReviewSkip(lanes: readonly ReviewerLane[]): {
  usageLimited: boolean;
  skipReason: string;
  ops: string[];
} {
  const usageLimited = lanes.some((lane) => /usage limit|quota|한도/i.test(lane.detail));
  // Reserve "finished without JSON" for a genuinely empty reply. Any lane whose detail is NOT that
  // explicit empty signal is some other terminal failure — a skip note in raw code form
  // (`tab_closed`, `cancelled`, `context_lost`, …) or a humanized detail — so bias toward "could not
  // complete" and never misreport an infra failure as a model that reviewed and found nothing.
  const EMPTY_REPLY = /without (review )?json|no json|finished without|no reviewer json/i;
  const infraFailed = !usageLimited && lanes.some((lane) => !EMPTY_REPLY.test(lane.detail));
  const details = lanes.map((lane) => `${lane.label}: ${lane.detail}`);
  const skipReason = usageLimited
    ? "reviewers could not complete — usage limit reached"
    : infraFailed
      ? "reviewers could not complete — see per-reviewer details"
      : "every enabled reviewer finished with no JSON";
  const headline = usageLimited
    ? "No review posted — a reviewer hit its usage limit before returning JSON."
    : infraFailed
      ? "No review posted — reviewers could not complete (see per-reviewer details)."
      : "Enabled reviewers finished without JSON. Nothing to post.";
  return { usageLimited, skipReason, ops: [headline, ...details] };
}
