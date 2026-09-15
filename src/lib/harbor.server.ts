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
import { acceptedDeliveryIds, decideIngress } from "./ingress";
import { parseGitHubPayload } from "./github-payload";
import { createPullReview, fetchPullHead, fetchPullSnapshot, githubReady, installationToken } from "./github.server";
import { buildChatPrompt, buildFpPrompt, parseChatSubmission } from "./chat-prompt";
import { runLocalLlm } from "./local-llm.server";
import {
  applyFpStep,
  buildReview,
  disputedFromUnique,
  filterPublishable,
  finalizeFp,
  gateLiveSubmission,
  gatePeerSubmission,
  isBotMention,
  partitionMany,
  type LiveGateResult,
} from "./poster";
import { sleep } from "./utils";
import type { BotSettings, Job, PostedReview, ReviewProvider, SamplePr, Trigger, WebhookLog } from "./types";
import {
  DEFAULT_SETTINGS,
  LIVE_INFLIGHT_STATUSES,
  isChatProvider,
  normalizeReviewOrder,
  providersFromSettings,
} from "./types";

let seq = 1;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

export type HarborState = {
  settings: BotSettings;
  jobs: Job[];
  events: WebhookLog[];
  reviews: PostedReview[];
};

export type HarborFireOpts = {
  sampleKey: string;
  trigger: Trigger;
  hmacOk?: boolean;
  thread?: Job["thread"];
  deliveryId?: string;
  forceDlq?: boolean;
};

export type HarborFireResult = { httpStatus: 202 | 403; skip?: string; reject?: string; jobId?: string; queued?: boolean };

const CAP = 80;
let state: HarborState = {
  settings: { ...DEFAULT_SETTINGS },
  jobs: [],
  events: [],
  reviews: [],
};

function isLive(status: Job["status"]) {
  return LIVE_INFLIGHT_STATUSES.includes(status);
}

function trim<T>(xs: T[]) {
  return xs.length > CAP ? xs.slice(0, CAP) : xs;
}

export function getHarbor(): HarborState {
  return {
    settings: state.settings,
    jobs: state.jobs,
    events: state.events,
    reviews: state.reviews,
  };
}

export function githubStatus() {
  return githubReady();
}

export function patchHarborSettings(patch: Partial<BotSettings>) {
  const next = { ...state.settings, ...patch };
  if (!providersFromSettings(next).length) return state.settings;
  state = { ...state, settings: next };
  return state.settings;
}

export function resetHarbor() {
  state = { settings: { ...DEFAULT_SETTINGS }, jobs: [], events: [], reviews: [] };
}

export function cancelHarborJob(jobId: string) {
  state = {
    ...state,
    jobs: state.jobs.map((j) =>
      j.id === jobId && isLive(j.status)
        ? { ...j, status: "cancelled" as const, skipReason: "cancelled by operator", updatedAt: Date.now() }
        : j,
    ),
  };
}

function patchJob(jobId: string, fn: (j: Job) => Job) {
  state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? fn(j) : j)) };
}

export function patchHarborJob(jobId: string, fn: (j: Job) => Job) {
  patchJob(jobId, fn);
}

export function publicJobs(jobs: Job[]) {
  return jobs.map(({ chatPrompt: _prompt, chatPromptByProvider: _by, storedLegs: _legs, ...rest }) => rest);
}

export function publicSettings(s: BotSettings) {
  return {
    ...s,
    webhookSecret: "",
    localLlmApiKey: "",
    localLlmApiKeySet: Boolean(s.localLlmApiKey),
  };
}

async function playTape(jobId: string, opts: { forceDlq?: boolean } = {}) {
  const current = () => state.jobs.find((j) => j.id === jobId);
  if (!current()) return;
  const stages: Job["status"][] = opts.forceDlq
    ? ["snapshot", "explorer", "reviewer"]
    : ["snapshot", "explorer", "reviewer", "validator", "posting"];
  for (const st of stages) {
    await sleep(st === "snapshot" ? 280 : st === "explorer" ? 520 : st === "reviewer" ? 640 : 420);
    const live = current();
    if (!live || live.status === "cancelled") return;
    patchJob(jobId, (j) => ({ ...j, status: st, updatedAt: Date.now() }));
  }
  const live = current();
  if (!live || live.status === "cancelled") return;
  if (opts.forceDlq) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "dlq",
      skipReason: "validator timeout — job moved to DLQ",
      traces: tracesForDlq(Date.now() - 200),
      updatedAt: Date.now(),
    }));
    return;
  }

  const sample = SAMPLE_PRS[live.sampleKey ?? ""];
  const settings = state.settings;
  const mention = Boolean(live.thread && isBotMention(live.thread.userText, settings));
  const now = Date.now();

  if (mention && live.sampleKey === "pay-412") {
    patchJob(jobId, (j) => ({
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
    patchJob(jobId, (j) => ({
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
    patchJob(jobId, (j) => ({
      ...j,
      traces: tracesFor418(now - 420),
      plan: "New invoices route. Confirm auth guard. Findings forbidden until concrete failure.",
      candidates: [],
      findings: [],
      investigatedSafe: ["auth middleware on new route"],
      assumptions: [],
    }));
  } else if (live.sampleKey === "pay-421") {
    patchJob(jobId, (j) => ({
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

  await finishJob(jobId, sample);
}

export type ChatLeg = { provider: ReviewProvider; raw: string };

async function playGithub(jobId: string, untrustedBody: string) {
  const current = () => state.jobs.find((j) => j.id === jobId);
  const live0 = current();
  if (!live0 || live0.status === "cancelled") return;

  patchJob(jobId, (j) => ({ ...j, status: "snapshot", updatedAt: Date.now() }));
  const ready = githubReady();
  if (!ready.appId || !ready.privateKey || !live0.installationId) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "GitHub App credentials missing — cannot snapshot head SHA",
      githubError: "Set GitHub App ID and private key in Settings",
      updatedAt: Date.now(),
    }));
    return;
  }

  let token: string;
  let sample: SamplePr;
  try {
    token = await installationToken(live0.installationId);
    let target = {
      owner: live0.owner,
      repo: live0.repo,
      pr: live0.pr,
      title: live0.title,
      headSha: live0.headSha,
      baseSha: live0.baseSha,
      sender: live0.sender,
      isFork: live0.isFork,
      isDraft: live0.isDraft,
    };
    if (!target.headSha || !target.baseSha) {
      const pull = await fetchPullHead(token, live0.owner, live0.repo, live0.pr);
      target = {
        ...target,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        title: pull.title,
        isDraft: pull.draft,
        isFork: pull.fork,
      };
      patchJob(jobId, (j) => ({
        ...j,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        title: pull.title,
        isDraft: pull.draft,
        isFork: pull.fork,
      }));
    }
    sample = await fetchPullSnapshot(token, target);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "snapshot failed";
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "GitHub snapshot failed",
      githubError: msg.slice(0, 240),
      updatedAt: Date.now(),
    }));
    return;
  }

  const gated = current();
  if (!gated || gated.status === "cancelled") return;
  if (state.settings.skipForks && gated.isFork) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "fork (allowlist empty) · PR body not promoted to policy",
      updatedAt: Date.now(),
    }));
    return;
  }
  if (state.settings.skipDrafts && gated.isDraft) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "draft",
      updatedAt: Date.now(),
    }));
    return;
  }

  if (current()?.status === "cancelled") return;
  const providers = providersFromSettings(state.settings);
  if (!providers.length) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "no review chat enabled",
      updatedAt: Date.now(),
    }));
    return;
  }
  const extra = current()?.thread?.userText ?? "";
  const prompt = buildChatPrompt({
    sample,
    extra,
    untrustedBody,
  });
  const order = normalizeReviewOrder(state.settings.reviewOrder);
  const chatProviders = providers.filter(isChatProvider);
  const storedLegs: ChatLeg[] = [];
  if (providers.includes("local")) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "reviewer",
      plan: "Snapshot loaded. Calling the local OpenAI-compatible LLM.",
      updatedAt: Date.now(),
    }));
    const local = await runLocalLlm(prompt, state.settings);
    if (local.ok) storedLegs.push({ provider: "local", raw: local.raw });
    else {
      patchJob(jobId, (j) => ({
        ...j,
        githubError: `local LLM: ${local.error}`,
        updatedAt: Date.now(),
      }));
    }
  }
  if (!chatProviders.length) {
    if (!storedLegs.length) {
      patchJob(jobId, (j) => ({
        ...j,
        status: "skipped",
        skipReason: "local LLM failed and no chat reviewer is on",
        updatedAt: Date.now(),
      }));
      return;
    }
    patchJob(jobId, (j) => ({
      ...j,
      status: "awaiting_chat",
      plan: "Local LLM returned. Running poster.",
      chatPrompt: prompt,
      reviewProviders: providers,
      reviewOrder: order,
      storedLegs,
      updatedAt: Date.now(),
    }));
    await submitHarborChat(jobId, storedLegs[0].raw, storedLegs);
    return;
  }
  patchJob(jobId, (j) => ({
    ...j,
    status: "awaiting_chat",
    plan:
      providers.length > 1
        ? `Snapshot loaded. ${providers.join(" + ")} review in parallel. False-positive checks run in order: ${order.join(" → ")}.`
        : "Snapshot loaded. The Chrome bridge will send this to ChatGPT or Grok on this machine.",
    chatPrompt: prompt,
    reviewProviders: providers,
    reviewOrder: order,
    storedLegs,
    updatedAt: Date.now(),
  }));
}

export function previewChatPaste(raw: string) {
  const parsed = parseChatSubmission(raw);
  if (!parsed) return { ok: false as const, error: "paste the JSON object ChatGPT or Grok returned" };
  return gateLiveSubmission(parsed, SAMPLE_PRS["pay-412"], state.settings);
}

export async function submitHarborChat(
  jobId: string,
  raw: string,
  legs?: ChatLeg[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") {
    return { ok: false, error: "job is not waiting for a chat review" };
  }
  if (job.origin !== "github" || !job.installationId) {
    return { ok: false, error: "not a GitHub job" };
  }
  const providers = job.reviewProviders?.length ? job.reviewProviders : providersFromSettings(state.settings);
  const incoming: ChatLeg[] =
    legs && legs.length
      ? legs.filter((l) => providers.includes(l.provider) && l.raw.trim())
      : raw.trim()
        ? [{ provider: (isChatProvider(providers[0]) ? providers[0] : providers.find(isChatProvider)) ?? "chatgpt", raw }]
        : [];
  const stored = (job.storedLegs ?? []).filter((l) => !incoming.some((i) => i.provider === l.provider) && l.raw.trim());
  const payloads = job.chatFpRound ? incoming : [...incoming, ...stored];
  if (!payloads.length) {
    return { ok: false, error: "quota" };
  }
  const skipped = providers.filter((p) => !payloads.some((l) => l.provider === p) && !(job.chatFpRound && p === "local"));

  let locked = false;
  patchJob(jobId, (j) => {
    if (j.status !== "awaiting_chat") return j;
    locked = true;
    return { ...j, status: "validator", updatedAt: Date.now() };
  });
  if (!locked) return { ok: false, error: "job is not waiting for a chat review" };

  const revert = (error: string) => {
    patchJob(jobId, (j) =>
      j.status === "validator"
        ? { ...j, status: "awaiting_chat", githubError: error, updatedAt: Date.now() }
        : j,
    );
    return { ok: false as const, error };
  };

  let token: string;
  let sample: SamplePr;
  try {
    token = await installationToken(job.installationId);
    sample = await fetchPullSnapshot(token, {
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
      title: job.title,
      headSha: job.headSha,
      baseSha: job.baseSha,
      sender: job.sender,
      isFork: job.isFork,
      isDraft: job.isDraft,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "snapshot failed";
    return revert(msg.slice(0, 240));
  }

  const still = state.jobs.find((j) => j.id === jobId);
  if (!still || still.status === "cancelled") {
    return { ok: false, error: "cancelled" };
  }

  if (still.chatFpRound && still.fpPending) {
    const checker = (still.fpProviders?.[0] ?? payloads[0]?.provider) as ReviewProvider;
    const parsed = parseChatSubmission(payloads[0]?.raw ?? "");
    const gated = gatePeerSubmission(parsed, sample, state.settings);
    if (!gated.ok) return revert(`${checker}: ${gated.reason}`);
    const stepped = applyFpStep(still.fpPending, checker, gated.check);
    patchJob(jobId, (j) =>
      j.fpPending
        ? {
            ...j,
            fpPending: {
              ...j.fpPending,
              agreed: stepped.agreed,
              disputed: stepped.disputed,
              fpQueue: j.fpPending.fpQueue.filter((p) => p !== checker),
              dropped: [...j.fpPending.dropped, ...stepped.dropped],
            },
            findings: [...stepped.agreed, ...stepped.disputed.map((d) => d.finding)],
            updatedAt: Date.now(),
          }
        : j,
    );
    return runFpPipeline(jobId, sample, token);
  }

  const gates: LiveGateResult[] = [];
  const byProvider = new Map<ReviewProvider, LiveGateResult>();
  const invalid: string[] = [];
  for (const leg of payloads) {
    const parsed = parseChatSubmission(leg.raw);
    const gate = gateLiveSubmission(parsed, sample, state.settings);
    if (!gate.ok) {
      invalid.push(`${leg.provider}: ${gate.reason}`);
      continue;
    }
    gates.push(gate);
    byProvider.set(leg.provider, gate);
  }

  if (!gates.length) {
    const canRetry = providers.some(isChatProvider);
    if (!canRetry) {
      patchJob(jobId, (j) => ({
        ...j,
        status: "skipped",
        skipReason: invalid.join("; ") || "no valid review JSON",
        githubError: invalid.join("; ") || "no valid review JSON",
        updatedAt: Date.now(),
      }));
      return { ok: false, error: invalid.join("; ") || "no valid review JSON" };
    }
    return revert(invalid.join("; ") || "no valid review JSON");
  }

  if (gates.length < 2) {
    const merged = gates[0];
    patchJob(jobId, (j) => ({
      ...j,
      findings: merged.findings,
      candidates: merged.findings,
      mergeRecommendation: merged.mergeRecommendation,
      highestRisk: merged.highestRisk,
      investigatedSafe: merged.investigatedSafe,
      assumptions: [
        skipped.length ? `Skipped ${skipped.join(", ")} (quota or unavailable)` : "",
        ...invalid,
        ...merged.assumptions,
      ].filter(Boolean),
      plan:
        skipped.length || invalid.length
          ? `Posted from ${[...byProvider.keys()].join(" + ")} only.`
          : j.plan,
      updatedAt: Date.now(),
    }));
    await finishJob(jobId, sample, token);
    return finishResult(jobId);
  }

  const part = partitionMany([...byProvider.entries()].map(([provider, gate]) => ({ provider, gate })));
  const investigatedSafe = [...new Set([...gates.flatMap((g) => g.investigatedSafe)])].slice(0, 8);
  const assumptions = [
    skipped.length ? `Skipped ${skipped.join(", ")} (quota or unavailable)` : "",
    ...invalid,
    ...gates.flatMap((g) => g.assumptions),
  ].filter(Boolean);
  const disputed = disputedFromUnique(part.unique);
  if (!disputed.length) {
    const merged = finalizeFp({ agreed: part.agreed, disputed: [], investigatedSafe, assumptions }, state.settings);
    patchJob(jobId, (j) => ({
      ...j,
      findings: merged.findings,
      candidates: merged.findings,
      mergeRecommendation: merged.mergeRecommendation,
      highestRisk: merged.highestRisk,
      investigatedSafe: merged.investigatedSafe,
      assumptions: merged.assumptions,
      updatedAt: Date.now(),
    }));
    await finishJob(jobId, sample, token);
    return finishResult(jobId);
  }

  const ran = [...byProvider.keys()];
  const order = normalizeReviewOrder(still.reviewOrder ?? state.settings.reviewOrder).filter(
    (p) => ran.includes(p) || (p === "local" && providers.includes("local")),
  );
  patchJob(jobId, (j) => ({
    ...j,
    chatFpRound: true,
    fpPending: {
      agreed: part.agreed,
      disputed,
      fpQueue: order,
      investigatedSafe,
      assumptions,
      skipped,
      dropped: [],
    },
    reviewOrder: order,
    findings: [...part.agreed, ...disputed.map((d) => d.finding)],
    candidates: [...part.agreed, ...disputed.map((d) => d.finding)],
    investigatedSafe,
    assumptions,
    plan: `Ordered false-positive check (${order.join(" → ")}). ${disputed.length} one-sided finding(s).`,
    updatedAt: Date.now(),
  }));
  return runFpPipeline(jobId, sample, token);
}

function finishResult(jobId: string): { ok: true } | { ok: false; error: string } {
  const done = state.jobs.find((j) => j.id === jobId);
  if (done?.status === "dlq") {
    return { ok: false, error: done.githubError || "GitHub Reviews API failed" };
  }
  if (done?.status === "cancelled") {
    return { ok: false, error: "cancelled" };
  }
  return { ok: true };
}

async function runFpPipeline(
  jobId: string,
  sample: SamplePr,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (;;) {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job || job.status === "cancelled") return { ok: false, error: "cancelled" };
    const pending = job.fpPending;
    if (!pending) return { ok: false, error: "missing fp state" };
    if (!pending.fpQueue.length) {
      const merged = finalizeFp(pending, state.settings);
      patchJob(jobId, (j) => ({
        ...j,
        status: "validator",
        findings: merged.findings,
        candidates: merged.findings,
        mergeRecommendation: merged.mergeRecommendation,
        highestRisk: merged.highestRisk,
        investigatedSafe: merged.investigatedSafe,
        assumptions: [...pending.assumptions, ...pending.dropped].filter(Boolean).slice(0, 12),
        plan: "Posted after parallel reviews and ordered false-positive checks.",
        updatedAt: Date.now(),
      }));
      await finishJob(jobId, sample, token);
      return finishResult(jobId);
    }
    const checker = pending.fpQueue[0];
    const toCheck = pending.disputed.filter((d) => d.source !== checker).map((d) => d.finding);
    if (!toCheck.length) {
      patchJob(jobId, (j) =>
        j.fpPending ? { ...j, fpPending: { ...j.fpPending, fpQueue: j.fpPending.fpQueue.slice(1) }, updatedAt: Date.now() } : j,
      );
      continue;
    }
    if (checker === "local") {
      const prompt = buildFpPrompt({ sample, findings: toCheck, peer: "parallel reviewers" });
      const out = await runLocalLlm(prompt, state.settings);
      let check = null;
      if (out.ok) {
        const gated = gatePeerSubmission(parseChatSubmission(out.raw), sample, state.settings);
        if (gated.ok) check = gated.check;
      }
      const stepped = applyFpStep(pending, checker, check);
      patchJob(jobId, (j) =>
        j.fpPending
          ? {
              ...j,
              fpPending: {
                ...j.fpPending,
                agreed: stepped.agreed,
                disputed: stepped.disputed,
                fpQueue: j.fpPending.fpQueue.slice(1),
                dropped: [...j.fpPending.dropped, ...stepped.dropped],
              },
              findings: [...stepped.agreed, ...stepped.disputed.map((d) => d.finding)],
              plan: `False-positive check: local done. Next: ${pending.fpQueue[1] ?? "post"}.`,
              updatedAt: Date.now(),
            }
          : j,
      );
      continue;
    }
    const prompt = buildFpPrompt({ sample, findings: toCheck, peer: "parallel reviewers" });
    patchJob(jobId, (j) => ({
      ...j,
      status: "awaiting_chat",
      chatFpRound: true,
      fpProviders: [checker],
      chatPrompt: prompt,
      chatPromptByProvider: { [checker]: prompt },
      bridgeClaimedAt: undefined,
      plan: `False-positive check via ${checker} (${toCheck.length} remaining). Order: ${pending.fpQueue.join(" → ")}.`,
      githubError: undefined,
      updatedAt: Date.now(),
    }));
    return { ok: true };
  }
}

async function finishJob(jobId: string, sample: SamplePr | undefined, token?: string) {
  const after = state.jobs.find((j) => j.id === jobId);
  if (!after || after.status === "cancelled" || after.status === "posted") return;
  if (after.origin === "github" && after.status !== "validator" && after.status !== "posting") return;
  const policy = state.settings;
  const publishable = filterPublishable(after, policy, sample);
  const review = buildReview(after, publishable, policy);

  if (!review) {
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "poster: zero findings (precision policy)",
      mergeRecommendation: undefined,
      postedReviewId: undefined,
      updatedAt: Date.now(),
    }));
    return;
  }

  patchJob(jobId, (j) => ({ ...j, status: "posting", updatedAt: Date.now() }));

  let githubId: number | undefined;
  let githubError: string | undefined;
  let postedToGithub = false;
  if (token && after.origin === "github") {
    const still = state.jobs.find((j) => j.id === jobId);
    if (!still || still.status === "cancelled" || still.status === "posted") return;
    try {
      const posted = await createPullReview(token, {
        owner: review.owner,
        repo: review.repo,
        pr: review.pr,
        headSha: review.headSha,
        event: review.event === "APPROVE" ? "COMMENT" : review.event,
        body: review.body,
        comments: review.comments,
      });
      githubId = posted.id;
      postedToGithub = true;
    } catch (e) {
      githubError = e instanceof Error ? e.message.slice(0, 240) : "GitHub Reviews API failed";
      patchJob(jobId, (j) => ({
        ...j,
        status: "dlq",
        skipReason: "GitHub Reviews API failed — not marked posted",
        githubError,
        postedToGithub: false,
        updatedAt: Date.now(),
      }));
      return;
    }
  }

  const stored: PostedReview = { ...review, githubId };
  state = {
    ...state,
    reviews: trim([
      stored,
      ...state.reviews.map((r) =>
        r.owner === review.owner && r.repo === review.repo && r.pr === review.pr && r.headSha === review.headSha
          ? { ...r, dismissed: true }
          : r,
      ),
    ]),
    jobs: state.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            status: "posted" as const,
            postedReviewId: review.id,
            postedToGithub,
            githubError,
            updatedAt: Date.now(),
            mergeRecommendation: review.event,
            findings: publishable.length ? publishable : j.findings,
          }
        : j,
    ),
  };
}

function enqueueFromDecision(
  decision: ReturnType<typeof decideIngress>,
  opts: {
    deliveryId: string;
    trigger: Trigger;
    sample: { owner: string; repo: string; pr: number; title: string; headSha: string; baseSha: string; sender: string; isFork: boolean; isDraft: boolean; key?: string };
    thread?: Job["thread"];
    origin: Job["origin"];
    installationId?: number;
    ingressMs: number;
    eventName: string;
    action: string;
    hmac: "ok" | "fail";
    forceDlq?: boolean;
    untrustedBody?: string;
  },
): HarborFireResult {
  if (!decision.ok) {
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.eventName,
      action: opts.action,
      hmac: "fail",
      httpStatus: 403,
      at: Date.now(),
      summary: `${opts.sample.owner}/${opts.sample.repo}#${opts.sample.pr} rejected`,
      rejectReason: decision.reason,
    };
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 403, reject: decision.reason, queued: false };
  }

  if (decision.skip || !decision.job) {
    const skipJob: Job = {
      deliveryId: opts.deliveryId,
      trigger: opts.trigger,
      owner: opts.sample.owner,
      repo: opts.sample.repo,
      pr: opts.sample.pr,
      title: opts.sample.title,
      headSha: opts.sample.headSha,
      baseSha: opts.sample.baseSha,
      sender: opts.sample.sender,
      isFork: opts.sample.isFork,
      isDraft: opts.sample.isDraft,
      thread: opts.thread,
      sampleKey: opts.sample.key,
      origin: opts.origin,
      installationId: opts.installationId,
      id: nid("job"),
      status: "skipped",
      skipReason: decision.skip ?? "filtered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ingressMs: opts.ingressMs,
      traces: [],
      plan: "",
      candidates: [],
      findings: [],
      investigatedSafe: [],
      assumptions: [],
    };
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.eventName,
      action: opts.action,
      hmac: "ok",
      httpStatus: 202,
      at: Date.now(),
      summary: `${opts.sample.owner}/${opts.sample.repo}#${opts.sample.pr} skipped`,
      skipReason: decision.skip ?? "filtered",
      jobId: skipJob.id,
    };
    state = { ...state, jobs: trim([skipJob, ...state.jobs]), events: trim([ev, ...state.events]) };
    return { httpStatus: 202, skip: decision.skip ?? "filtered", jobId: skipJob.id, queued: false };
  }

  const payload = decision.job;
  const job: Job = {
    ...payload,
    origin: opts.origin,
    installationId: opts.installationId,
    id: nid("job"),
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ingressMs: opts.ingressMs,
    traces: [],
    plan: "",
    candidates: [],
    findings: [],
    investigatedSafe: [],
    assumptions: [],
  };
  const ev: WebhookLog = {
    id: nid("ev"),
    deliveryId: opts.deliveryId,
    event: opts.eventName,
    action: opts.action,
    hmac: "ok",
    httpStatus: 202,
    at: Date.now(),
    summary: `${job.owner}/${job.repo}#${job.pr} ${opts.trigger}`,
    jobId: job.id,
  };
  state = {
    ...state,
    jobs: trim([
      job,
      ...state.jobs.map((j) =>
        j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && isLive(j.status)
          ? { ...j, status: "cancelled" as const, skipReason: `superseded by ${job.id}`, updatedAt: Date.now() }
          : j,
      ),
    ]),
    events: trim([ev, ...state.events]),
  };

  if (opts.origin === "github") void playGithub(job.id, opts.untrustedBody ?? "");
  else void playTape(job.id, { forceDlq: opts.forceDlq });
  return { httpStatus: 202, jobId: job.id, queued: true };
}

export function fireHarbor(opts: HarborFireOpts): HarborFireResult {
  const sample = SAMPLE_PRS[opts.sampleKey];
  if (!sample) return { httpStatus: 403, reject: "unknown sample", queued: false };
  const hmacOk = opts.hmacOk !== false;
  const deliveryId = opts.deliveryId ?? nid("d");
  const t0 = performance.now();
  const decision = decideIngress({
    hmacOk,
    settings: state.settings,
    sample,
    trigger: opts.trigger,
    deliveryId,
    existing: state.jobs,
    knownDeliveries: acceptedDeliveryIds(state.events),
    thread: opts.thread,
  });
  const ingressMs = Math.max(8, performance.now() - t0);
  return enqueueFromDecision(decision, {
    deliveryId,
    trigger: opts.trigger,
    sample,
    thread: opts.thread,
    origin: "tape",
    ingressMs,
    eventName: opts.trigger.split(".")[0],
    action: opts.trigger.split(".")[1] ?? "unknown",
    hmac: hmacOk ? "ok" : "fail",
    forceDlq: opts.forceDlq,
  });
}

export function ingestGitHubWebhook(opts: {
  hmacOk: boolean;
  deliveryId: string;
  event: string;
  payload: unknown;
}): HarborFireResult & { pong?: boolean; ignored?: string } {
  const parsed = parseGitHubPayload(opts.event, opts.payload);
  const t0 = performance.now();

  if (!opts.hmacOk) {
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.event,
      action: "unknown",
      hmac: "fail",
      httpStatus: 403,
      at: Date.now(),
      summary: "GitHub delivery rejected",
      rejectReason: "HMAC mismatch",
    };
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 403, reject: "HMAC mismatch", queued: false };
  }

  if (!parsed.ok) {
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.event,
      action: "unknown",
      hmac: "ok",
      httpStatus: 202,
      at: Date.now(),
      summary: "GitHub delivery skipped",
      skipReason: parsed.reason,
    };
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 202, skip: parsed.reason, queued: false };
  }

  if (parsed.kind === "ping") {
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: "ping",
      action: "ping",
      hmac: "ok",
      httpStatus: 202,
      at: Date.now(),
      summary: "GitHub ping",
    };
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 202, queued: false, pong: true };
  }

  if (parsed.kind === "ignore") {
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.event,
      action: "ignored",
      hmac: "ok",
      httpStatus: 202,
      at: Date.now(),
      summary: `${opts.event} ignored`,
      skipReason: parsed.reason,
    };
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 202, skip: parsed.reason, queued: false, ignored: parsed.reason };
  }

  const ingressMs = Math.max(8, performance.now() - t0);
  const decision = decideIngress({
    hmacOk: true,
    settings: state.settings,
    sample: parsed.target,
    trigger: parsed.trigger,
    deliveryId: opts.deliveryId,
    existing: state.jobs,
    knownDeliveries: acceptedDeliveryIds(state.events),
    thread: parsed.thread,
  });
  return enqueueFromDecision(decision, {
    deliveryId: opts.deliveryId,
    trigger: parsed.trigger,
    sample: parsed.target,
    thread: parsed.thread,
    origin: "github",
    installationId: parsed.installationId,
    ingressMs,
    eventName: opts.event,
    action: parsed.trigger.split(".")[1] ?? "unknown",
    hmac: "ok",
    untrustedBody: parsed.untrustedBody,
  });
}
