import {cancelLocalJsonRepairs} from "./json-repair.server";
import type {RepairReceipt} from "./json-repair-types.ts";
import {recordJobHistory, recordDeliveryHistory, reviewHistory} from "./review-history.server";
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
import { acceptedDeliveryIds, decideIngress, reviewSkipReason, type IngressTarget } from "./ingress";
import { parseGitHubPayload } from "./github-payload";
import { createIssueComment, createPullReview, fetchPullHead, fetchPullSnapshot, formatGithubError, githubReady, installationToken, reactOnDelivery, updateIssueComment, type GithubReaction } from "./github.server";
import { buildChatPrompt, parseChatSubmission, splitChatAttachments } from "./chat-prompt";
import { rankChangedFile } from "./review-budget";
import { runLocalLlm } from "./local-llm.server";
import { buildOpsComment, opsCommentAllowed, reviewPostedNotes, type OpsPhase } from "./ops-comment";
import {
  buildReview,
  filterPublishable,
  gateLiveSubmission,
  isBotMention,
  schemaMergeProviderGates,
  type LiveGateResult,
} from "./poster";
import { sleep } from "./utils";
import { stillRacing, shouldStartLocalRace } from "./local-fallback";
import { buildReviewerLanes } from "./reviewer-progress";
import type { BotSettings, Job, PostedReview, ReviewProvider, SamplePr, Trigger, WebhookLog } from "./types";
import { loadBotSettings, saveBotSettings, sanitizeBotSettings } from "./settings.server";
import {
  BRIDGE_CLAIM_MS,
  LIVE_INFLIGHT_STATUSES,
  isChatProvider,
  normalizeReviewOrder,
  providersFromSettings,
} from "./types";

let seq = 1;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;
const localInFlight = new Set<string>();
const localControllers = new Map<string, AbortController>();

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
  settings: loadBotSettings(),
  jobs: [],
  events: [],
  reviews: [],
};

function isLive(status: Job["status"]) {
  return LIVE_INFLIGHT_STATUSES.includes(status);
}

function trimJobs(jobs: Job[]) {
  // UI retention may drop completed cache entries, never live queue/generation work.
  return [...jobs.filter(j => isLive(j.status)), ...jobs.filter(j => !isLive(j.status)).slice(0, CAP)]
    .sort((a,b) => b.createdAt - a.createdAt);
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

export function lastGithubInstallationId(): number | undefined {
  for (const j of state.jobs) {
    if (j.origin === "github" && j.installationId) return j.installationId;
  }
  return undefined;
}

export function githubStatus() {
  return githubReady();
}

export function patchHarborSettings(patch: Partial<BotSettings>) {
  const next = sanitizeBotSettings({ ...state.settings, ...patch });
  if (!providersFromSettings(next).length) {
    throw new Error("at least one configured reviewer is required");
  }
  const saved = saveBotSettings(next);
  const previousSettings = state.settings;
  state = { ...state, settings: saved };
  if (!saved.localJsonRepairEnabled || previousSettings.localLlmBaseUrl !== saved.localLlmBaseUrl ||
      previousSettings.localLlmModel !== saved.localLlmModel || previousSettings.localLlmApiKey !== saved.localLlmApiKey) {
    cancelLocalJsonRepairs("disabled");
  }
  return state.settings;
}

export function resetHarbor() {
  cancelLocalJsonRepairs("superseded");
  for (const controller of localControllers.values()) controller.abort();
  localControllers.clear();
  localInFlight.clear();
  for (const job of state.jobs) recordJobHistory(isLive(job.status)
    ? {...job, status: "cancelled", skipReason: "operator reset", updatedAt: Date.now()} : job);
  state = { settings: state.settings, jobs: [], events: [], reviews: [] };
}

export function cancelHarborJob(jobId: string) {
  cancelLocalJsonRepairs("superseded", jobId);
  localControllers.get(jobId)?.abort();
  state = {
    ...state,
    jobs: state.jobs.map((j) =>
      j.id === jobId && isLive(j.status)
        ? { ...j, status: "cancelled" as const, skipReason: "cancelled by operator", updatedAt: Date.now() }
        : j,
    ),
  };
  const job=state.jobs.find(j=>j.id===jobId);if(job)recordJobHistory(job);
}

function patchJob(jobId: string, fn: (j: Job) => Job) {
  state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? fn(j) : j)) };
  const job = state.jobs.find(j => j.id === jobId);
  if (job) recordJobHistory(job);
}

export function patchHarborJob(jobId: string, fn: (j: Job) => Job) {
  patchJob(jobId, fn);
}

export function publicJobs(jobs: Job[]) {
  const enabled = providersFromSettings(state.settings);
  return jobs.map((j) => {
    const { chatPrompt: _prompt, chatPromptByProvider: _by, storedLegs: _legs, bridgeLeaseId: _lease, bridgeClientId: _client, coverage: _cov, coverageDeterministic: _covd, promptStats: _ps, ...rest } = j;
    return {
      ...rest,
      reviewerLanes: buildReviewerLanes(j, { localInFlight: localInFlight.has(j.id), enabled }),
    };
  });
}

export function publicSettings(s: BotSettings) {
  return {
    ...s,
    webhookSecret: "",
    localLlmApiKey: "",
    localLlmApiKeySet: Boolean(s.localLlmApiKey),
    webhookSecretSet: Boolean(s.webhookSecret),
  };
}

// WHY: record attachment sizes + deterministic coverage on the job at the single
// prompt-assembly point, measured by attachment name so it stays correct as later
// PRs change the snapshot/policy attachments. Never affects the verdict.
function recordReviewCoverage(jobId: string, prompt: string, sample: SamplePr) {
  const parts = splitChatAttachments(prompt);
  const body = (name: string) => parts.files.find((f) => f.name === name)?.body ?? "";
  const diffBody = body("ashlar-diff.patch");
  const contextBody = body("ashlar-snapshot.md");
  const policyBody = body("ashlar-policy.md");
  const dropped = new Set(sample.diffDroppedPaths ?? []);
  const codePaths = sample.changedPaths.filter((p) => rankChangedFile(p) === 0);
  const coverageDeterministic = codePaths.map((path) => ({
    path,
    inDiff: !dropped.has(path),
    inContext: contextBody.includes(`--- ${path} (`) || contextBody.includes(`--- ${path}\n`),
    reason: dropped.has(path) ? "dropped from diff by prompt budget" : "",
  }));
  const promptStats = {
    diffChars: diffBody.length,
    contextChars: contextBody.length,
    policyChars: policyBody.length,
    diffFilesFull: sample.changedPaths.length - (sample.diffDroppedPaths?.length ?? 0),
    diffFilesTotal: sample.changedPaths.length,
  };
  patchJob(jobId, (j) => ({ ...j, promptStats, coverageDeterministic, updatedAt: Date.now() }));
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

export type ChatLeg = { provider: ReviewProvider; raw: string; originalText?: string; repair?: RepairReceipt };

async function reactQuiet(token: string, job: Job, content: GithubReaction) {
  try {
    await reactOnDelivery(token, job, content);
  } catch {
    /* ack-only; never fail the review on a missing reaction */
  }
}

async function upsertOpsComment(token: string, jobId: string, phase: OpsPhase, notes: string[]) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || job.origin !== "github") return;
  if (!opsCommentAllowed(job)) return;
  const body = buildOpsComment({
    phase,
    providers: job.reviewProviders?.length ? job.reviewProviders : providersFromSettings(state.settings),
    notes: [`Job: ${job.id}`, ...notes],
  });
  try {
    if (job.opsCommentId) {
      await updateIssueComment(token, {
        owner: job.owner,
        repo: job.repo,
        commentId: job.opsCommentId,
        body,
      });
      return;
    }
    const created = await createIssueComment(token, {
      owner: job.owner,
      repo: job.repo,
      pr: job.pr,
      body,
    });
    patchJob(jobId, (j) => ({ ...j, opsCommentId: created.id, updatedAt: Date.now() }));
  } catch {
    /* same as reactions: never fail the review if the status comment cannot post */
  }
}

async function bridgeSnapshot() {
  const { getBridgePublic } = await import("./bridge.server");
  return getBridgePublic();
}

const WATCH_TICK_MS = 5_000;

async function watchReviewers(jobId: string, token: string) {
  let lastNotes = "";
  let localStarted = false;
  for (;;) {
    const bridge = await bridgeSnapshot();
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status === "cancelled" || job.status === "posted" || job.status === "skipped" || job.status === "dlq") return;
    if (job.status !== "awaiting_chat" && job.status !== "reviewer") return;

    const claimed = Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt < BRIDGE_CLAIM_MS);
    const chat = (job.reviewProviders ?? []).filter(isChatProvider);
    const localLeg = (job.storedLegs ?? []).find((l) => l.provider === "local");
    const localSkip = (job.assumptions ?? []).find((a) => a.startsWith("Skipped local"));
    const prompt = job.chatPrompt || job.chatPromptByProvider?.chatgpt || job.chatPromptByProvider?.grok || "";
    if (
      shouldStartLocalRace({
        providers: job.reviewProviders ?? [],
        status: job.status,
        localDone: Boolean(localLeg?.raw.trim() || localSkip),
        localStarted: localStarted || localInFlight.has(jobId),
      })
    ) {
      localStarted = true;
      void kickLocalRace(jobId, prompt);
    }
    const stored = job.storedLegs ?? [];
    const racing = stillRacing({
      providers: job.reviewProviders ?? [],
      payloads: stored.filter((l) => l.raw.trim()).map((l) => l.provider),
      assumptions: job.assumptions,
      localInFlight: localInFlight.has(jobId),
      generating: job.generating,
      providerErrors: job.providerErrors,
      claimed,
      connected: bridge.connected,
    });
    if (job.status === "awaiting_chat" && !racing) {
      const legs = stored.filter((l) => l.raw.trim());
      if (legs.length) await submitHarborChat(jobId, legs[0].raw, legs, { force: true });
      else {
        patchJob(jobId, (j) => ({
          ...j,
          status: "skipped",
          skipReason: "every enabled reviewer finished with no JSON",
          plan: "No reviewer JSON to schema-merge.",
          updatedAt: Date.now(),
        }));
        void upsertOpsComment(token, jobId, "skipped", ["Enabled reviewers finished without JSON. Nothing to post."]);
      }
    }
    if (state.jobs.find(j=>j.id===jobId)?.status !== job.status) continue;
    const lanes = buildReviewerLanes(job, { localInFlight: localInFlight.has(jobId) });
    const notes: string[] = [];
    if (chat.length && !bridge.connected && !claimed) {
      notes.push(
        `Chrome bridge is not connected. ${chat.map((p) => (p === "grok" ? "Grok" : "ChatGPT")).join(" / ")} start when the extension reconnects.`,
      );
    }
    for (const lane of lanes) notes.push(`${lane.label}: ${lane.detail}`);

    const phase: OpsPhase = racing ? (chat.length && !bridge.connected && !claimed ? "blocked" : "running") : "running";
    const key = `${phase}|${notes.join("|")}`;
    if (key !== lastNotes) {
      await upsertOpsComment(token, jobId, phase, notes);
      lastNotes = key;
    }

    await sleep(WATCH_TICK_MS);
  }
}

async function playGithub(jobId: string, untrustedBody: string) {
  const current = () => state.jobs.find((j) => j.id === jobId);
  const live0 = current();
  if (!live0 || live0.status === "cancelled") return;

  patchJob(jobId, (j) => ({ ...j, status: "snapshot", updatedAt: Date.now() }));
  const ready = githubReady();
  if ((!ready.appId && !ready.clientId) || !ready.privateKey || !live0.installationId) {
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
  try {
    token = await installationToken(live0.installationId);
  } catch (e) {
    const msg = formatGithubError(e);
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "GitHub snapshot failed",
      githubError: msg.slice(0, 240),
      updatedAt: Date.now(),
    }));
    return;
  }

  let sample: SamplePr;
  try {
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
    if (!target.headSha || !target.baseSha || typeof target.isFork !== "boolean") {
      const pull = await fetchPullHead(token, live0.owner, live0.repo, live0.pr);
      target = {
        ...target,
        // Resolve provenance without advancing an already-pinned webhook revision.
        headSha: target.headSha || pull.headSha,
        baseSha: target.baseSha || pull.baseSha,
        title: pull.title,
        isDraft: pull.draft,
        isFork: pull.fork,
      };
      patchJob(jobId, (j) => ({
        ...j,
        headSha: target.headSha,
        baseSha: target.baseSha,
        title: pull.title,
        isDraft: pull.draft,
        isFork: pull.fork,
      }));
    }
    // Missing head-repository metadata is unknown, not proof of a trusted head.
    // Fail closed if resolution is still inconclusive, before source I/O or eyes.
    const resolved = current();
    if (!resolved || resolved.status === "cancelled") return;
    const skip = reviewSkipReason({ sample: target, trigger: resolved.trigger, thread: resolved.thread, settings: state.settings });
    if (skip) {
      patchJob(jobId, j => ({ ...j, status: "skipped", skipReason: skip, updatedAt: Date.now() }));
      await upsertOpsComment(token, jobId, "skipped", [`Review not started: ${skip}`]);
      return;
    }
    sample = await fetchPullSnapshot(token, target, { diffMaxChars: state.settings.promptDiffMaxChars });
  } catch (e) {
    const msg = formatGithubError(e);
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "GitHub snapshot failed",
      githubError: msg.slice(0, 240),
      updatedAt: Date.now(),
    }));
    void reactQuiet(token, live0, "confused");
    void upsertOpsComment(token, jobId, "failed", ["Could not load the pull snapshot. No review posted."]);
    return;
  }

  const gated = current();
  if (!gated || gated.status === "cancelled") return;
  // Settings may have changed while snapshot I/O was in flight.
  const skip = reviewSkipReason({ sample: gated, trigger: gated.trigger, thread: gated.thread, settings: state.settings });
  if (skip) {
    patchJob(jobId, j => ({ ...j, status: "skipped", skipReason: skip, updatedAt: Date.now() }));
    await upsertOpsComment(token, jobId, "skipped", [`Review not started: ${skip}`]);
    return;
  }

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
    contextMaxChars: state.settings.promptContextMaxChars,
    contextPadLines: state.settings.contextPadLines,
    policyMaxChars: state.settings.promptPolicyMaxChars,
  });
  recordReviewCoverage(jobId, prompt, sample);
  const order = normalizeReviewOrder(state.settings.reviewOrder);
  const chatProviders = providers.filter(isChatProvider);


  patchJob(jobId, (j) => ({
    ...j,
    status: "awaiting_chat",
    plan: providers.includes("local")
      ? `Snapshot loaded. ${[...chatProviders, "local"].join(" + ")} race in parallel. Schema-merge when each finishes.`
      : chatProviders.length > 1
        ? `Snapshot loaded. ${chatProviders.join(" + ")} race in parallel. Schema-merge when each finishes.`
        : `Snapshot loaded. The Chrome bridge will send this to ${chatProviders[0] ?? "chat"} on this machine.`,
    chatPrompt: prompt,
    reviewProviders: providers,
    reviewOrder: order,
    storedLegs: [],
    updatedAt: Date.now(),
  }));
  // An eyes reaction now means the snapshot passed admission and a job is
  // available to reviewers, not merely that a webhook was received.
  const admitted = current();
  if (admitted) void reactQuiet(token, admitted, "eyes");
  void watchReviewers(jobId, token);
  if (providers.includes("local")) {
    void kickLocalRace(jobId, prompt);
  }
}

/** One in-flight generate per job. playGithub + watch both call this. */
async function kickLocalRace(jobId: string, prompt: string) {
  if (!prompt.trim()) return;
  if (localInFlight.has(jobId)) return;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return;
  if ((job.storedLegs ?? []).some((l) => l.provider === "local" && l.raw.trim())) return;
  if ((job.assumptions ?? []).some((a) => /^Skipped local/i.test(a))) return;
  localInFlight.add(jobId);
  // A health probe can be delayed by the model queue. Never gate generation on that timer.
  const controller = new AbortController();
  localControllers.set(jobId, controller);
  patchJob(jobId, j => ({...j, generating: {...j.generating, local: true}, updatedAt: Date.now()}));
  try {reviewHistory().recordServerStep(jobId,"local.requested");} catch { /* visible history health */ }
  void attachLocalLeg(jobId, prompt, { submit: true });
}

async function attachLocalLeg(jobId: string, prompt: string, opts?: { submit?: boolean }) {
  try {
    const local = await runLocalLlm(prompt, state.settings, localControllers.get(jobId)?.signal);
    try {
      reviewHistory().recordServerStep(jobId,local.ok?"local.response_received":"local.failed");
      if(!local.ok && local.originalText)reviewHistory().recordObservation(jobId,"local",`local:${jobId}`,local.originalText,local.originalText.length,local.originalText.length>128_000);
    } catch { /* metadata storage failure is visible without starting another model */ }
    if (!local.ok) {
      patchJob(jobId, j => j.status !== "awaiting_chat" ? j : ({
        ...j, generating: {...j.generating, local: false},
        providerErrors: {...j.providerErrors, local: {code: "error", message: local.error}},
        assumptions: [...(j.assumptions ?? []), `Skipped local (${local.error})`].slice(0, 12), updatedAt: Date.now(),
      }));
    } else {
      patchJob(jobId, (j) => {
        if (j.status !== "awaiting_chat") return j;
        const next = [...(j.storedLegs ?? []).filter((l) => l.provider !== "local"), { provider: "local" as const, raw: local.raw, originalText: local.originalText }];
        return { ...j, storedLegs: next, generating: {...j.generating, local: false}, updatedAt: Date.now() };
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    patchJob(jobId, j => j.status !== "awaiting_chat" ? j : ({
      ...j, generating: {...j.generating, local: false},
      providerErrors: {...j.providerErrors, local: {code: "error", message: msg.slice(0, 160)}},
      assumptions: [...(j.assumptions ?? []), `Skipped local (${msg.slice(0, 160)})`].slice(0, 12), updatedAt: Date.now(),
    }));
  } finally {
    localInFlight.delete(jobId);
    localControllers.delete(jobId);
    if (opts?.submit) {
      const job = state.jobs.find((j) => j.id === jobId);
      const legs = (job?.storedLegs ?? []).filter((l) => l.raw.trim());
      if (job?.status === "awaiting_chat" && legs.length) {
        await submitHarborChat(jobId, legs[0].raw, legs);
      }
    }
  }
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
  opts?: { force?: boolean },
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
  try {
    reviewHistory().recordJob(job);
    for (const leg of incoming) reviewHistory().recordResponse(jobId,leg.provider,leg.raw,leg.originalText || "");
  } catch {
    // Stored Local legs remain available to the watcher; never repeat generation.
    patchJob(jobId,j=>({...j,githubError:"Response history storage unavailable; result retained for retry"}));
    return {ok:false,error:"Response history storage unavailable; result retained for retry"};
  }
  if (!opts?.force && !job.chatFpRound) {
    const haveLocal = payloads.some((l) => l.provider === "local");
    const haveChat = payloads.some((l) => isChatProvider(l.provider));
    if (
      stillRacing({
        providers,
        payloads: payloads.map((l) => l.provider),
        assumptions: job.assumptions,
        localInFlight: localInFlight.has(jobId),
        generating: job.generating,
        providerErrors: job.providerErrors,
      })
    ) {
      patchJob(jobId, (j) => {
        if (j.status !== "awaiting_chat") return j;
        const next = [...(j.storedLegs ?? [])];
        for (const leg of incoming) {
          const i = next.findIndex((l) => l.provider === leg.provider);
          if (i >= 0) next[i] = leg;
          else next.push(leg);
        }
        return {
          ...j,
          storedLegs: next,
          plan: haveChat && !haveLocal ? "Waiting for remaining racers before schema-merge." : "Waiting for remaining racers before schema-merge.",
          updatedAt: Date.now(),
        };
      });
      return { ok: true };
    }
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
    }, { diffMaxChars: state.settings.promptDiffMaxChars });
  } catch (e) {
    const msg = formatGithubError(e);
    return revert(msg.slice(0, 240));
  }

  const still = state.jobs.find((j) => j.id === jobId);
  if (!still || still.status === "cancelled") {
    return { ok: false, error: "cancelled" };
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
    patchJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: invalid.join("; ") || "no valid review JSON",
      githubError: invalid.join("; ") || "no valid review JSON",
      plan: "Did not post — no reviewer returned valid JSON.",
      updatedAt: Date.now(),
    }));
    return { ok: false, error: invalid.join("; ") || "no valid review JSON" };
  }

  const merged = schemaMergeProviderGates(
    [...byProvider.entries()].map(([provider, gate]) => ({ provider, gate })),
    state.settings,
  );
  // Union model coverage across providers (a file is not_cleared if any provider says so).
  // Coverage + droppedCount never affect the verdict — recorded for the ops comment only.
  const coverageByFile = new Map<string, { file: string; status: "cleared" | "not_cleared"; reason: string }>();
  for (const g of gates) {
    for (const c of g.coverage ?? []) {
      const prev = coverageByFile.get(c.file);
      if (!prev || (prev.status === "cleared" && c.status === "not_cleared")) coverageByFile.set(c.file, c);
    }
  }
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
    coverage: [...coverageByFile.values()],
    droppedCount: gates.reduce((n, g) => n + g.dropped.length, 0),
    plan: `Schema-merged ${[...byProvider.keys()].join(" + ")}.`,
    updatedAt: Date.now(),
  }));
  await finishJob(jobId, sample, token);
  return finishResult(jobId);
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
    if (token) void reactQuiet(token, after, "+1");
    if (token) void upsertOpsComment(token, jobId, "skipped", ["No findings passed the precision policy. No review posted."]);
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
      githubError = formatGithubError(e);
      patchJob(jobId, (j) => ({
        ...j,
        status: "dlq",
        skipReason: "GitHub Reviews API failed — not marked posted",
        githubError,
        postedToGithub: false,
        updatedAt: Date.now(),
      }));
      void reactQuiet(token, after, "confused");
      void upsertOpsComment(token, jobId, "failed", ["GitHub Reviews API failed. Findings were not posted."]);
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
  const finished=state.jobs.find(j=>j.id===jobId);if(finished)recordJobHistory(finished);
  try {reviewHistory().recordReview(stored);} catch { /* storage health remains visible */ }
  if (token) void reactQuiet(token, after, "+1");
  let headMovedTo: string | undefined;
  if (token && after.origin === "github") {
    try {
      const head = await fetchPullHead(token, after.owner, after.repo, after.pr);
      if (head.headSha.slice(0, 7) !== after.headSha.slice(0, 7)) {
        headMovedTo = head.headSha;
        patchJob(jobId, (j) => ({ ...j, headMovedTo: head.headSha, updatedAt: Date.now() }));
      }
    } catch {
      /* ops note is best-effort — never fail the posted review over a HEAD check */
    }
  }
  const postedJob = state.jobs.find((j) => j.id === jobId) ?? after;
  const notes = reviewPostedNotes({ ...postedJob, headMovedTo }, publishable.length);
  if (token) void upsertOpsComment(token, jobId, "posted", notes.length ? notes : ["Review posted."]);
}

function enqueueFromDecision(
  decision: ReturnType<typeof decideIngress>,
  opts: {
    deliveryId: string;
    trigger: Trigger;
    sample: IngressTarget;
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
    recordDeliveryHistory(ev);
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 403, reject: decision.reason, queued: false };
  }

  if (decision.skip || !decision.job) {
    // Ordinary/bot comments and duplicate deliveries are not reviewer executions.
    if (!isBotMention(opts.thread?.userText, state.settings) || /^duplicate delivery_id/.test(decision.skip || "")) {
      const ev: WebhookLog = {id:nid("ev"),deliveryId:opts.deliveryId,event:opts.eventName,action:"ignored",hmac:"ok",
        httpStatus:202,at:Date.now(),summary:`${opts.sample.owner}/${opts.sample.repo}#${opts.sample.pr} ignored`,skipReason:decision.skip || "filtered"};
      recordDeliveryHistory(ev,{owner:opts.sample.owner,repo:opts.sample.repo,pr:opts.sample.pr,commentId:opts.thread?.commentId});
      state={...state,events:trim([ev,...state.events])};
      return {httpStatus:202,skip:decision.skip || "filtered",queued:false};
    }
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
    recordJobHistory(skipJob);
    recordDeliveryHistory(ev,{owner:opts.sample.owner,repo:opts.sample.repo,pr:opts.sample.pr,commentId:opts.thread?.commentId});
    state = { ...state, jobs: trimJobs([skipJob, ...state.jobs]), events: trim([ev, ...state.events]) };
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
    jobs: trimJobs([
      job,
      ...state.jobs.map((j) =>
        j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && isLive(j.status)
          ? { ...j, status: "cancelled" as const, skipReason: `superseded by ${job.id}`, updatedAt: Date.now() }
          : j,
      ),
    ]),
    events: trim([ev, ...state.events]),
  };

  recordDeliveryHistory(ev,{owner:job.owner,repo:job.repo,pr:job.pr,commentId:job.thread?.commentId});
  for (const item of state.jobs) if (item.id === job.id || item.skipReason === `superseded by ${job.id}`) recordJobHistory(item);
  // Supersession is an explicit cancellation, not a timer.
  for (const previous of state.jobs) if (previous.status === "cancelled") localControllers.get(previous.id)?.abort();
  // A superseded job's ops comment keeps its last "running" state and looks stuck
  // forever. Mark those comments terminal so a re-trigger doesn't leave a phantom
  // in-flight review. Best-effort — never blocks or fails the newly enqueued job.
  if (opts.origin === "github" && opts.installationId !== undefined) {
    const installationId = opts.installationId;
    const supersededOps = state.jobs.filter(
      (j) => j.skipReason === `superseded by ${job.id}` && j.origin === "github" && j.opsCommentId,
    );
    if (supersededOps.length) {
      void (async () => {
        try {
          const token = await installationToken(installationId);
          for (const s of supersededOps) {
            await upsertOpsComment(token, s.id, "skipped", ["Superseded by a newer review request."]);
          }
        } catch {
          /* ops comment is best-effort — a stale comment must never fail the new review */
        }
      })();
    }
  }
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
  const parsed = parseGitHubPayload(opts.event, opts.payload, state.settings);
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
    recordDeliveryHistory(ev);
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
    recordDeliveryHistory(ev);
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
    recordDeliveryHistory(ev);
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
    recordDeliveryHistory(ev);
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
