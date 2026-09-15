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

function claimed(job: Pick<Job, "bridgeClaimedAt">, now: number): boolean {
  return Boolean(job.bridgeClaimedAt && now - job.bridgeClaimedAt < BRIDGE_CLAIM_MS);
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
  >,
  opts?: { localInFlight?: boolean; now?: number; enabled?: readonly ReviewProvider[] },
): ReviewerLane[] {
  const now = opts?.now ?? Date.now();
  const providers = (job.reviewProviders?.length ? job.reviewProviders : opts?.enabled ?? []) as ReviewProvider[];
  return providers.map((provider) => {
    const label = PROVIDER_LABEL[provider];
    const raw = job.storedLegs?.find((l) => l.provider === provider)?.raw?.trim() ?? "";
    const skip = skippedProvider(job.assumptions, provider);
    const skipNote = (job.assumptions ?? []).find((a) =>
      provider === "local" ? /^Skipped local/i.test(a) : new RegExp(`Skipped ${provider}`, "i").test(a),
    );

    if (raw) {
      const stats = replyStats(raw);
      const findings =
        stats.findingCount === undefined
          ? stats.parsed
            ? "JSON back"
            : "reply received · JSON not parsed"
          : `JSON back · ${stats.findingCount} finding${stats.findingCount === 1 ? "" : "s"}`;
      return {
        provider,
        state: "answered" as const,
        label,
        detail: findings,
        answered: true,
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
    if (provider === "local") {
      if (opts?.localInFlight || g === true || job.status === "reviewer") {
        return { provider, state: "generating", label, detail: "calling local LLM", answered: false };
      }
      if (g === false) {
        return { provider, state: "empty", label, detail: "local finished with no JSON", answered: false };
      }
      return { provider, state: "waiting", label, detail: "local in the race", answered: false };
    }

    if (g === true) {
      return { provider, state: "generating", label, detail: "tab is answering", answered: false };
    }
    if (g === false) {
      return { provider, state: "empty", label, detail: "quota or empty reply", answered: false };
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
