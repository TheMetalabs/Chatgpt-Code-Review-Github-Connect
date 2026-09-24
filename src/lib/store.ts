import type {WorkerStatus} from "./bridge-worker-status";
import { create } from "zustand";
import {
  CANDIDATE_412_DROPPED,
  FINDING_412,
  FINDING_421,
  SAMPLE_PRS,
  tracesFor412,
  tracesFor418,
  tracesFor421,
  tracesForDlq,
  tracesForMention,
} from "./samples";
import { decideIngress, acceptedDeliveryIds } from "./ingress";
import { buildReview, partitionPublishable, isBotMention } from "./poster";
import { sleep } from "./utils";
import type { BotSettings, GithubReady, Job, PostedReview, Trigger, WebhookLog } from "./types";
import { DEFAULT_SETTINGS, LIVE_INFLIGHT_STATUSES, isMaskedSecret } from "./types";

let seq = 1;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

type FireOpts = {
  sampleKey: string;
  trigger: Trigger;
  hmacOk?: boolean;
  thread?: Job["thread"];
  deliveryId?: string;
  forceDlq?: boolean;
};

export type FireResult = { httpStatus: 202 | 403; skip?: string; reject?: string; jobId?: string };

export type BridgeReady = {
  workerStatus?: WorkerStatus;
  workerStatusFresh?: boolean;
  connected: boolean;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
};

interface AshlarState {
  sync: {status: "loading" | "live" | "error"; lastSuccessAt?: number; error?: string};
  historyHealth?: {ok: boolean; mode: string; error?: string};
  markSyncError: (error: string) => void;
  settings: BotSettings;
  jobs: Job[];
  events: WebhookLog[];
  reviews: PostedReview[];
  github: GithubReady;
  bridge: BridgeReady;
  fire: (opts: FireOpts) => Promise<FireResult>;
  cancel: (jobId: string) => void;
  resetDemo: () => void;
  setSettings: (patch: Partial<BotSettings>) => Promise<void>;
  mergeRemote: (remote: {
    history?: {ok: boolean; mode: string; error?: string};
    jobs: Job[];
    events: WebhookLog[];
    reviews: PostedReview[];
    github?: GithubReady;
    bridge?: BridgeReady;
    settings?: Partial<BotSettings> & { localLlmApiKeySet?: boolean; webhookSecretSet?: boolean };
  }) => void;
}


function isLive(status: Job["status"]) {
  return LIVE_INFLIGHT_STATUSES.includes(status);
}

async function playJob(
  get: () => AshlarState,
  set: (fn: (s: AshlarState) => Partial<AshlarState>) => void,
  jobId: string,
  opts: { forceDlq?: boolean } = {},
) {
  const patch = (fn: (j: Job) => Job) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === jobId ? fn(j) : j)),
    }));

  const current = () => get().jobs.find((j) => j.id === jobId);
  if (!current()) return;

  const stages: Job["status"][] = opts.forceDlq
    ? ["snapshot", "explorer", "reviewer"]
    : ["snapshot", "explorer", "reviewer", "validator", "posting"];
  for (const st of stages) {
    await sleep(st === "snapshot" ? 280 : st === "explorer" ? 520 : st === "reviewer" ? 640 : 420);
    const live = current();
    if (!live || live.status === "cancelled") return;
    patch((j) => ({ ...j, status: st, updatedAt: Date.now() }));
  }

  const live = current();
  if (!live || live.status === "cancelled") return;

  if (opts.forceDlq) {
    patch((j) => ({
      ...j,
      status: "dlq",
      skipReason: "validator timeout — job moved to DLQ",
      traces: tracesForDlq(Date.now() - 200),
      updatedAt: Date.now(),
    }));
    return;
  }

  const sample = SAMPLE_PRS[live.sampleKey ?? ""];
  const settings = get().settings;
  const mention = Boolean(live.thread && isBotMention(live.thread.userText, settings));
  const now = Date.now();

  if (mention && live.sampleKey === "pay-412") {
    patch((j) => ({
      ...j,
      traces: tracesForMention(now - 200),
      plan: "Prior findings + user line only. Do not reload the full thread.",
      candidates: [FINDING_412],
      findings: [{ ...FINDING_412, status: "accepted" }],
      mergeRecommendation: "REQUEST_CHANGES",
      highestRisk: "double capture on webhook retry; fulfillOrder also replays",
      assumptions: ["Stripe at-least-once delivery"],
    }));
  } else if (live.sampleKey === "pay-412") {
    const naming = settings.precisionOverRecall
      ? CANDIDATE_412_DROPPED
      : { ...CANDIDATE_412_DROPPED, status: "accepted" as const, dropReason: undefined };
    patch((j) => ({
      ...j,
      traces: tracesFor412(now - 1100),
      plan: "Investigate capture + fulfill replay against payment invariants.",
      candidates: [FINDING_412, naming],
      findings: settings.precisionOverRecall
        ? [{ ...FINDING_412, status: "accepted" }]
        : [
            { ...FINDING_412, status: "accepted" },
            { ...CANDIDATE_412_DROPPED, status: "accepted", dropReason: undefined },
          ],
      mergeRecommendation: "REQUEST_CHANGES",
      highestRisk: "double capture on webhook retry",
      assumptions: ["Stripe at-least-once delivery"],
    }));
  } else if (live.sampleKey === "pay-418") {
    patch((j) => ({
      ...j,
      traces: tracesFor418(now - 420),
      plan: "New invoices route. Confirm auth guard. Findings forbidden until concrete failure.",
      candidates: [],
      findings: [],
      investigatedSafe: ["auth middleware on new route"],
      assumptions: [],
    }));
  } else if (live.sampleKey === "pay-421") {
    patch((j) => ({
      ...j,
      traces: tracesFor421(now - 300),
      plan: "Untrusted PR body quoted, not loaded. Investigate missing auth guard.",
      candidates: [FINDING_421],
      findings: [{ ...FINDING_421, status: "accepted" }],
      mergeRecommendation: "REQUEST_CHANGES",
      highestRisk: "unauthenticated invoice creation",
      assumptions: ["PR body is untrusted"],
    }));
  }

  const after = current();
  if (!after) return;
  const liveSettings = get().settings;
  const { inline, unanchored } = partitionPublishable(after, liveSettings, sample);
  const review = buildReview(after, inline, unanchored, liveSettings);

  if (!review) {
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: "skipped" as const,
              skipReason: "poster: zero findings (precision policy)",
              mergeRecommendation: undefined,
              postedReviewId: undefined,
              updatedAt: Date.now(),
            }
          : j,
      ),
    }));
    return;
  }

  set((s) => ({
    reviews: [
      review,
      ...s.reviews.map((r) =>
        r.owner === review.owner && r.repo === review.repo && r.pr === review.pr && r.headSha === review.headSha
          ? { ...r, dismissed: true }
          : r,
      ),
    ],
    jobs: s.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            status: "posted" as const,
            postedReviewId: review.id,
            updatedAt: Date.now(),
            mergeRecommendation: review.event,
            findings: j.findings,
          }
        : j,
    ),
  }));
}

function mergeLists<T extends { id: string }>(local: T[], remote: T[], keepLocal: (row: T) => boolean) {
  const ids = new Set(remote.map((r) => r.id));
  const kept = local.filter((r) => keepLocal(r) && !ids.has(r.id));
  return [...remote, ...kept];
}

export const useAshlar = create<AshlarState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  github: { webhookSecret: false, appId: false, privateKey: false },
  bridge: { connected: false, lastSeen: 0 },
  jobs: [], events: [], reviews: [],
  sync: {status: "loading"},
  markSyncError: (error) => set(s => ({sync: {...s.sync, status: "error", error}})),
  setSettings: async (patch) => {
    const prev = get().settings;
    const next: BotSettings = { ...prev, ...patch };
    if (!patch.localLlmApiKey || isMaskedSecret(patch.localLlmApiKey)) {
      next.localLlmApiKey = prev.localLlmApiKey;
    } else {
      next.localLlmApiKeySet = true;
    }
    if (!patch.webhookSecret || isMaskedSecret(patch.webhookSecret)) {
      next.webhookSecret = prev.webhookSecret;
    } else {
      next.webhookSecretSet = true;
    }
    const body: Record<string, unknown> = {
      action: "settings",
      username: next.username,
      mention: next.mention,
      skipForks: next.skipForks,
      skipDrafts: next.skipDrafts,
      maxInlineComments: next.maxInlineComments,
      maxTurns: next.maxTurns,
      exploreTurns: next.exploreTurns,
      publishMinSeverity: next.publishMinSeverity,
      requestChangesMin: next.requestChangesMin,
      precisionOverRecall: next.precisionOverRecall,
      reviewChatgpt: next.reviewChatgpt,
      reviewGrok: next.reviewGrok,
      reviewLocal: next.reviewLocal,
      localJsonRepairEnabled: next.localJsonRepairEnabled,
      localLlmBaseUrl: next.localLlmBaseUrl,
      localLlmModel: next.localLlmModel,
      reviewOrder: next.reviewOrder,
      chatgptReasoning: next.chatgptReasoning,
      grokReasoning: next.grokReasoning,
      fixAgent: next.fixAgent,
    };
    if (next.localLlmApiKey.trim() && !isMaskedSecret(next.localLlmApiKey) && patch.localLlmApiKey && !isMaskedSecret(patch.localLlmApiKey)) {
      body.localLlmApiKey = next.localLlmApiKey;
    }
    if (next.webhookSecret.trim() && !isMaskedSecret(next.webhookSecret) && patch.webhookSecret && !isMaskedSecret(patch.webhookSecret)) {
      body.webhookSecret = next.webhookSecret;
    }
    const res = await fetch("/api/harbor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("could not save settings");
    // The server normalizes (e.g. clamps fix-agent numbers): show what it actually saved.
    const saved = (await Promise.resolve()
      .then(() => res.json())
      .catch(() => null)) as { settings?: Partial<BotSettings> } | null;
    set({ settings: saved?.settings?.fixAgent ? { ...next, fixAgent: saved.settings.fixAgent } : next });
  },
  resetDemo: () => {
    // This control is local-only. It must never cancel production jobs on the server.
    set(s => {
      const demos = new Set(s.jobs.filter(j => j.origin === "tape").map(j => j.id));
      return {
        jobs: s.jobs.filter(j => !demos.has(j.id)),
        events: s.events.filter(e => !e.jobId || !demos.has(e.jobId)),
        reviews: s.reviews.filter(review => !demos.has(review.jobId)),
      };
    });
  },
  mergeRemote: (remote) =>
    set((s) => ({
      sync: {status: "live", lastSuccessAt: Date.now()},
      historyHealth: remote.history ?? s.historyHealth,
      jobs: mergeLists(s.jobs, remote.jobs, (j) => j.origin === "tape").sort((a, b) => b.createdAt - a.createdAt),
      events: mergeLists(s.events, remote.events, e => s.jobs.some(j => j.origin === "tape" && j.id === e.jobId)).sort((a, b) => b.at - a.at),
      reviews: mergeLists(s.reviews, remote.reviews, review => s.jobs.some(j => j.origin === "tape" && j.id === review.jobId)).sort((a, b) => b.at - a.at),
      github: remote.github ?? s.github,
      bridge: remote.bridge ?? s.bridge,
      settings: remote.settings
        ? {
            ...s.settings,
            ...remote.settings,
            webhookSecret: s.settings.webhookSecret,
            localLlmApiKey: s.settings.localLlmApiKey,
            reviewOrder: remote.settings.reviewOrder ?? s.settings.reviewOrder,
            localLlmApiKeySet: Boolean(remote.settings.localLlmApiKeySet),
            webhookSecretSet: Boolean(remote.settings.webhookSecretSet),
          }
        : s.settings,
    })),
  cancel: (jobId) => {
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === jobId && isLive(j.status)
          ? { ...j, status: "cancelled" as const, skipReason: "cancelled by operator", updatedAt: Date.now() }
          : j,
      ),
    }));
    void fetch("/api/harbor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", jobId }),
    });
  },
  fire: async (opts) => {
    const sample = SAMPLE_PRS[opts.sampleKey];
    if (!sample) return { httpStatus: 403, reject: "unknown sample" };
    const hmacOk = opts.hmacOk !== false;
    const deliveryId = opts.deliveryId ?? nid("d");
    const t0 = performance.now();
    const decision = decideIngress({
      hmacOk,
      settings: get().settings,
      sample,
      trigger: opts.trigger,
      deliveryId,
      existing: get().jobs,
      knownDeliveries: acceptedDeliveryIds(get().events),
      thread: opts.thread,
    });
    const ingressMs = Math.max(8, performance.now() - t0);

    if (!decision.ok) {
      const ev: WebhookLog = {
        id: nid("ev"),
        deliveryId,
        event: opts.trigger.split(".")[0],
        action: opts.trigger.split(".")[1] ?? "unknown",
        hmac: "fail",
        httpStatus: 403,
        at: Date.now(),
        summary: `${sample.owner}/${sample.repo}#${sample.pr} rejected`,
        rejectReason: decision.reason,
      };
      set((s) => ({ events: [ev, ...s.events] }));
      return { httpStatus: 403, reject: decision.reason };
    }

    if (decision.skip || !decision.job) {
      const skipJob: Job = {
        deliveryId,
        trigger: opts.trigger,
        owner: sample.owner,
        repo: sample.repo,
        pr: sample.pr,
        title: sample.title,
        headSha: sample.headSha,
        baseSha: sample.baseSha,
        sender: sample.sender,
        isFork: sample.isFork,
        isDraft: sample.isDraft,
        thread: opts.thread,
        sampleKey: sample.key,
        origin: "tape",
        id: nid("job"),
        status: "skipped",
        skipReason: decision.skip ?? "filtered",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ingressMs,
        traces: [],
        plan: "",
        candidates: [],
        findings: [],
        investigatedSafe: [],
        assumptions: [],
      };
      const ev: WebhookLog = {
        id: nid("ev"),
        deliveryId,
        event: opts.trigger.split(".")[0],
        action: opts.trigger.split(".")[1] ?? "unknown",
        hmac: "ok",
        httpStatus: 202,
        at: Date.now(),
        summary: `${sample.owner}/${sample.repo}#${sample.pr} skipped`,
        skipReason: decision.skip ?? "filtered",
        jobId: skipJob.id,
      };
      set((s) => ({ jobs: [skipJob, ...s.jobs], events: [ev, ...s.events] }));
      return { httpStatus: 202, skip: decision.skip ?? "filtered", jobId: skipJob.id };
    }

    const payload = decision.job;
    const job: Job = {
      deliveryId: payload.deliveryId,
      trigger: payload.trigger,
      owner: payload.owner,
      repo: payload.repo,
      pr: payload.pr,
      title: payload.title,
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      sender: payload.sender,
      isFork: payload.isFork,
      isDraft: payload.isDraft,
      thread: payload.thread,
      sampleKey: payload.sampleKey,
      origin: "tape",
      id: nid("job"),
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ingressMs,
      traces: [],
      plan: "",
      candidates: [],
      findings: [],
      investigatedSafe: [],
      assumptions: [],
    };

    set((s) => {
      const cancelled = s.jobs.map((j) =>
        j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && isLive(j.status)
          ? { ...j, status: "cancelled" as const, skipReason: `superseded by ${job.id}`, updatedAt: Date.now() }
          : j,
      );
      const ev: WebhookLog = {
        id: nid("ev"),
        deliveryId,
        event: opts.trigger.split(".")[0],
        action: opts.trigger.split(".")[1] ?? "unknown",
        hmac: "ok",
        httpStatus: 202,
        at: Date.now(),
        summary: `${job.owner}/${job.repo}#${job.pr} ${opts.trigger}`,
        jobId: job.id,
      };
      return { jobs: [job, ...cancelled], events: [ev, ...s.events] };
    });

    void playJob(get, set, job.id, { forceDlq: opts.forceDlq });
    return { httpStatus: 202, jobId: job.id };
  },
}));
