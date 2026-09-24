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
import { createIssueComment, createPullReview, fetchPullHead, fetchPullSnapshot, formatGithubError, getFile, githubReady, installationToken, reactOnDelivery, updateIssueComment, type GithubReaction } from "./github.server";
import { buildChatPrompt, parseChatSubmission, splitChatAttachments } from "./chat-prompt";
import { rankChangedFile } from "./review-budget";
import { runLocalLlm, type LocalLegResult } from "./local-llm.server";
import { requestLocalJson, localStreamingDefault } from "./local-chat-request.server";
import { runLocalReviewLoop, chooseLocalReviewMode } from "./local-review-loop.server";
import { applyLocalActivity, localLegProgress, localLivenessMs, localReviewDeadlineMs, startLocalLeg, type LocalLegActivityKind, type LocalLegState } from "./local-leg-activity";
import { buildOpsComment, opsCommentAllowed, reviewPostedNotes, type OpsPhase } from "./ops-comment";
import {
  buildReview,
  partitionPublishable,
  gateLiveSubmission,
  isBotMention,
  schemaMergeProviderGates,
  type LiveGateResult,
} from "./poster";
import { sleep } from "./utils";
import { chatStalled, heldLocalEvidence, heldLocalReleased, heldLocalSalvage, heldLocalUnusable, localReplies, localVerifies, racingProviders, releaseLocalAsFallback, shouldStartLocalLeg, stillRacing } from "./local-fallback";
import { outcomeNote, reviewOutcome, salvagedReview } from "./review-outcome";
import { createDeliveryClaims } from "./loop-control-claims";
import { buildReviewerLanes, emptyReviewSkip, localLegNote } from "./reviewer-progress";
import type { BotSettings, Job, PostedReview, ReviewProvider, SamplePr, Trigger, WebhookLog } from "./types";
import {
  ashlarBotLogin,
  continueLoopOnPush,
  loopPostedReview,
  loopStartAt,
  startLoop,
  loopEnabled,
  runPostReviewLoop,
  SILENT_REASONS,
  stopLoop,
} from "./review-loop-runtime.server.ts";
import { loadBotSettings, saveBotSettings, sanitizeBotSettings } from "./settings.server";
import { redactSalvagedReviewBody } from "./review-format";
import {
  BRIDGE_CLAIM_MS,
  BRIDGE_CONNECTED_MS,
  LIVE_INFLIGHT_STATUSES,
  isChatProvider,
  normalizeReviewOrder,
  providersFromSettings,
} from "./types";

let seq = 1;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;
const localInFlight = new Set<string>();
const localControllers = new Map<string, AbortController>();
// Live activity of each in-flight local leg (queued at the server vs generating). Fed by the
// transport's streaming heartbeat and the multi-turn loop's turn boundaries; flushed (throttled) into
// the job's providerProgress.local so lanes and the ops comment can tell "waiting behind other jobs"
// from "no sign of life". There is no wall-clock ceiling by default — see localReviewDeadlineMs.
const localActivity = new Map<string, LocalLegState>();
// Per-leg liveness watchdog: reset on every sign of life, fires only after total silence (see
// localLivenessMs). Armed only for streaming legs, which get ~10s keepalives; a buffered leg has no
// incremental signal so it relies on the optional total ceiling instead.
const localLiveness = new Map<string, { reset: () => void; clear: () => void }>();
// In-memory only (never persisted): the snapshot the local multi-turn loop reads files from.
// Kept just for the life of the local leg so the loop's tools serve changed-file content without
// re-fetching the PR. Chat legs never touch this.
const localSamples = new Map<string, SamplePr>();

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
  localSamples.clear();
  localActivity.clear();
  for (const l of localLiveness.values()) l.clear();
  localLiveness.clear();
  for (const job of state.jobs) recordJobHistory(isLive(job.status)
    ? {...job, status: "cancelled", skipReason: "operator reset", updatedAt: Date.now()} : job);
  state = { settings: state.settings, jobs: [], events: [], reviews: [] };
}

export function cancelHarborJob(jobId: string) {
  cancelLocalJsonRepairs("superseded", jobId);
  transitionJob(jobId, (j) =>
    isLive(j.status) ? { ...j, status: "cancelled", skipReason: "cancelled by operator", updatedAt: Date.now() } : j,
  );
}

/** The only writer of an existing job record (resetHarbor drops every job wholesale; a new job is
 * inserted with trimJobs). Every path that ends a job goes through here, so terminal cleanup runs in
 * exactly one place: on the live → terminal edge. Returns the written job. */
function transitionJob(jobId: string, next: (j: Job) => Job): Job | undefined {
  const before = state.jobs.find((j) => j.id === jobId);
  if (!before) return undefined;
  const after = next(before);
  state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? after : j)) };
  recordJobHistory(after);
  if (isLive(before.status) && !isLive(after.status)) releaseTerminalJob(after);
  return after;
}

/** A terminal status is an explicit terminal signal (docs/local-verify-clean.md §3): the job never
 * needs its local snapshot again (a verify-clean job whose local leg never ran would otherwise keep
 * it forever). An in-flight local leg holds its own reference and frees the entry in its finally.
 * Only a cancellation (operator or supersession) stops that leg; a posted or skipped job never
 * aborts local generation. */
function releaseTerminalJob(job: Job) {
  if (!localInFlight.has(job.id)) localSamples.delete(job.id);
  if (job.status !== "cancelled") return;
  localControllers.get(job.id)?.abort();
  localActivity.delete(job.id);
  localLiveness.get(job.id)?.clear();
  localLiveness.delete(job.id);
}

/** Test seam: whether a job still retains its local snapshot. */
export function hasLocalSample(jobId: string): boolean {
  return localSamples.has(jobId);
}

/** Test seam: whether a reviewer watcher is still running for a job. */
export function isWatchingJob(jobId: string): boolean {
  return watching.has(jobId);
}

export function patchHarborJob(jobId: string, fn: (j: Job) => Job) {
  transitionJob(jobId, fn);
}

export function publicJobs(jobs: Job[]) {
  const enabled = providersFromSettings(state.settings);
  return jobs.map((j) => {
    // rawReview is verbatim model output that can echo private PR source — treat it like storedLegs
    // and never expose it on the unauthenticated /api/harbor; surface only a bounded boolean.
    const { chatPrompt: _prompt, chatPromptByProvider: _by, storedLegs: _legs, bridgeLeaseId: _lease, bridgeClientId: _client, coverage: _cov, coverageDeterministic: _covd, promptStats: _ps, rawReview: _raw, ...rest } = j;
    return {
      ...rest,
      hasRawReview: Boolean(j.rawReview),
      reviewerLanes: buildReviewerLanes(j, { localInFlight: localInFlight.has(j.id), enabled, staleMs: localStaleNoteMs() }),
    };
  });
}

/** Reviews for the UNAUTHENTICATED /api/harbor snapshot: strip the verbatim salvaged block from each
 * body (it can echo private PR source). The full body was still posted to the auth-gated GitHub PR. */
export function publicReviews(reviews: PostedReview[]) {
  return reviews.map((r) => ({ ...r, body: redactSalvagedReviewBody(r.body) }));
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
  transitionJob(jobId, (j) => ({ ...j, promptStats, coverageDeterministic, updatedAt: Date.now() }));
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
    transitionJob(jobId, (j) => ({ ...j, status: st, updatedAt: Date.now() }));
  }
  const live = current();
  if (!live || live.status === "cancelled") return;
  if (opts.forceDlq) {
    transitionJob(jobId, (j) => ({
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
    transitionJob(jobId, (j) => ({
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
    transitionJob(jobId, (j) => ({
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
    transitionJob(jobId, (j) => ({
      ...j,
      traces: tracesFor418(now - 420),
      plan: "New invoices route. Confirm auth guard. Findings forbidden until concrete failure.",
      candidates: [],
      findings: [],
      investigatedSafe: ["auth middleware on new route"],
      assumptions: [],
    }));
  } else if (live.sampleKey === "pay-421") {
    transitionJob(jobId, (j) => ({
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

export type ChatLeg = { provider: ReviewProvider; raw: string; originalText?: string; unparsedText?: string; repair?: RepairReceipt };

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
    role: job.localReviewRole,
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
    transitionJob(jobId, (j) => ({ ...j, opsCommentId: created.id, updatedAt: Date.now() }));
  } catch {
    /* same as reactions: never fail the review if the status comment cannot post */
  }
}

async function bridgeSnapshot() {
  const { getBridgePublic } = await import("./bridge.server");
  return getBridgePublic();
}

const WATCH_TICK_MS = 5_000;
// Ceiling for the salvaged verbatim review posted in the body, under GitHub's 65,535-char review
// limit with room for the summary scaffolding. Full originals are retained in review history.
const MAX_RAW_REVIEW_BODY = 60_000;

function localStaleNoteMs(): number {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const raw = env?.ASHLAR_LOCAL_REVIEW_STALE_NOTE_MS;
  if (raw == null || raw === "") return 300_000; // 5 minutes default
  const n = Number(raw);
  return Number.isFinite(n) ? n : 300_000;
}

// One watcher per job. submitHarborChat restarts it when a verify-clean job returns to awaiting_chat
// for its local verification round (the watcher may have exited during the brief validator phase).
const watching = new Set<string>();

async function watchReviewers(jobId: string, token: string) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  try {
    await watchReviewersLoop(jobId, token);
  } finally {
    watching.delete(jobId);
  }
}

async function watchReviewersLoop(jobId: string, token: string) {
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
    const role = job.localReviewRole;
    const localReleased = Boolean(job.localVerifyStartedAt || job.localFallbackAt);
    if (
      shouldStartLocalLeg({
        role,
        providers: job.reviewProviders ?? [],
        localReleased,
        status: job.status,
        localDone: Boolean(localLeg?.raw.trim() || localSkip),
        localStarted: localStarted || localInFlight.has(jobId),
      })
    ) {
      localStarted = true;
      void kickLocalRace(jobId, prompt);
    }
    const stored = job.storedLegs ?? [];
    // verify-clean: a chat leg with no progress while the bridge is offline / never claims the job
    // (a stale `generating` flag from before the bridge went away is not progress).
    const stalled = localVerifies({ role, providers: job.reviewProviders ?? [] }) && chatStalled({
      chatProgress: stored.some((l) => isChatProvider(l.provider) && l.raw.trim()) || (Boolean(bridge.connected) && chat.some((p) => job.generating?.[p])),
      connected: Boolean(bridge.connected),
      disconnectedAt: bridge.disconnectedAt,
      now: Date.now(),
      graceMs: BRIDGE_CONNECTED_MS,
    });
    // Once local runs as that stalled chat's fallback, the job no longer waits on the offline chat leg
    // (it is reported as skipped); a chat result that still arrives first is merged as usual.
    const waitOn = racingProviders({ role, providers: job.reviewProviders ?? [], localReleased });
    const racing = stillRacing({
      providers: stalled && job.localFallbackAt ? waitOn.filter((p) => !isChatProvider(p)) : waitOn,
      payloads: stored.filter((l) => l.raw.trim()).map((l) => l.provider),
      assumptions: job.assumptions,
      localInFlight: localInFlight.has(jobId),
      generating: job.generating,
      providerErrors: job.providerErrors,
      claimed,
      connected: bridge.connected,
    });
    if (
      job.status === "awaiting_chat" &&
      releaseLocalAsFallback({
        role,
        providers: job.reviewProviders ?? [],
        localReleased,
        chatRacing: racing,
        usableChat: stored.some((l) => isChatProvider(l.provider) && l.raw.trim()),
        chatStalled: stalled,
      })
    ) {
      // Chat is down (quota / disconnected / nothing returned): never lose the review — local runs
      // as today's fallback, not as a verifier. Re-check at once only after a real release, so a
      // release that did not apply can never spin this loop without its tick.
      if (releaseHeldLocal(jobId, token, { kind: "fallback" }, "Chat reviewers returned nothing usable; local runs as the fallback.")) continue;
    }
    if (job.status === "awaiting_chat" && !racing) {
      const legs = stored.filter((l) => l.raw.trim());
      if (legs.length) await submitHarborChat(jobId, legs[0].raw, legs, { force: true });
      else {
        // Report the real per-reviewer reason (usage limit / connection / genuinely empty) rather
        // than a blanket "finished without JSON" that hid infra causes like a quota block.
        const skip = emptyReviewSkip(buildReviewerLanes(job, { localInFlight: localInFlight.has(jobId) }));
        transitionJob(jobId, (j) => ({
          ...j,
          status: "skipped",
          skipReason: skip.skipReason,
          plan: "No reviewer JSON to schema-merge.",
          updatedAt: Date.now(),
        }));
        void upsertOpsComment(token, jobId, "skipped", skip.ops);
      }
    }
    if (state.jobs.find(j=>j.id===jobId)?.status !== job.status) continue;
    const lanes = buildReviewerLanes(job, { localInFlight: localInFlight.has(jobId), staleMs: localStaleNoteMs() });
    const notes: string[] = [];
    if (chat.length && !bridge.connected && !claimed) {
      notes.push(
        `Chrome bridge is not connected. ${chat.map((p) => (p === "grok" ? "Grok" : "ChatGPT")).join(" / ")} start when the extension reconnects.`,
      );
    }
    // Local leg visibility (never auto-abort): queued at the server vs generating vs no sign of
    // life. Stable state text only — a live age would rewrite the GitHub ops comment every tick.
    if (localInFlight.has(jobId) || job.generating?.local === true) {
      const note = localLegNote(job.providerProgress?.local, Date.now(), localStaleNoteMs());
      if (note) notes.push(note);
    }
    if (job.localVerifyStartedAt) notes.push("Chat review found nothing; the local LLM is verifying before the review posts.");
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

  transitionJob(jobId, (j) => ({ ...j, status: "snapshot", updatedAt: Date.now() }));
  const ready = githubReady();
  if ((!ready.appId && !ready.clientId) || !ready.privateKey || !live0.installationId) {
    transitionJob(jobId, (j) => ({
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
    transitionJob(jobId, (j) => ({
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
      transitionJob(jobId, (j) => ({
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
      transitionJob(jobId, j => ({ ...j, status: "skipped", skipReason: skip, updatedAt: Date.now() }));
      await upsertOpsComment(token, jobId, "skipped", [`Review not started: ${skip}`]);
      return;
    }
    sample = await fetchPullSnapshot(token, target, { diffMaxChars: state.settings.promptDiffMaxChars });
  } catch (e) {
    const msg = formatGithubError(e);
    transitionJob(jobId, (j) => ({
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
    transitionJob(jobId, j => ({ ...j, status: "skipped", skipReason: skip, updatedAt: Date.now() }));
    await upsertOpsComment(token, jobId, "skipped", [`Review not started: ${skip}`]);
    return;
  }

  const providers = providersFromSettings(state.settings);
  if (!providers.length) {
    transitionJob(jobId, (j) => ({
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
  // Pinned once here like reviewProviders: a later settings change never alters a review in flight.
  const localReviewRole = state.settings.localReviewRole ?? "race";
  const verifier = localVerifies({ role: localReviewRole, providers });


  transitionJob(jobId, (j) => ({
    ...j,
    status: "awaiting_chat",
    plan: verifier
      ? `Snapshot loaded. ${chatProviders.join(" + ")} review first; local verifies a clean result.`
      : providers.includes("local")
      ? `Snapshot loaded. ${[...chatProviders, "local"].join(" + ")} race in parallel. Schema-merge when each finishes.`
      : chatProviders.length > 1
        ? `Snapshot loaded. ${chatProviders.join(" + ")} race in parallel. Schema-merge when each finishes.`
        : `Snapshot loaded. The Chrome bridge will send this to ${chatProviders[0] ?? "chat"} on this machine.`,
    chatPrompt: prompt,
    reviewProviders: providers,
    localReviewRole,
    localVerifyStartedAt: undefined,
    localFallbackAt: undefined,
    localVerifyNote: undefined,
    localVerified: undefined,
    reviewOrder: order,
    storedLegs: [],
    updatedAt: Date.now(),
  }));
  // An eyes reaction now means the snapshot passed admission and a job is
  // available to reviewers, not merely that a webhook was received.
  const admitted = current();
  if (admitted) void reactQuiet(token, admitted, "eyes");
  // A fresh human start directive whose review is ADMITTED is recorded as the loop start (the
  // durable start event — review-loop.ts startComment), long before its review can finish.
  if (admitted?.origin === "github" && admitted.thread?.loop?.kind === "start") recordLoopStart(token, admitted);
  void watchReviewers(jobId, token);
  if (providers.includes("local")) {
    // The loop reads files from this snapshot; harmless for single-turn mode (unused there).
    localSamples.set(jobId, sample);
    // verify-clean: no local generation now; submitHarborChat starts it only after a clean chat result.
    if (!verifier) void kickLocalRace(jobId, prompt);
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
  // The leg starts "queued": nothing has been sent yet, and on a concurrency-1 server the request
  // then waits behind other jobs. The transport's heartbeat (headers / empty chunks) keeps it alive
  // in that state; the first output token flips it to generating (see noteLocalActivity).
  const startedAt = Date.now();
  const leg = startLocalLeg(startedAt);
  localActivity.set(jobId, leg);
  transitionJob(jobId, j => ({...j, generating: {...j.generating, local: true},
    providerProgress: {...j.providerProgress, local: localLegProgress(leg, `local:${jobId}`, startedAt)},
    updatedAt: startedAt}));
  try {reviewHistory().recordServerStep(jobId,"local.requested");} catch { /* visible history health */ }
  void attachLocalLeg(jobId, prompt, { submit: true });
}

/** Feed one activity observation into the leg's tracker and flush it (throttled) to the job. The
 * first server acceptance and the first output token are also recorded as history steps, so a
 * post-mortem can tell "never accepted", "accepted but never generated" and "generated" apart. */
function noteLocalActivity(jobId: string, kind: LocalLegActivityKind) {
  localLiveness.get(jobId)?.reset(); // any sign of life defers the hung-server abort
  const prev = localActivity.get(jobId);
  if (!prev) return;
  const now = Date.now();
  const next = applyLocalActivity(prev, kind, now);
  localActivity.set(jobId, next.state);
  if (next.accepted) { try { reviewHistory().recordServerStep(jobId, "local.accepted"); } catch { /* visible history health */ } }
  if (next.generated) { try { reviewHistory().recordServerStep(jobId, "local.generating"); } catch { /* visible history health */ } }
  if (!next.flush) return;
  transitionJob(jobId, j => j.status !== "awaiting_chat" ? j : ({
    ...j,
    providerProgress: { ...j.providerProgress, local: localLegProgress(next.state, `local:${jobId}`, now) },
  }));
}

// Bounds on-demand cross-file reads by the multi-turn loop, per leg. Generous enough to walk a few
// import hops (helper + entity + enum) while preventing a runaway model from fanning out over the repo.
const HEAD_FETCH_CAP = 40;
// A per-leg reader the loop's file_read tool uses for paths outside the snapshot. Returns undefined for
// non-GitHub jobs (demo/sample) so those stay snapshot-only. The installation token is minted at most
// once per leg (lazily), results are cached, and the fetch count is capped.
function makeHeadReader(job: Job | undefined): ((path: string) => Promise<string | null>) | undefined {
  if (!job || job.origin !== "github" || job.installationId == null || !job.headSha) return undefined;
  const { owner, repo, headSha, installationId } = job;
  const cache = new Map<string, string | null>();
  let tokenPromise: Promise<string> | null = null;
  let fetched = 0;
  return async (path: string): Promise<string | null> => {
    if (cache.has(path)) return cache.get(path) ?? null;
    if (fetched >= HEAD_FETCH_CAP) return null;
    fetched += 1;
    try {
      tokenPromise ??= installationToken(installationId);
      const content = await getFile(await tokenPromise, owner, repo, path, headSha);
      cache.set(path, content);
      return content;
    } catch {
      cache.set(path, null); // a failed fetch is cached as absent so one bad path is not retried
      return null;
    }
  };
}

// Picks the local path by settings: multiturn runs the SDK tool loop over the fetched snapshot
// (peers already stored on the job are injected as data each turn, never waited on); single and auto
// (auto = single for a PR that fits one completion window) use the one-shot prompt. A missing
// snapshot (e.g. a late bridge-fallback kick after restart) also falls back to single. Either way the
// result is one local leg for the unchanged schema-merge.
async function generateLocalLeg(
  jobId: string,
  prompt: string,
): Promise<LocalLegResult> {
  const signal = localControllers.get(jobId)?.signal;
  const sample = localSamples.get(jobId);
  const job = state.jobs.find((j) => j.id === jobId);
  const mode = chooseLocalReviewMode(state.settings.localReviewMode, prompt.length, state.settings.localReviewSingleTurnMaxTokens);
  if (mode === "multiturn" && sample) {
    return runLocalReviewLoop(sample, state.settings, {
      signal,
      // The multi-turn loop's edge over the one-shot chat legs: it can pull ANY file at the PR head
      // on demand (an imported helper/entity in an unchanged module the snapshot never captured) to
      // verify a semantic assumption before reporting. Bounded per leg (see makeHeadReader).
      readFileAtHead: makeHeadReader(job),
      extra: job?.thread?.userText ?? "",
      peerReported: () =>
        (state.jobs.find((j) => j.id === jobId)?.storedLegs ?? [])
          .filter((l) => l.provider !== "local" && l.raw.trim())
          .map((l) => ({ provider: l.provider, raw: l.raw })),
      // Per-token heartbeat from the wire: queued (server alive, nothing for us yet) vs generating.
      request: (base, key, path, body, sig) =>
        requestLocalJson(base, key, path, body, sig, { onActivity: (a) => noteLocalActivity(jobId, a.kind) }),
      // Turn boundaries: a completed tool round is real progress; the next request starts queued again.
      onProgress: (p) => noteLocalActivity(jobId, p.stage === "tool" ? "output" : "turn"),
    });
  }
  // multiturn was chosen (a large PR) but the snapshot is gone (e.g. a late bridge-fallback kick
  // after a restart). Falling back to single-turn would send the whole large prompt in one completion
  // and spike memory — exactly what auto-mode routes away from. Skip local instead.
  if (mode === "multiturn") {
    return { ok: false, error: "local skipped: no snapshot for multiturn and prompt too large for single-turn" };
  }
  return runLocalLlm(prompt, state.settings, signal, { onActivity: (a) => noteLocalActivity(jobId, a.kind) });
}

/** Store the local leg's payload on the job (replacing any earlier one) and mark it collected. */
function collectLocalLeg(j: Job, raw: string, originalText?: string, unparsedText?: string): Job {
  const next = [...(j.storedLegs ?? []).filter((l) => l.provider !== "local"), { provider: "local" as const, raw, originalText, unparsedText }];
  return { ...j, storedLegs: next, generating: {...j.generating, local: false}, providerProgress: {...j.providerProgress, local: {runId: `local:${j.id}`, stage: "response_collected", observedAt: Date.now(), receivedAt: Date.now()}}, updatedAt: Date.now() };
}

async function attachLocalLeg(jobId: string, prompt: string, opts?: { submit?: boolean }) {
  // Two independent, both-optional aborts; neither fires for a healthy long review. Both honour the
  // signal, so the leg falls into the catch below and fails cleanly. Cleared in finally on settle.
  //
  // 1. Liveness (default 10 min, streaming only): abort after TOTAL silence — no headers, no keepalive,
  //    no token — for the window. Reset by noteLocalActivity on every sign of life, and the server
  //    keepalives ~every 10s while queued or generating, so an hours-long queue is never touched; only
  //    a genuinely wedged server trips it. This is what unblocks a finished peer review that would
  //    otherwise wait forever on the in-flight local leg (stillRacing). A buffered leg has no
  //    incremental signal, so liveness is armed only when streaming is on; it relies on the ceiling.
  // 2. Total ceiling (ASHLAR_LOCAL_REVIEW_DEADLINE_MS; off by default): a hard wall-clock cap for
  //    operators who want one, independent of activity.
  const livenessMs = localStreamingDefault() ? localLivenessMs() : 0;
  if (livenessMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => localControllers.get(jobId)?.abort(new Error(`local review: no response from the model server for ${Math.round(livenessMs / 60_000)} min (ASHLAR_LOCAL_REVIEW_LIVENESS_MS)`));
    const arm = () => { timer = setTimeout(fire, livenessMs); };
    arm();
    localLiveness.set(jobId, { reset: () => { if (timer) clearTimeout(timer); arm(); }, clear: () => { if (timer) clearTimeout(timer); } });
  }
  const deadlineMs = localReviewDeadlineMs();
  const deadline = deadlineMs > 0
    ? setTimeout(
      () => localControllers.get(jobId)?.abort(new Error(`local review exceeded the ${Math.round(deadlineMs / 60_000)} min ASHLAR_LOCAL_REVIEW_DEADLINE_MS ceiling`)),
      deadlineMs,
    )
    : undefined;
  try {
    const local = await generateLocalLeg(jobId, prompt);
    try {
      reviewHistory().recordServerStep(jobId,local.ok?"local.response_received":"local.failed");
      // Every completed reply that was not review JSON is archived, including one a later reply replaced.
      const unparsed = local.ok ? local.unparsedText?.trim() : localReplies(local);
      if(unparsed)reviewHistory().recordObservation(jobId,"local",`local:${jobId}`,unparsed,unparsed.length,unparsed.length>128_000);
    } catch { /* metadata storage failure is visible without starting another model */ }
    if (!local.ok) {
      transitionJob(jobId, (j) => {
        if (j.status !== "awaiting_chat") return j;
        // A released held leg's completed non-JSON reply is evidence: kept as a salvaged leg.
        const salvage = heldLocalSalvage(j, local);
        if (salvage) return collectLocalLeg(j, salvage, localReplies(local));
        return {
          ...j, generating: {...j.generating, local: false},
          providerErrors: {...j.providerErrors, local: {code: "error", message: local.error}},
          providerProgress: {...j.providerProgress, local: {runId: `local:${jobId}`, stage: "error", observedAt: Date.now(), receivedAt: Date.now()}},
          assumptions: [...(j.assumptions ?? []), `Skipped local (${local.error})`].slice(0, 12), updatedAt: Date.now(),
        };
      });
    } else {
      transitionJob(jobId, (j) => (j.status !== "awaiting_chat" ? j : collectLocalLeg(j, local.raw, local.originalText, local.unparsedText)));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    transitionJob(jobId, j => j.status !== "awaiting_chat" ? j : ({
      ...j, generating: {...j.generating, local: false},
      providerErrors: {...j.providerErrors, local: {code: "error", message: msg.slice(0, 160)}},
      providerProgress: {...j.providerProgress, local: {runId: `local:${jobId}`, stage: "error", observedAt: Date.now(), receivedAt: Date.now()}},
      assumptions: [...(j.assumptions ?? []), `Skipped local (${msg.slice(0, 160)})`].slice(0, 12), updatedAt: Date.now(),
    }));
  } finally {
    if (deadline) clearTimeout(deadline);
    localLiveness.get(jobId)?.clear();
    localLiveness.delete(jobId);
    localInFlight.delete(jobId);
    localControllers.delete(jobId);
    localSamples.delete(jobId);
    localActivity.delete(jobId);
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
  // The role pinned at snapshot (never live settings); an FP round always merges as today.
  const role = job.chatFpRound ? "race" : job.localReviewRole;
  const localReleased = Boolean(job.localVerifyStartedAt || job.localFallbackAt);
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
    transitionJob(jobId,j=>({...j,githubError:"Response history storage unavailable; result retained for retry"}));
    return {ok:false,error:"Response history storage unavailable; result retained for retry"};
  }
  if (!opts?.force && !job.chatFpRound) {
    const haveLocal = payloads.some((l) => l.provider === "local");
    const haveChat = payloads.some((l) => isChatProvider(l.provider));
    if (
      stillRacing({
        providers: racingProviders({ role, providers, localReleased }),
        payloads: payloads.map((l) => l.provider),
        assumptions: job.assumptions,
        localInFlight: localInFlight.has(jobId),
        generating: job.generating,
        providerErrors: job.providerErrors,
      })
    ) {
      transitionJob(jobId, (j) => {
        if (j.status !== "awaiting_chat") return j;
        return {
          ...j,
          storedLegs: upsertLegs(j.storedLegs, incoming),
          plan: haveChat && !haveLocal ? "Waiting for remaining racers before schema-merge." : "Waiting for remaining racers before schema-merge.",
          updatedAt: Date.now(),
        };
      });
      return { ok: true };
    }
  }
  // A verifier local leg that was held back (chat had findings) or whose verification did not
  // complete is not a "skipped reviewer": the latter is reported by the verify note instead.
  const verifierLocal = localVerifies({ role, providers }) && !job.localFallbackAt;
  const skipped = providers.filter(
    (p) => !payloads.some((l) => l.provider === p) && !(job.chatFpRound && p === "local") && !(verifierLocal && p === "local"),
  );

  let locked = false;
  transitionJob(jobId, (j) => {
    if (j.status !== "awaiting_chat") return j;
    locked = true;
    return { ...j, status: "validator", updatedAt: Date.now() };
  });
  if (!locked) return { ok: false, error: "job is not waiting for a chat review" };

  const revert = (error: string) => {
    transitionJob(jobId, (j) =>
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
  const heldLocal = !job.chatFpRound && heldLocalReleased(job);
  let localUnusable: string | undefined;
  for (const leg of payloads) {
    const { gate, unusable } = gateLeg(leg, sample, heldLocal);
    if (unusable) localUnusable = unusable;
    if (!gate.ok) {
      invalid.push(`${leg.provider}: ${gate.reason}`);
      continue;
    }
    gates.push(gate);
    byProvider.set(leg.provider, gate);
  }

  if (!gates.length && releaseLocalAsFallback({ role, providers, localReleased, chatRacing: false, usableChat: false })) {
    // verify-clean, chat returned no valid JSON: local runs as today's fallback instead of a skip.
    releaseHeldLocal(jobId, token, { kind: "fallback" }, "Chat reviewers returned no valid JSON; local runs as the fallback.", incoming);
    return { ok: true };
  }
  if (!gates.length) {
    transitionJob(jobId, (j) => ({
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
  // Verbatim reply(ies) from any leg whose JSON could not be parsed — surfaced in the review body so
  // the fixing agent can act instead of the job pending forever. Every leg's salvaged reply is
  // combined, a verifier's included: no review is silently discarded.
  const rawReview = salvagedReview([...byProvider].map(([provider, g]) => ({ provider, rawReview: g.rawReview })), MAX_RAW_REVIEW_BODY);
  // Only a STRUCTURED result counts: a leg salvaged as raw text (unparseable) produced no verdict.
  // That decides both whether local verified and which chat reviewers were clean.
  const structured = [...byProvider.entries()].filter(([, g]) => !g.rawReview).map(([p]) => p);
  const verifying = Boolean(job.localVerifyStartedAt) && !job.localFallbackAt;
  const localVerified = verifying ? structured.includes("local") : undefined;
  const nextAssumptions = [
    skipped.length ? `Skipped ${skipped.join(", ")} (quota or unavailable)` : "",
    ...invalid,
    localUnusable ? `local: ${localUnusable} (reply posted verbatim)` : "",
    ...merged.assumptions,
  ].filter(Boolean);
  // merged.findings is already publish-gated (gateLiveSubmission applies the poster's partition with
  // the same settings), so this count is the one the posted body renders.
  const outcome = reviewOutcome({ ...job, rawReview, localVerified, assumptions: nextAssumptions }, merged.findings.length);
  // Credit only the chat reviewers that produced the clean structured result (pinned when the
  // verification round starts): a skipped or failed chat reviewer found nothing only by absence.
  const cleanChat = job.localVerifyChat ?? structured.filter(isChatProvider);
  if (outcome === "verify") {
    // Chat parsed clean: hold the post and run local on the same prompt as the verification round.
    const plan = `${cleanChat.join(" + ") || "chat"} found nothing; local verification round running.`;
    releaseHeldLocal(jobId, token, { kind: "verify", verifyChat: cleanChat }, plan, incoming);
    return { ok: true };
  }
  const localError =
    localUnusable ||
    (job.assumptions ?? []).find((a) => /^Skipped local/i.test(a))?.replace(/^Skipped local\s*\(?/i, "").replace(/\)$/, "") ||
    invalid.find((s) => s.startsWith("local:"))?.slice("local:".length).trim() ||
    (byProvider.get("local")?.rawReview ? "not review JSON" : undefined);
  const localVerifyNote = outcomeNote(outcome, { chat: cleanChat, verifying, findings: merged.findings.length, localError, localVerified });
  transitionJob(jobId, (j) => ({
    ...j,
    findings: merged.findings,
    candidates: merged.findings,
    mergeRecommendation: merged.mergeRecommendation,
    highestRisk: merged.highestRisk,
    rawReview,
    investigatedSafe: merged.investigatedSafe,
    assumptions: nextAssumptions,
    coverage: [...coverageByFile.values()],
    droppedCount: gates.reduce((n, g) => n + g.dropped.length, 0),
    plan: `Schema-merged ${[...byProvider.keys()].join(" + ")}.`,
    localVerifyNote: localVerifyNote || undefined,
    localVerified,
    updatedAt: Date.now(),
  }));
  await finishJob(jobId, sample, token);
  return finishResult(jobId);
}

/** Gate one reviewer leg. A released held local leg whose reply is not a verdict (docs §1: it failed
 * the gate, the gate dropped a finding it reported, or it took a reply that was not review JSON to
 * get there) is gated as evidence instead: its complete text posts verbatim, so it never counts as
 * verification and nothing it reported is lost. */
function gateLeg(leg: ChatLeg, sample: SamplePr, heldLocal: boolean): { gate: ReturnType<typeof gateLiveSubmission>; unusable?: string } {
  const parsed = parseChatSubmission(leg.raw);
  const gate = gateLiveSubmission(parsed, sample, state.settings);
  const unusable = heldLocal && leg.provider === "local" ? heldLocalUnusable(gate, leg) : undefined;
  return unusable ? { gate: gateLiveSubmission(heldLocalEvidence(parsed, leg), sample, state.settings), unusable } : { gate };
}

type HeldLocalRelease = { kind: "verify"; verifyChat: ReviewProvider[] } | { kind: "fallback" };

/** verify-clean: the single release point of a held local leg, called only on an explicit terminal
 * signal of the chat round (docs/local-verify-clean.md §2): a clean structured chat result starts
 * the verification round; chat finishing with nothing usable, or a bridge disconnected past its
 * grace, starts the fallback. It releases once (a stamp is set), returns the job to awaiting_chat
 * with the chat legs kept, starts local and makes sure a watcher waits for it. */
function releaseHeldLocal(jobId: string, token: string, release: HeldLocalRelease, plan: string, legs: ChatLeg[] = []): boolean {
  let released = false;
  const job = transitionJob(jobId, (j) => {
    if ((j.status !== "validator" && j.status !== "awaiting_chat") || j.localVerifyStartedAt || j.localFallbackAt) return j;
    released = true;
    const stamp = release.kind === "verify"
      ? { localVerifyStartedAt: Date.now(), localVerifyChat: release.verifyChat }
      : { localFallbackAt: Date.now() };
    return { ...j, ...stamp, status: "awaiting_chat", storedLegs: upsertLegs(j.storedLegs, legs), plan, updatedAt: Date.now() };
  });
  if (!released || !job) return false;
  void kickLocalRace(jobId, job.chatPrompt || job.chatPromptByProvider?.chatgpt || job.chatPromptByProvider?.grok || "");
  void watchReviewers(jobId, token);
  return true;
}

/** Store incoming legs over the stored ones, one per provider (a newer leg replaces an older one). */
function upsertLegs(stored: Job["storedLegs"], incoming: ChatLeg[]): NonNullable<Job["storedLegs"]> {
  const next = [...(stored ?? [])];
  for (const leg of incoming) {
    const i = next.findIndex((l) => l.provider === leg.provider);
    if (i >= 0) next[i] = leg;
    else next.push(leg);
  }
  return next;
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
  const { inline, unanchored } = partitionPublishable(after, policy, sample);
  const review = buildReview(after, inline, unanchored, policy);

  if (!review) {
    transitionJob(jobId, (j) => ({
      ...j,
      status: "skipped",
      skipReason: "poster: zero findings (precision policy)",
      mergeRecommendation: undefined,
      postedReviewId: undefined,
      updatedAt: Date.now(),
    }));
    if (token) void reactQuiet(token, after, "+1");
    if (token) void upsertOpsComment(token, jobId, "skipped", [after.localVerifyNote ?? "", "No findings passed the precision policy. No review posted."].filter(Boolean));
    return;
  }

  transitionJob(jobId, (j) => ({ ...j, status: "posting", updatedAt: Date.now() }));

  let githubId: number | undefined;
  let githubError: string | undefined;
  let postedToGithub = false;
  let inlineDropped = false;
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
      inlineDropped = posted.inlineDropped;
      postedToGithub = true;
    } catch (e) {
      githubError = formatGithubError(e);
      transitionJob(jobId, (j) => ({
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

  // Record what GitHub accepted: after a refused inline anchor the review went out with none.
  const stored: PostedReview = { ...review, githubId, ...(inlineDropped ? { comments: [] } : {}) };
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
  };
  transitionJob(jobId, (j) => ({
    ...j,
    status: "posted",
    postedReviewId: review.id,
    postedToGithub,
    githubError,
    updatedAt: Date.now(),
    mergeRecommendation: review.event,
  }));
  try {reviewHistory().recordReview(stored);} catch { /* storage health remains visible */ }
  if (token) void reactQuiet(token, after, "+1");
  let headMovedTo: string | undefined;
  if (token && after.origin === "github") {
    try {
      const head = await fetchPullHead(token, after.owner, after.repo, after.pr);
      if (head.headSha.slice(0, 7) !== after.headSha.slice(0, 7)) {
        headMovedTo = head.headSha;
        transitionJob(jobId, (j) => ({ ...j, headMovedTo: head.headSha, updatedAt: Date.now() }));
      }
    } catch {
      /* ops note is best-effort — never fail the posted review over a HEAD check */
    }
  }
  const postedJob = state.jobs.find((j) => j.id === jobId) ?? after;
  const notes = reviewPostedNotes({ ...postedJob, headMovedTo }, inline.length + unanchored.length, unanchored.length);
  if (postedJob.localVerifyNote) notes.unshift(postedJob.localVerifyNote);
  if (token) void upsertOpsComment(token, jobId, "posted", notes.length ? notes : ["Review posted."]);
  // Review-loop step (design §5 4–8): gated OFF by default (ASHLAR_FIX_AGENT + fixAgent.provider,
  // and only for /review-loop-triggered reviews). Best-effort — never un-posts the review.
  // Never start a fix round on a stale head: a commit parented on the reviewed SHA would
  // fast-forward over (and undo) a contributor's backward force-push. The runtime re-checks
  // the live head right before committing as well.
  if (token && postedToGithub && !headMovedTo) {
    const posted = loopPostedReview({ githubId, comments: review.comments, inline, unanchored, inlineDropped });
    void runPostReviewLoop(token, postedJob, sample, state.settings, undefined, undefined, posted).then((r) => {
      // The runtime reports halts in-thread; also leave a server-side trace so nothing is lost.
      if (!r.ran && !SILENT_REASONS.includes(r.reason)) {
        console.warn(`[review-loop] ${jobId}: ${r.reason}`);
      }
    });
  }
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
  // Supersession is an explicit cancellation, not a timer: each live job for the same PR ends through
  // transitionJob, which aborts its local leg and frees its snapshot.
  const superseded = state.jobs
    .filter((j) => j.owner === job.owner && j.repo === job.repo && j.pr === job.pr && isLive(j.status))
    .map((j) => j.id);
  for (const id of superseded) {
    transitionJob(id, (j) => ({ ...j, status: "cancelled", skipReason: `superseded by ${job.id}`, updatedAt: Date.now() }));
  }
  state = { ...state, jobs: trimJobs([job, ...state.jobs]), events: trim([ev, ...state.events]) };

  recordDeliveryHistory(ev,{owner:job.owner,repo:job.repo,pr:job.pr,commentId:job.thread?.commentId});
  recordJobHistory(job);
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

/**
 * Review-loop PR state (design §5/§11), gated OFF unless the fix agent is enabled: a push to a
 * PR with an ACTIVE loop session continues the loop (next review on the pushed head); a human
 * stop directive ends it — live loop reviews are cancelled and the fixed STOPPED marker is
 * posted once. Fire-and-forget; a redelivered webhook never repeats the side effect.
 */
function recordLoopStart(token: string, job: Job): void {
  // Same gate as applyLoopControl: with the fix agent off, a start is never recorded (a record
  // written now would become a live session anchor once the agent is enabled).
  if (!loopEnabled(state.settings) || job.thread?.loop?.kind !== "start") return;
  const start = { owner: job.owner, repo: job.repo, pr: job.pr, actor: job.sender, mode: job.thread.loop.mode, at: loopStartAt(job) };
  void startLoop(token, start, state.settings).then(
    (r) => {
      if (!r.posted && /failed/.test(r.reason)) console.warn(`[review-loop] start ${job.owner}/${job.repo}#${job.pr}: ${r.reason}`);
    },
    (e) => console.warn(`[review-loop] start ${job.owner}/${job.repo}#${job.pr}: ${formatGithubError(e)}`),
  );
}

// Loop control claims each delivery before its side effect (loop-control-claims.ts). The claim is
// the ONLY redelivery guard: the same delivery may also leave a job or a 202 "ignored" event, and
// checking those would shadow a claim released after a failed attempt, so the retry GitHub
// redelivers would never run. A redelivery after a restart (empty claims) re-runs an idempotent step.
const loopControlClaims = createDeliveryClaims();

function applyLoopControl(parsed: Extract<ReturnType<typeof parseGitHubPayload>, { kind: "review" }>, deliveryId: string) {
  if (!loopEnabled(state.settings) || parsed.installationId === undefined) return;
  if (!loopControlClaims.claim(deliveryId)) return;
  const installationId = parsed.installationId;
  const { owner, repo, pr, headSha } = parsed.target;
  const run = (label: string, step: (token: string) => Promise<{ posted: boolean; reason: string }>) => {
    void (async () => {
      try {
        const r = await step(await installationToken(installationId));
        if (!r.posted && /failed|in flight/.test(r.reason)) {
          loopControlClaims.release(deliveryId); // a redelivery may retry what did not land
          if (/failed/.test(r.reason)) console.warn(`[review-loop] ${label}: ${r.reason}`);
        }
      } catch (e) {
        loopControlClaims.release(deliveryId);
        console.warn(`[review-loop] ${label}: ${formatGithubError(e)}`);
      }
    })();
  };
  if (parsed.trigger === "pull_request.synchronize") {
    run(`continue ${owner}/${repo}#${pr}`, (token) =>
      continueLoopOnPush(token, { owner, repo, pr, headSha, actor: parsed.actor, pushedAt: parsed.eventAt }, state.settings));
  } else if (parsed.thread?.loop?.kind === "stop") {
    // Cancel the LOOP's own review work: jobs a loop directive or the driver's continuation
    // requested. A plain review a human explicitly asked for still runs and posts — it cannot fix
    // or continue anything, since its loop step finds the session ended by this stop. A live
    // loop-start review means its start record may still land (with an earlier time): the stop is
    // then recorded even if it ends nothing yet.
    let startInFlight = false;
    for (const j of state.jobs) {
      if (j.owner === owner && j.repo === repo && j.pr === pr && isLive(j.status) && j.thread?.loop?.kind === "start") {
        startInFlight = true;
        cancelHarborJob(j.id);
      }
    }
    run(`stop ${owner}/${repo}#${pr}`, (token) =>
      stopLoop(token, { owner, repo, pr, actor: parsed.actor, stopAt: parsed.eventAt, startInFlight }, state.settings));
  }
}

export function ingestGitHubWebhook(opts: {
  hmacOk: boolean;
  deliveryId: string;
  event: string;
  payload: unknown;
}): HarborFireResult & { pong?: boolean; ignored?: string } {
  const parsed = parseGitHubPayload(opts.event, opts.payload, state.settings, { botLogin: ashlarBotLogin() });
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

  applyLoopControl(parsed, opts.deliveryId);

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
