import {cancelLocalJsonRepairs} from "./json-repair.server";
import { ignoredTarget } from "./webhook-target.ts";
import type {RepairReceipt} from "./json-repair-types.ts";
import {reviewHistory} from "./review-history.server";
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
import { createIssueComment, createPullReview, fetchPullHead, fetchPullSnapshot, formatGithubError, getFile, githubReady, installationToken, listReviewComments, reactOnDelivery, updateIssueComment, type GithubReaction } from "./github.server";
import { buildChatPrompt, parseChatSubmission, splitChatAttachments } from "./chat-prompt";
import { selectPriorThreads, type PriorThread } from "./prior-threads";
import { rankChangedFile } from "./review-budget";
import { runLocalLlm, type LocalLegResult } from "./local-llm.server";
import { requestLocalJson, localStreamingDefault } from "./local-chat-request.server";
import { runLocalReviewLoop, chooseLocalReviewMode } from "./local-review-loop.server";
import { applyLocalActivity, localLegProgress, localLivenessMs, localQueuedMs, localReviewDeadlineMs, startLocalLeg, type LocalLegActivityKind, type LocalLegState } from "./local-leg-activity";
import { applyLocalModelLeaseCapacity, localModelLease, shortJobsPerCheckpoint, type LocalModelLeaseHandle } from "./local-model-lease";
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
import { canReleaseHeldLocal, chatStalled, fallbackWaivesChat, gateUnreadRows, failedLocalSalvage, heldLocalReleased, incompleteVerdict, localExecutionPrompt, localReplies, localVerifies, ownsValidatorGeneration, racingProviders, releaseLocalAsFallback, releaseLocalPrompt, shouldStartLocalLeg, skippedProvider, stillRacing, verdictEvidence } from "./local-fallback";
import { outcomeNote, reviewOutcome, salvagedReview, skippedNote } from "./review-outcome";
import { nextCreationSeq } from "./creation-seq";
import { createDeliveryClaims } from "./loop-control-claims";
import { buildReviewerLanes, emptyReviewSkip, localLegNote } from "./reviewer-progress";
import type { AuxiliaryProviderFailure, BotSettings, Job, PostedReview, RawCause, ReviewProvider, SamplePr, Trigger, WebhookLog } from "./types";
import {
  ashlarBotLogin,
  continueLoopOnPush,
  controlResultLogged,
  loopPostedReview,
  loopStartAt,
  startLoop,
  loopEnabled,
  runPostReviewLoop,
  SILENT_REASONS,
  stopLoop,
  sweepCutFixRounds,
  type ControlResult,
} from "./review-loop-runtime.server.ts";
import { loadBotSettings, saveBotSettings, sanitizeBotSettings } from "./settings.server";
import { validatedSettingsPatch } from "./settings-rules";
import { redactSalvagedReviewBody } from "./review-format";
import { inspectReviewFormat } from "./review-json-repair";
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
// Per-leg queued-without-output watchdog: armed on HTTP send, cleared on the first output token.
// Keepalives do NOT reset it (a ghost occupancy keepalives forever). Fires abort + lease.release.
const localQueued = new Map<string, { arm: (reset: boolean) => void; clear: () => void }>();
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
applyLocalModelLeaseCapacity(state.settings.localLeaseCapacity);

function isLive(status: Job["status"]) {
  return LIVE_INFLIGHT_STATUSES.includes(status);
}

/** UI retention: the completed cache keeps the newest CAP jobs. Live queue/generation work is never
 * over capacity (the invariant): a live job leaves state only after ending through transitionJob. */
function overCapacity(jobs: readonly Job[]): Job[] {
  return jobs.filter((j) => !isLive(j.status)).sort((a, b) => b.createdAt - a.createdAt).slice(CAP);
}

/** Insert a new job (newest first); what capacity then drops leaves through removeJobs. */
function insertJob(job: Job) {
  state = { ...state, jobs: [job, ...state.jobs].sort((a, b) => b.createdAt - a.createdAt) };
  removeJobs(overCapacity(state.jobs));
}

/** The only way a job leaves state (capacity retention, an operator reset). Each job goes through
 * releaseJob, the release its terminal edge runs, so nothing it held outlives it: a local leg still
 * running for it (a job that ended while its leg ran keeps that leg until then) is aborted, and its
 * snapshot, activity and liveness are freed; its watcher exits on its next tick (the job is gone). */
function removeJobs(drop: readonly Job[]) {
  if (!drop.length) return;
  const ids = new Set(drop.map((j) => j.id));
  state = { ...state, jobs: state.jobs.filter((j) => !ids.has(j.id)) };
  for (const job of drop) releaseJob(job, "removed");
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

/** Validate, persist, THEN swap the live settings. The rules (settings-rules settingsProblem)
 * run on the document as the operator sent it, before any normalization, so an input the runtime
 * would refuse (e.g. the loop enabled on a non-wired delivery) is rejected (SettingsError 400)
 * instead of being clamped or rewritten. A failed persist (SettingsError 500) leaves the live
 * settings unchanged: what runs is always what a restart would load. */
export function patchHarborSettings(patch: Partial<BotSettings>) {
  const saved = saveBotSettings(sanitizeBotSettings(validatedSettingsPatch(state.settings, patch)));
  const previousSettings = state.settings;
  state = { ...state, settings: saved };
  if (!saved.localJsonRepairEnabled || previousSettings.localLlmBaseUrl !== saved.localLlmBaseUrl ||
      previousSettings.localLlmModel !== saved.localLlmModel ||
      previousSettings.localLlmModelPriority !== saved.localLlmModelPriority ||
      previousSettings.localLlmApiKey !== saved.localLlmApiKey) {
    cancelLocalJsonRepairs("disabled");
  }
  applyLocalModelLeaseCapacity(saved.localLeaseCapacity);
  return state.settings;
}

export function resetHarbor() {
  cancelLocalJsonRepairs("superseded");
  for (const job of state.jobs) noteJobHistory(isLive(job.status)
    ? {...job, status: "cancelled", skipReason: "operator reset", updatedAt: Date.now()} : job);
  removeJobs(state.jobs);
  state = { settings: state.settings, jobs: [], events: [], reviews: [] };
}

/** The last job or delivery history write that failed. Non-fatal: what it recorded was applied. */
let historyFault: { id: string; at: number; error: string } | undefined;

/** Every job and delivery history write in harbor goes through here, straight to the store: this is
 * the one boundary where a failed write stops. The store throws on a failed write (after recording
 * its own health error); here it is caught, logged and surfaced (historyHealth) with the record it
 * failed for. History records a transition, it is never part of one, so a failure never aborts the
 * state change it records. A later successful write clears the fault, as the store clears its own. */
function noteHistory(id: string, write: () => void) {
  try {
    write();
    historyFault = undefined;
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 240);
    historyFault = { id, at: Date.now(), error };
    console.warn(`[harbor] history write failed for ${id} (the state change was applied): ${error}`);
  }
}
const noteJobHistory = (job: Job) => noteHistory(job.id, () => reviewHistory().recordJob(job));
const noteDeliveryHistory = (ev: WebhookLog, target?: Parameters<ReturnType<typeof reviewHistory>["recordDelivery"]>[1]) =>
  noteHistory(ev.id, () => reviewHistory().recordDelivery(ev, target));

/** History storage health for the dashboard: the store's own, and the record whose write failed (a
 * non-fatal history error; the job state is current). A failure the store's own health does not
 * record (a throw outside its disk I/O) is surfaced as a failed write. */
export function historyHealth() {
  const store = reviewHistory().health();
  if (!historyFault) return store;
  return { ...store, ok: false, error: store.error ?? "history_write_failed", failedId: historyFault.id, failedAt: historyFault.at };
}

export function cancelHarborJob(jobId: string) {
  cancelLocalJsonRepairs("superseded", jobId);
  transitionJob(jobId, (j) =>
    isLive(j.status) ? { ...j, status: "cancelled", skipReason: "cancelled by operator", updatedAt: Date.now() } : j,
  );
}

/** The only writer of an existing job record (a new job is inserted with insertJob; a job leaves state
 * only through removeJobs). Every path that ends a job goes through here, so terminal cleanup runs on
 * the live → terminal edge, and removal runs the same release. Returns the written job. */
function transitionJob(jobId: string, next: (j: Job) => Job): Job | undefined {
  const before = state.jobs.find((j) => j.id === jobId);
  if (!before) return undefined;
  let after = next(before);
  // A job that ended is generating nothing: a stale flag kept its local lane "waiting for local model
  // (position N)" after a cancel had already freed the queue (live #602 job-mupxbgja-1003).
  if (isLive(before.status) && !isLive(after.status) && after.generating && Object.values(after.generating).some(Boolean)) {
    after = { ...after, generating: Object.fromEntries(Object.keys(after.generating).map((k) => [k, false])) };
  }
  state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? after : j)) };
  // Cleanup before the history write: the edge is crossed once, so it runs whatever the write does.
  if (isLive(before.status) && !isLive(after.status)) releaseJob(after, "terminal");
  // Never throws: every caller continues past its write (the lease ping's owner liveness, a local
  // leg's request, the review that follows), so a history failure cannot half-apply a transition.
  noteJobHistory(after);
  if (needsTerminalOps(after)) setTimeout(() => void finishOpsComment(jobId), 0);
  return after;
}

/** The single release of what a job holds locally, run on its live → terminal edge (transitionJob)
 * and when it leaves state (removeJobs). A terminal status is an explicit terminal signal
 * (docs/local-verify-clean.md §3): the job never needs its local snapshot again (a verify-clean job
 * whose local leg never ran would otherwise keep it forever). An in-flight local leg holds its own
 * reference and frees the entry in its finally. Only a cancellation (operator or supersession) or a
 * removal stops that leg (a removed job has no one left to use its result); a posted or skipped job
 * still in state never aborts local generation. */
function releaseJob(job: Job, edge: "terminal" | "removed") {
  const stop = edge === "removed" || job.status === "cancelled";
  if (edge === "removed" || !localInFlight.has(job.id)) localSamples.delete(job.id);
  if (!stop) return;
  localControllers.get(job.id)?.abort();
  // A cancelled / removed job leaves the local-model queue and frees any lease it holds at once, so
  // the next queued review starts without waiting for the aborted request to unwind.
  localModelLease().releaseOwner(job.id);
  localActivity.delete(job.id);
  localLiveness.get(job.id)?.clear();
  localLiveness.delete(job.id);
  localQueued.get(job.id)?.clear();
  localQueued.delete(job.id);
}

/** Test seam: whether a job still retains its local snapshot. */
export function hasLocalSample(jobId: string): boolean {
  return localSamples.has(jobId);
}

/** Test seam: whether a job still has local-leg activity or liveness state (a cancellation clears it). */
export function hasLocalLegState(jobId: string): boolean {
  return localActivity.has(jobId) || localLiveness.has(jobId) || localQueued.has(jobId);
}

/** Test seam: ids holding local state (snapshot, leg, activity, liveness, watcher) with no job in state. */
export function orphanedLocalState(): string[] {
  const ids = new Set([...localSamples.keys(), ...localInFlight, ...localControllers.keys(), ...localActivity.keys(), ...localLiveness.keys(), ...localQueued.keys(), ...watching]);
  return [...ids].filter((id) => !state.jobs.some((j) => j.id === id));
}

/** Test seam: whether a reviewer watcher is still running for a job. */
export function isWatchingJob(jobId: string): boolean {
  return watching.has(jobId);
}

const TERMINAL_OPS: readonly string[] = ["posted", "skipped", "failed"];

/** A GitHub job that ended (skipped, dlq, cancelled) while its ops comment still says running or
 * blocked (live aicc #515: an Instant-tier skip left "Waiting for provider response" for hours, and a
 * lane tool read the job as in progress). A path that reports its own terminal phase has already set
 * opsPhase when this runs (upsertOpsComment sets it before its first await). */
function needsTerminalOps(job: Job): boolean {
  return job.origin === "github" && Boolean(job.opsCommentId || job.opsPhase) && ["posted", "skipped", "dlq", "cancelled"].includes(job.status) &&
    !TERMINAL_OPS.includes(job.opsPhase ?? "");
}

async function finishOpsComment(jobId: string) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || !needsTerminalOps(job) || !job.installationId) return;
  const reason = job.skipReason || job.githubError || "";
  const phase: OpsPhase = job.status === "dlq" ? "failed" : job.status === "posted" ? "posted" : "skipped";
  const note = job.status === "posted" ? "Review posted."
    : job.status === "cancelled" ? `Cancelled${reason ? `: ${reason}` : "."} No review posted.`
    : `No review posted${reason ? `: ${reason}` : "."}`;
  try {
    await upsertOpsComment(await installationToken(job.installationId), jobId, phase, [note]);
  } catch {
    /* never fail the job on its status comment */
  }
}

/** Alias: every job write goes through transitionJob (verify-clean release + history). */
function patchJob(jobId: string, fn: (j: Job) => Job) {
  transitionJob(jobId, fn);
}

export function patchHarborJob(jobId: string, fn: (j: Job) => Job) {
  transitionJob(jobId, fn);
}

export function publicJobs(jobs: Job[]) {
  const enabled = providersFromSettings(state.settings);
  return jobs.map((j) => {
    // rawReview is verbatim model output that can echo private PR source — treat it like storedLegs
    // and never expose it on the unauthenticated /api/harbor; surface only a bounded boolean.
    const { chatPrompt: _prompt, chatPromptByProvider: _by, localReleasePrompt: _lrp, storedLegs: _legs, bridgeLeaseId: _lease, bridgeClientId: _client, coverage: _cov, coverageDeterministic: _covd, promptStats: _ps, rawReview: _raw, ...rest } = j;
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
    // The PR body's scope section the review carried (chat-prompt.ts PR_SCOPE_RULE), 0 when none.
    scopeChars: /<<<UNTRUSTED_PR_SCOPE>>>\n([\s\S]*?)\n<<<END>>>/.exec(prompt)?.[1].length ?? 0,
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

export type ChatLeg = { provider: ReviewProvider; raw: string; originalText?: string; unparsedText?: string; residualReplies?: string; repair?: RepairReceipt };

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
  // Recorded before the write: a terminal phase another path is writing is never overwritten by the
  // generic one (finishOpsComment), nor a terminal one by a late "running".
  if (TERMINAL_OPS.includes(job.opsPhase ?? "") && !TERMINAL_OPS.includes(phase)) return;
  state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, opsPhase: phase } : j)) };
  const body = buildOpsComment({
    phase,
    providers: job.reviewProviders?.length ? job.reviewProviders : providersFromSettings(state.settings),
    role: job.localReviewRole,
    localFallback: Boolean(job.localFallbackAt),
    canonicalProvider: job.canonicalProvider,
    auxiliaryProviderFailures: job.auxiliaryProviderFailures,
    notes: [`Job: ${job.id}`, ...notes],
  });
  // One write at a time per job, in call order: a slow "running" write can no longer land after the
  // terminal one, and a write queued behind the comment's creation updates it instead of creating a
  // second comment.
  const run = (opsWrites.get(jobId) ?? Promise.resolve()).then(async () => {
    if (await writeOpsComment(token, jobId, body)) {
      state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, opsWritten: phase } : j)) };
      if (TERMINAL_OPS.includes(phase)) opsRetries.delete(jobId);
      return;
    }
    // Not written: a terminal phase must not stand as reported, or finishOpsComment never writes it
    // (live aicc #539). The phase falls back to the last one GitHub took, and the terminal write is
    // retried.
    if (!TERMINAL_OPS.includes(phase)) return;
    state = { ...state, jobs: state.jobs.map((j) => (j.id === jobId && j.opsPhase === phase ? { ...j, opsPhase: j.opsWritten } : j)) };
    scheduleOpsRetry(jobId);
  });
  const settled = run.then(() => {}, () => {});
  opsWrites.set(jobId, settled);
  void settled.then(() => { if (opsWrites.get(jobId) === settled) opsWrites.delete(jobId); });
  await settled;
}

const opsWrites = new Map<string, Promise<void>>();

/** Write the job's ops comment; true when GitHub took it. A caller's installation token can be over
 * an hour old (a job ends long after it started, live aicc #539: GitHub expires them after 1 h), so a
 * failed write is retried once with a fresh token. Never throws. */
async function writeOpsComment(token: string, jobId: string, body: string): Promise<boolean> {
  const write = async (t: string) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.opsCommentId) {
      await updateIssueComment(t, { owner: job.owner, repo: job.repo, commentId: job.opsCommentId, body });
      return;
    }
    const created = await createIssueComment(t, { owner: job.owner, repo: job.repo, pr: job.pr, body });
    transitionJob(jobId, (j) => ({ ...j, opsCommentId: created.id, updatedAt: Date.now() }));
  };
  try {
    await write(token);
    return true;
  } catch (e) {
    // Only an auth failure is retried here: a create that timed out may have been stored, and a second
    // one would duplicate the comment (the bounded terminal retry covers the rest).
    const status = (e as { status?: number })?.status;
    if (!(status === 401 || /\b401\b|Bad credentials/i.test(String((e as Error)?.message ?? "")))) return false;
  }
  try {
    const installationId = state.jobs.find((j) => j.id === jobId)?.installationId;
    if (!installationId) return false;
    await write(await installationToken(installationId));
    return true;
  } catch {
    return false; // never fail the review if the status comment cannot post
  }
}

const OPS_RETRY_MS = 60_000;
const OPS_RETRY_MAX = 5;
const opsRetries = new Map<string, number>();

/** Retry a terminal ops write that GitHub did not take, a bounded number of times. */
function scheduleOpsRetry(jobId: string) {
  if (!state.jobs.some((j) => j.id === jobId)) { opsRetries.delete(jobId); return; }
  const n = (opsRetries.get(jobId) ?? 0) + 1;
  if (n > OPS_RETRY_MAX) { opsRetries.delete(jobId); return; }
  opsRetries.set(jobId, n);
  setTimeout(() => void finishOpsComment(jobId), OPS_RETRY_MS).unref?.();
}

async function bridgeSnapshot() {
  const { getBridgePublic, chatBridgeLink } = await import("./bridge.server");
  return { bridge: getBridgePublic(), chatBridgeLink };
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

// One watcher per job. It stays alive across the brief validator phase (sleep + continue) so a
// snapshot/revert back to awaiting_chat can resubmit stored legs without a second local generation.
// releaseHeldLocal also restarts it when a verify-clean / fallback release returns to awaiting_chat.
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
    const { bridge, chatBridgeLink } = await bridgeSnapshot();
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status === "cancelled" || job.status === "posted" || job.status === "skipped" || job.status === "dlq") return;
    // validator is temporary: do not drop the watcher, or a revert to awaiting_chat orphans the job
    // (attachLocalLeg already cleared localInFlight and discarded the failed submit).
    if (job.status === "validator") {
      await sleep(WATCH_TICK_MS);
      continue;
    }
    if (job.status !== "awaiting_chat" && job.status !== "reviewer") return;

    const claimed = Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt < BRIDGE_CLAIM_MS);
    const chat = (job.reviewProviders ?? []).filter(isChatProvider);
    const localLeg = (job.storedLegs ?? []).find((l) => l.provider === "local");
    const localSkip = (job.assumptions ?? []).find((a) => a.startsWith("Skipped local"));
    const prompt = localExecutionPrompt(job);
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
    // (a stale `generating` flag from before the bridge went away is not progress). A claimed job is
    // judged by its owning profile's link: no other profile can resume its run.
    const link = chatBridgeLink(job);
    const stalled = localVerifies({ role, providers: job.reviewProviders ?? [] }) && chatStalled({
      chatProgress: stored.some((l) => isChatProvider(l.provider) && l.raw.trim()) || (link.connected && chat.some((p) => job.generating?.[p])),
      connected: link.connected,
      disconnectedAt: link.disconnectedAt,
      now: Date.now(),
      graceMs: BRIDGE_CONNECTED_MS,
    });
    // While local runs as the fallback the job does not wait on chat, even if the bridge reconnects
    // (chat is reported as skipped); a chat result that still arrives first is merged as usual. Once
    // that fallback ends with no payload, chat is awaited again (fallbackWaivesChat).
    const racing = stillRacing({
      providers: racingProviders({ role, providers: job.reviewProviders ?? [], localReleased, localFallback: fallbackWaivesChat(job) }),
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
    const chatNames = chat.map((p) => (p === "grok" ? "Grok" : "ChatGPT")).join(" / ");
    // While a fallback release waives chat, a reconnect gets no fresh chat work and the job does not
    // wait on chat, so the note must not promise that chat starts when the extension reconnects.
    if (chat.length && fallbackWaivesChat(job)) {
      notes.push(`Chat was unavailable, so local runs as the fallback. ${chatNames} is not awaited, even if the extension reconnects.`);
    } else if (chat.length && !bridge.connected && !claimed) {
      notes.push(`Chrome bridge is not connected. ${chatNames} start when the extension reconnects.`);
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
  // Prior finding threads and their answers (aicc #455). Best effort: a listing failure only drops
  // the context block — the review itself must not fail on it.
  let priorThreads: PriorThread[] = [];
  try {
    priorThreads = selectPriorThreads(await listReviewComments(token, sample.owner, sample.repo, sample.pr), ashlarBotLogin());
  } catch {
    priorThreads = [];
  }
  const live1 = current();
  if (!live1 || live1.status === "cancelled") return;
  const prompt = buildChatPrompt({
    sample,
    extra,
    untrustedBody,
    priorThreads,
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
    validatorGeneration: undefined,
    localVerifyStartedAt: undefined,
    localFallbackAt: undefined,
    localReleasePrompt: undefined,
    localVerifyNote: undefined,
    localVerified: undefined,
    skippedProviders: undefined,
    incompleteProviders: undefined,
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
  if (localInFlight.has(jobId)) return;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return;
  // Once held-local released, the prompt pinned in that transaction wins over any later mutation.
  const runPrompt = localExecutionPrompt({ ...job, chatPrompt: prompt || job.chatPrompt });
  if (!runPrompt.trim()) return;
  if ((job.storedLegs ?? []).some((l) => l.provider === "local" && l.raw.trim())) return;
  if ((job.assumptions ?? []).some((a) => /^Skipped local/i.test(a))) return;
  localInFlight.add(jobId);
  // A health probe can be delayed by the model queue. Never gate generation on that timer.
  const controller = new AbortController();
  localControllers.set(jobId, controller);
  // The leg starts "waiting for the lease": nothing has been sent. local_queued is written only
  // when the transport reports HTTP dispatched (see noteLocalActivity on "sent"). Showing queued
  // here was a ghost: the lane said the request was at the server when it was still in Ashlar's FIFO.
  const startedAt = Date.now();
  transitionJob(jobId, j => ({...j, generating: {...j.generating, local: true},
    providerProgress: {...j.providerProgress, local: {runId: `local:${jobId}`, stage: "local_lease_waiting", observedAt: startedAt, receivedAt: startedAt}},
    updatedAt: startedAt}));
  try {reviewHistory().recordServerStep(jobId,"local.requested");} catch { /* visible history health */ }
  void attachLocalLeg(jobId, runPrompt, { submit: true });
}

/** Wait (FIFO, abort-aware) for the process-wide local-model lease, held by this review's local leg
 * across ALL of its file groups and turns (released in attachLocalLeg's finally, or by releaseJob on
 * cancel/removal). While waiting the leg shows "waiting for local model (position N)"; nothing has
 * been sent, so neither the liveness watchdog nor the optional deadline is armed yet. */
async function acquireLocalModel(jobId: string): Promise<LocalModelLeaseHandle> {
  const signal = localControllers.get(jobId)?.signal;
  let waited = false;
  const handle = await localModelLease().acquire(jobId, {
    signal,
    onPosition: (position) => {
      waited = true;
      const now = Date.now();
      transitionJob(jobId, (j) => j.status !== "awaiting_chat" ? j : ({
        ...j,
        providerProgress: {
          ...j.providerProgress,
          local: { runId: `local:${jobId}`, stage: "local_lease_waiting", observedAt: now, receivedAt: now, queuePosition: position },
        },
      }));
    },
  });
  if (waited) {
    // The model is ours now, but nothing has been sent: stay on local_lease_waiting (drop the
    // queue position) until the transport reports HTTP dispatched.
    const now = Date.now();
    transitionJob(jobId, (j) => j.status !== "awaiting_chat" ? j : ({
      ...j,
      providerProgress: { ...j.providerProgress, local: { runId: `local:${jobId}`, stage: "local_lease_waiting", observedAt: now, receivedAt: now } },
      updatedAt: now,
    }));
  }
  // A cancellation (releaseJob) that lands between the grant and this continuation already revoked the
  // lease: give it back and stop here, so a cancelled review never sends a request or holds the model.
  if (signal?.aborted) {
    handle.release();
    throw signal.reason ?? new Error("local review cancelled before its first request");
  }
  try { reviewHistory().recordServerStep(jobId, "local.lease_acquired"); } catch { /* visible history health */ }
  return handle;
}

/** Feed one activity observation into the leg's tracker and flush it (throttled) to the job. The
 * first server acceptance and the first output token are also recorded as history steps, so a
 * post-mortem can tell "never accepted", "accepted but never generated" and "generated" apart. */
function noteLocalActivity(jobId: string, kind: LocalLegActivityKind) {
  localLiveness.get(jobId)?.reset(); // any sign of life defers the hung-server abort
  // Queued-without-output: a new HTTP send (re)starts the timer; keepalives must NOT reset it;
  // the first output token (or a completed turn) clears it.
  if (kind === "sent") localQueued.get(jobId)?.arm(true);
  else if (kind === "keepalive") localQueued.get(jobId)?.arm(false);
  else if (kind === "output" || kind === "turn") localQueued.get(jobId)?.clear();
  const now = Date.now();
  let prev = localActivity.get(jobId);
  if (!prev) {
    // First wire event (sent / keepalive / output): the tracker starts here so local_queued is
    // never written before HTTP is dispatched. A turn with no tracker is a no-op.
    if (kind === "turn") return;
    prev = startLocalLeg(now);
    localActivity.set(jobId, prev);
  }
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
  lease?: LocalModelLeaseHandle,
): Promise<LocalLegResult> {
  const signal = localControllers.get(jobId)?.signal;
  const sample = localSamples.get(jobId);
  const job = state.jobs.find((j) => j.id === jobId);
  const mode = chooseLocalReviewMode(state.settings.localReviewMode, prompt.length, state.settings.localReviewSingleTurnMaxTokens);
  if (mode === "multiturn" && sample) {
    return runLocalReviewLoop(sample, state.settings, {
      signal,
      log: (line) => console.info(`[local] ${jobId} ${line.replace(/\s+/g, " ").slice(0, 300)}`),
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
      // Turn boundary: lend the model to waiting JSON repairs (short lane, capped), then resume ahead
      // of every other queued job. The liveness watchdog is paused meanwhile — this leg sends
      // nothing while a repair runs, and that silence is not a wedged server. The wait honors the
      // review's own abort (hard deadline, cancel): the review stops without waiting for the repair.
      ...(lease ? {
        checkpoint: async () => {
          localLiveness.get(jobId)?.clear();
          try { await localModelLease().checkpoint(lease, shortJobsPerCheckpoint(), signal); }
          finally { localLiveness.get(jobId)?.reset(); }
        },
      } : {}),
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
function collectLocalLeg(j: Job, raw: string, originalText?: string, evidence?: { unparsedText?: string; residualReplies?: string }): Job {
  const next = [...(j.storedLegs ?? []).filter((l) => l.provider !== "local"), { provider: "local" as const, raw, originalText, ...evidence }];
  return { ...j, storedLegs: next, generating: {...j.generating, local: false}, providerProgress: {...j.providerProgress, local: {runId: `local:${j.id}`, stage: "response_collected", observedAt: Date.now(), receivedAt: Date.now()}}, updatedAt: Date.now() };
}

async function attachLocalLeg(jobId: string, prompt: string, opts?: { submit?: boolean }) {
  let lease: LocalModelLeaseHandle | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // One lease for the whole leg (every group and turn): another review cannot slip a request in
    // between this review's turns and evict its prompt cache. Throws when the job is cancelled while
    // queued (the abort reason becomes the leg's error below, a no-op on a job no longer awaiting chat).
    lease = await acquireLocalModel(jobId);
    // Three independent, both-optional aborts; none fires for a healthy long review. All honour the
    // signal, so the leg falls into the catch below and fails cleanly. Cleared in finally on settle.
    //
    // 1. Liveness (default 10 min, streaming only): abort after TOTAL silence — no headers, no keepalive,
    //    no token — for the window. Reset by noteLocalActivity on every sign of life, and the server
    //    keepalives ~every 10s while queued or generating, so an hours-long queue is never touched; only
    //    a genuinely wedged server trips it. This is what unblocks a finished peer review that would
    //    otherwise wait forever on the in-flight local leg (stillRacing). A buffered leg has no
    //    incremental signal, so liveness is armed only when streaming is on; it relies on the ceiling.
    // 2. Queued-without-output (default 30 min, ASHLAR_LOCAL_REVIEW_QUEUED_MS, 0=off): abort + lease.release
    //    after HTTP sent with no output token, DESPITE keepalives. A ghost occupancy (a cancelled
    //    request still generating) keepalives forever; liveness never fires and the lease stays held.
    //    Armed on send, cleared on output; waiting for this FIFO lease is not counted.
    // 3. Total ceiling (ASHLAR_LOCAL_REVIEW_DEADLINE_MS; off by default): a hard wall-clock cap for
    //    operators who want one, independent of activity. All start once the lease is held: time spent
    //    waiting for another review to finish is not this leg's model time.
    const livenessMs = localStreamingDefault() ? localLivenessMs() : 0;
    if (livenessMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fire = () => localControllers.get(jobId)?.abort(new Error(`local review: no response from the model server for ${Math.round(livenessMs / 60_000)} min (ASHLAR_LOCAL_REVIEW_LIVENESS_MS)`));
      const arm = () => { timer = setTimeout(fire, livenessMs); };
      arm();
      localLiveness.set(jobId, { reset: () => { if (timer) clearTimeout(timer); arm(); }, clear: () => { if (timer) clearTimeout(timer); } });
    }
    const queuedMs = localQueuedMs();
    if (queuedMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fire = () => {
        // Release the lease NOW, before the aborted HTTP unwinds, so the next waiter is not a ghost
        // holder of a slot that is no longer producing output for us.
        lease?.release();
        const span = queuedMs >= 60_000 ? `${Math.round(queuedMs / 60_000)} min` : `${queuedMs} ms`;
        localControllers.get(jobId)?.abort(new Error(`local review: queued without output for ${span} (ASHLAR_LOCAL_REVIEW_QUEUED_MS)`));
      };
      localQueued.set(jobId, {
        arm: (reset) => {
          if (timer && !reset) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(fire, queuedMs);
        },
        clear: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
      });
    }
    const deadlineMs = localReviewDeadlineMs();
    deadline = deadlineMs > 0
      ? setTimeout(
        () => localControllers.get(jobId)?.abort(new Error(`local review exceeded the ${Math.round(deadlineMs / 60_000)} min ASHLAR_LOCAL_REVIEW_DEADLINE_MS ceiling`)),
        deadlineMs,
      )
      : undefined;
    const local = await generateLocalLeg(jobId, prompt, lease);
    try {
      reviewHistory().recordServerStep(jobId,local.ok?"local.response_received":"local.failed");
      // Every completed reply that was not review JSON is archived, including one a later reply replaced.
      const unparsed = local.ok ? local.unparsedText?.trim() : localReplies(local);
      if(unparsed)reviewHistory().recordObservation(jobId,"local",`local:${jobId}`,unparsed,unparsed.length,unparsed.length>128_000);
      // A reply whose accepted JSON left text outside it WAS parsed: it is the leg's original reply, kept
      // under the response cap where a single-turn reply's originalText is (the posted evidence is capped
      // lower, so this is where the rest of it lives). A multi-turn leg has no originalText, so its
      // residual group replies are that original; the submit's recordResponse (same JSON, no original)
      // keeps it. Never an "unparsed" observation: the reply parsed (its gate posts it as evidence).
      if(local.ok&&!local.originalText&&local.residualReplies?.trim())reviewHistory().recordResponse(jobId,"local",local.raw,local.residualReplies);
    } catch { /* metadata storage failure is visible without starting another model */ }
    if (!local.ok) {
      transitionJob(jobId, (j) => {
        if (j.status !== "awaiting_chat") return j;
        // A completed non-JSON reply is evidence on any role: kept as a salvaged leg.
        const salvage = failedLocalSalvage(local);
        if (salvage) return collectLocalLeg(j, salvage, localReplies(local));
        return {
          ...j, generating: {...j.generating, local: false},
          providerErrors: {...j.providerErrors, local: {code: "error", message: local.error}},
          providerProgress: {...j.providerProgress, local: {runId: `local:${jobId}`, stage: "error", observedAt: Date.now(), receivedAt: Date.now()}},
          assumptions: [...(j.assumptions ?? []), `Skipped local (${local.error})`].slice(0, 12), updatedAt: Date.now(),
        };
      });
    } else {
      // Every leg's gate reads unparsedText / residualReplies (race or held alike): a reply set aside to
      // reach the accepted JSON is evidence, so that JSON is never the leg's complete verdict.
      const evidence = { unparsedText: local.unparsedText, residualReplies: local.residualReplies };
      transitionJob(jobId, (j) => (j.status !== "awaiting_chat" ? j : collectLocalLeg(j, local.raw, local.originalText, evidence)));
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
    lease?.release();
    if (deadline) clearTimeout(deadline);
    localLiveness.get(jobId)?.clear();
    localLiveness.delete(jobId);
    localQueued.get(jobId)?.clear();
    localQueued.delete(jobId);
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
        providers: racingProviders({ role, providers, localReleased, localFallback: fallbackWaivesChat(job) }),
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
  let validatorGeneration = 0;
  transitionJob(jobId, (j) => {
    if (j.status !== "awaiting_chat") return j;
    locked = true;
    validatorGeneration = (j.validatorGeneration ?? 0) + 1;
    return { ...j, status: "validator", validatorGeneration, updatedAt: Date.now() };
  });
  if (!locked) return { ok: false, error: "job is not waiting for a chat review" };

  const revert = (error: string, restartToken?: string) => {
    transitionJob(jobId, (j) =>
      ownsValidatorGeneration(j, validatorGeneration)
        ? { ...j, status: "awaiting_chat", githubError: error, updatedAt: Date.now() }
        : j,
    );
    // If the watcher already exited on a prior validator tick, put it back so stored legs resubmit.
    if (restartToken) void watchReviewers(jobId, restartToken);
    return { ok: false as const, error };
  };
  /** Stale validator completion must not merge or release after ownership moved (held-local race). */
  const stillOwnsValidator = () => {
    const cur = state.jobs.find((j) => j.id === jobId);
    return ownsValidatorGeneration(cur, validatorGeneration);
  };

  let token: string | undefined;
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
    // token is set only when installationToken succeeded before fetchPullSnapshot failed.
    return revert(msg.slice(0, 240), token);
  }

  const still = state.jobs.find((j) => j.id === jobId);
  if (!still || still.status === "cancelled") {
    return { ok: false, error: "cancelled" };
  }
  if (!ownsValidatorGeneration(still, validatorGeneration)) {
    return { ok: false, error: "stale validator" };
  }
  // Snapshot succeeded: token is defined for the rest of this validation.
  if (!token) return revert("missing installation token");

  const gates: LiveGateResult[] = [];
  const byProvider = new Map<ReviewProvider, LiveGateResult>();
  const invalid: string[] = [];
  const heldLocal = !job.chatFpRound && heldLocalReleased(job);
  let localUnusable: string | undefined;
  const unusableNotes: string[] = [];
  // Why each salvaged leg is posted verbatim, kept for the body and the loop handoff (Job.rawCauses).
  const rawCauses: Partial<Record<ReviewProvider, RawCause>> = {};
  // Each reviewer's complete-verdict state (gateLeg): only these earn clean credit.
  const complete = new Set<ReviewProvider>();
  // A released held local leg's rejected reply is always evidence (docs §1). Any other leg the gate
  // rejected becomes evidence once another leg passed (the merge posts, so its reply is never dropped);
  // when none did, it stays rejected, so chat with nothing usable still releases the fallback or skips.
  const configuredCanonicalProvider = providers.find(isChatProvider);
  const isAuxiliaryChat = (provider: ReviewProvider) => Boolean(configuredCanonicalProvider && provider !== configuredCanonicalProvider && isChatProvider(provider));
  const preserveSchemaRejectedEvidence = (leg: ChatLeg) =>
    !job.localVerifyStartedAt && !job.localFallbackAt && isAuxiliaryChat(leg.provider);
  const first = payloads.map((leg) => ({
    leg,
    ...gateLeg(leg, sample, heldLocal && leg.provider === "local", preserveSchemaRejectedEvidence(leg)),
  }));
  const posts = first.some((g) => g.gate.ok);
  for (const g of first) {
    const { leg, gate, verdict, unusable, cause } = !g.gate.ok && posts
      ? { leg: g.leg, ...gateLeg(g.leg, sample, true, preserveSchemaRejectedEvidence(g.leg)) }
      : g;
    if (unusable) unusableNotes.push(`${leg.provider}: ${unusable} (reply posted verbatim)`);
    if (unusable && leg.provider === "local") localUnusable = unusable;
    if (!gate.ok) {
      invalid.push(`${leg.provider}: ${gate.reason}`);
      continue;
    }
    gates.push(gate);
    byProvider.set(leg.provider, gate);
    if (verdict) complete.add(leg.provider);
    if (gate.rawReview && cause) rawCauses[leg.provider] = cause;
  }
  // The first active chat reviewer is the canonical verdict. A failed secondary chat leg is
  // evidence for ops, but cannot turn a complete canonical verdict into a raw/non-clean review.
  // Local remains blocking: in verify-clean it is the explicit verification gate, and in race it
  // is an ordinary reviewer whose findings must not be hidden.
  // The first enabled chat leg is normally canonical. Promote only when the worker recorded an
  // explicit skip/logged_out (not payload absence) and another chat leg produced a complete verdict.
  // A malformed/incomplete leg is never an eligible fallback. A transport failure may promote only
  // in verify-clean after the local verifier returned a structured clean result. While that local
  // leg has not finished, withhold the incomplete stamp so a complete fallback chat verdict can
  // start Cloud Verify. After a non-clean or failed local result, stamp the configured canonical
  // provider incomplete and never promote.
  const completeChatProvider = providers.find((provider) => isChatProvider(provider) && complete.has(provider));
  const canonicalErrorCode = configuredCanonicalProvider
    ? job.providerErrors?.[configuredCanonicalProvider]?.code
    : undefined;
  const canonicalExplicitSkip = canonicalErrorCode === "quota" || canonicalErrorCode === "empty"
    || canonicalErrorCode === "tab_closed" || canonicalErrorCode === "cancelled"
    || canonicalErrorCode === "logged_out";
  const canonicalTransportFailure = canonicalErrorCode === "disconnected" || canonicalErrorCode === "error";
  const localCleanVerdict = complete.has("local") && (byProvider.get("local")?.findings.length ?? 0) === 0;
  const localVerifierSettled = payloads.some((l) => l.provider === "local")
    || skippedProvider(job.assumptions, "local")
    || Boolean(job.providerErrors?.local && job.providerErrors.local.code !== "disconnected");
  const verifierCanRecoverTransport = Boolean(
    completeChatProvider &&
    providers.includes("local") &&
    job.localReviewRole === "verify-clean" &&
    canonicalTransportFailure &&
    job.localVerifyStartedAt &&
    localCleanVerdict,
  );
  const pendingTransportRecovery = Boolean(
    completeChatProvider &&
    providers.includes("local") &&
    job.localReviewRole === "verify-clean" &&
    canonicalTransportFailure &&
    !verifierCanRecoverTransport &&
    !localVerifierSettled,
  );
  const canonicalUnavailable = Boolean(configuredCanonicalProvider && (canonicalExplicitSkip || verifierCanRecoverTransport));
  const canonicalProvider = configuredCanonicalProvider && completeChatProvider &&
    configuredCanonicalProvider !== completeChatProvider && canonicalUnavailable
    ? completeChatProvider
    : configuredCanonicalProvider;
  const auxiliaryProviderFailures: Partial<Record<ReviewProvider, AuxiliaryProviderFailure>> = {};
  const payloadProviders = [...new Set(payloads.map((l) => l.provider))];
  const incompletePayloadProviders = payloadProviders.filter((p) => !complete.has(p));
  for (const provider of incompletePayloadProviders) {
    // An auxiliary reply that never became review JSON is out-of-band evidence. A malformed text
    // fragment can contain severity-looking prose (or a partial finding object); that marker is not
    // a gated finding and must not poison a complete canonical verdict. Valid structured findings
    // remain in `byProvider` and are merged below.
    if (isAuxiliaryChat(provider) && rawCauses[provider] === "unparseable") {
      auxiliaryProviderFailures[provider] = "unparseable";
    }
  }
  const auxiliaryProviders = new Set(Object.keys(auxiliaryProviderFailures) as ReviewProvider[]);
  const incompleteProviders = incompletePayloadProviders.filter((p) => !auxiliaryProviders.has(p));
  // A valid fallback chat verdict discharges only the configured canonical leg's absence. A
  // missing secondary leg remains visible as incomplete, preserving the existing dual-review gate.
  const dischargedCanonicalSkip = Boolean(
    configuredCanonicalProvider && canonicalProvider && configuredCanonicalProvider !== canonicalProvider,
  );
  const blockingSkipped = skipped.filter((p) =>
    !auxiliaryProviders.has(p) && !(dischargedCanonicalSkip && p === configuredCanonicalProvider),
  );
  const blockingInvalid = invalid.filter((row) => {
    const provider = (Object.keys(auxiliaryProviderFailures) as ReviewProvider[]).find((p) => row.startsWith(`${p}:`));
    return !provider;
  });
  const blockingUnusableNotes = unusableNotes.filter((row) => {
    const provider = (Object.keys(auxiliaryProviderFailures) as ReviewProvider[]).find((p) => row.startsWith(`${p}:`));
    return !provider;
  });
  const canonicalByProvider = new Map([...byProvider].filter(([provider]) => !auxiliaryProviders.has(provider)));
  // Keep valid auxiliary findings visible. An explicitly unavailable canonical leg is discharged
  // above only when another chat leg supplied a complete verdict; unresolved canonical absence
  // still stamps incomplete and can never produce a converged result.
  if (
    canonicalProvider &&
    !complete.has(canonicalProvider) &&
    !incompleteProviders.includes(canonicalProvider) &&
    !pendingTransportRecovery
  ) {
    incompleteProviders.push(canonicalProvider);
  }
  const canonicalGates = [...canonicalByProvider.values()];
  const rawCausesForBody = Object.fromEntries(
    Object.entries(rawCauses).filter(([provider]) => !auxiliaryProviders.has(provider as ReviewProvider)),
  ) as Partial<Record<ReviewProvider, RawCause>>;
  const auxiliaryFailures = Object.keys(auxiliaryProviderFailures).length ? auxiliaryProviderFailures : undefined;

  if (!canonicalGates.length && releaseLocalAsFallback({ role, providers, localReleased, chatRacing: false, usableChat: false })) {
    // verify-clean, chat returned no valid JSON: local runs as today's fallback instead of a skip.
    if (!stillOwnsValidator()) return { ok: false, error: "stale validator" };
    if (auxiliaryFailures) {
      transitionJob(jobId, (j) => ownsValidatorGeneration(j, validatorGeneration)
        ? { ...j, auxiliaryProviderFailures: auxiliaryFailures, updatedAt: Date.now() }
        : j);
    }
    releaseHeldLocal(jobId, token, { kind: "fallback" }, "Chat reviewers returned no valid JSON; local runs as the fallback.", incoming, { validatorGeneration });
    return { ok: true };
  }
  if (!canonicalGates.length) {
    if (!stillOwnsValidator()) return { ok: false, error: "stale validator" };
    transitionJob(jobId, (j) => {
      if (!ownsValidatorGeneration(j, validatorGeneration)) return j;
      return {
        ...j,
        status: "skipped",
        skipReason: blockingInvalid.join("; ") || "no valid review JSON",
        githubError: blockingInvalid.join("; ") || "no valid review JSON",
        plan: "Did not post — no reviewer returned valid JSON.",
        auxiliaryProviderFailures: auxiliaryFailures,
        updatedAt: Date.now(),
      };
    });
    return { ok: false, error: blockingInvalid.join("; ") || "no valid review JSON" };
  }

  const merged = schemaMergeProviderGates(
    [...canonicalByProvider.entries()].map(([provider, gate]) => ({ provider, gate })),
    state.settings,
  );
  // Union model coverage across providers (a file is not_cleared if any provider says so).
  // Coverage + droppedCount never affect the verdict — recorded for the ops comment only.
  const coverageByFile = new Map<string, { file: string; status: "cleared" | "not_cleared"; reason: string }>();
  for (const g of canonicalGates) {
    for (const c of g.coverage ?? []) {
      const prev = coverageByFile.get(c.file);
      if (!prev || (prev.status === "cleared" && c.status === "not_cleared")) coverageByFile.set(c.file, c);
    }
  }
  // Verbatim reply(ies) from any leg whose JSON could not be parsed — surfaced in the review body so
  // the fixing agent can act instead of the job pending forever. Every leg's salvaged reply is
  // combined, a verifier's included: no review is silently discarded.
  const salvaged = salvagedReview([...canonicalByProvider].map(([provider, g]) => ({ provider, rawReview: g.rawReview })), MAX_RAW_REVIEW_BODY);
  const rawReview = salvaged?.text;
  // The legs the block holds only in part: the outcome, header and note describe the block as posted.
  const rawTruncated = salvaged?.truncated.length ? salvaged.truncated : undefined;
  const rawLegs = salvaged?.legs;
  // Only a complete verdict counts (gateLeg), never payload presence or the absence of raw text:
  // that decides both whether local verified and which chat reviewers were clean.
  const structured = [...complete];
  const verifying = Boolean(job.localVerifyStartedAt) && !job.localFallbackAt;
  const localVerified = verifying ? structured.includes("local") : undefined;
  const nextAssumptions = [
    blockingSkipped.length ? skippedNote(blockingSkipped) : "",
    ...blockingInvalid,
    ...blockingUnusableNotes,
    ...merged.assumptions,
  ].filter(Boolean);
  // merged.findings is already publish-gated (gateLiveSubmission applies the poster's partition with
  // the same settings), so this count is the one the posted body renders.
  // Skipped reviewers come from provider state (`skipped`), never from the merged assumptions, which
  // also carry the reviewers' own free-form text.
  const outcome = reviewOutcome({
    ...job,
    rawReview,
    rawCauses: rawCausesForBody,
    rawTruncated,
    localVerified,
    assumptions: nextAssumptions,
    skippedProviders: blockingSkipped,
    incompleteProviders,
  }, merged.findings.length);
  // Credit only the chat reviewers that produced the clean structured result (pinned when the
  // verification round starts): a skipped or failed chat reviewer found nothing only by absence.
  const cleanChat = job.localVerifyChat ?? structured.filter(isChatProvider);
  if (outcome === "verify") {
    // Chat parsed clean: hold the post and run local on the same prompt as the verification round.
    const plan = `${cleanChat.join(" + ") || "chat"} found nothing; local verification round running.`;
    if (!stillOwnsValidator()) return { ok: false, error: "stale validator" };
    releaseHeldLocal(jobId, token, { kind: "verify", verifyChat: cleanChat }, plan, incoming, { validatorGeneration });
    return { ok: true };
  }
  // verify-clean: a chat-only salvage (pre-gate unparseable / salvaged_no_repair, findings=0) is not a
  // clean structured result and must not post while local stays held — that path left Instant/invalid
  // JSON as raw with no Coverage(model) and tripped loop-error (aicc #598). Release local as the
  // chat-down fallback so it still runs. Salvage is never CONVERGED / verified-clean (outcome stays
  // raw / incomplete after the merge). Overflow/malformed (other raw causes) still post as today.
  const chatSalvageOnly =
    merged.findings.length === 0 &&
    Boolean(rawReview) &&
    !structured.some(isChatProvider) &&
    Object.entries(rawCausesForBody).some(([p]) => isChatProvider(p as ReviewProvider)) &&
    Object.entries(rawCausesForBody).filter(([p]) => isChatProvider(p as ReviewProvider)).every(([, c]) => c === "unparseable");
  if (
    chatSalvageOnly &&
    releaseLocalAsFallback({ role, providers, localReleased, chatRacing: false, usableChat: false })
  ) {
    if (!stillOwnsValidator()) return { ok: false, error: "stale validator" };
    releaseHeldLocal(
      jobId,
      token,
      { kind: "fallback" },
      "Chat reviewers returned no usable structured JSON; local runs as the fallback.",
      incoming,
      { validatorGeneration },
    );
    return { ok: true };
  }
  const localError =
    localUnusable ||
    (job.assumptions ?? []).find((a) => /^Skipped local/i.test(a))?.replace(/^Skipped local\s*\(?/i, "").replace(/\)$/, "") ||
    blockingInvalid.find((s) => s.startsWith("local:"))?.slice("local:".length).trim() ||
    (canonicalByProvider.get("local")?.rawReview ? "not review JSON" : undefined);
  // Each merged reviewer's accepted finding count: the note credits findings to the leg that reported them.
  const findingsBy: Partial<Record<ReviewProvider, number>> = Object.fromEntries([...canonicalByProvider].map(([p, g]) => [p, g.findings.length]));
  const rawBy = [...canonicalByProvider].filter(([, g]) => g.rawReview).map(([p]) => p);
  const localVerifyNote = outcomeNote(outcome, { chat: cleanChat, verifying, findings: merged.findings.length, findingsBy, localError, localVerified, rawBy, rawTruncated });
  if (!stillOwnsValidator()) return { ok: false, error: "stale validator" };
  let stamped = false;
  transitionJob(jobId, (j) => {
    if (!ownsValidatorGeneration(j, validatorGeneration)) return j;
    stamped = true;
    return {
      ...j,
      findings: merged.findings,
      candidates: merged.findings,
      mergeRecommendation: merged.mergeRecommendation,
      highestRisk: merged.highestRisk,
      rawReview,
      rawCauses: rawReview ? rawCausesForBody : undefined,
      rawTruncated,
      rawLegs,
      investigatedSafe: merged.investigatedSafe,
      assumptions: nextAssumptions,
      skippedProviders: blockingSkipped,
      incompleteProviders,
      canonicalProvider,
      auxiliaryProviderFailures: auxiliaryFailures,
      coverage: [...coverageByFile.values()],
      droppedCount: canonicalGates.reduce((n, g) => n + g.dropped.length, 0),
      plan: `Schema-merged ${[...canonicalByProvider.keys()].join(" + ")}${auxiliaryProviders.size ? `; auxiliary failures: ${[...auxiliaryProviders].join(" + ")}` : ""}.`,
      localVerifyNote: localVerifyNote || undefined,
      localVerified,
      updatedAt: Date.now(),
    };
  });
  if (!stamped) return { ok: false, error: "stale validator" };
  await finishJob(jobId, sample, token);
  return finishResult(jobId);
}

/** Gate one reviewer leg and decide its complete-verdict state (docs/local-verify-clean.md §1). Every
 * leg, chat or local, race or verify-clean: a reply is its reviewer's verdict only when it passed the
 * gate with nothing set aside (incompleteVerdict: no finding dropped for its shape or left unread past
 * the row cap, and for a local leg no completed reply or text around the accepted JSON discarded to
 * get it; a chat leg's verdict is the JSON its client submitted, its page capture archived, not
 * judged) and was not salvaged verbatim. Any other reply is gated as evidence instead (verdictEvidence): what parsed, plus
 * its complete text verbatim, so it posts and nothing it reported is lost. A reply the gate rejects
 * outright becomes evidence only with `rejectedEvidence` (the caller decides: see submitHarborChat).
 * `cause` says why a leg posts verbatim: a reply salvaged before the gate (the bridge's, or a failed
 * held local leg's) was not valid review JSON; a converted one is evidence for unread rows alone or
 * for another reason it is not a verdict. */
function gateLeg(
  leg: ChatLeg,
  sample: SamplePr,
  rejectedEvidence: boolean,
  preserveSchemaRejectedEvidence = false,
): { gate: ReturnType<typeof gateLiveSubmission>; verdict: boolean; unusable?: string; cause?: RawCause } {
  const parsed = parseChatSubmission(leg.raw);
  const gate = gateLiveSubmission(parsed, sample, state.settings);
  if (gate.ok && gate.rawReview) {
    // The bridge wraps schema-rejected chat JSON in a raw_review envelope when repair is off. The
    // envelope itself is parseable, but the original reply is still a rejected reviewer verdict:
    // keep it as blocking evidence so an auxiliary P1 cannot disappear and start verification.
    const original = leg.originalText?.trim();
    if (preserveSchemaRejectedEvidence && original && !inspectReviewFormat(original, "review").ok) {
      const source = parseChatSubmission(original);
      if (source) {
        const evidence = verdictEvidence(source, { ...leg, raw: original });
        const evidenceGate = gateLiveSubmission(evidence, sample, state.settings);
        return { gate: evidenceGate, verdict: false, unusable: "reply failed the review schema", cause: "not-a-verdict" };
      }
    }
    return { gate, verdict: false, cause: "unparseable" };
  }
  const unusable = incompleteVerdict(gate, leg);
  if (!unusable) return { gate, verdict: gate.ok };
  if (!gate.ok && !rejectedEvidence) return { gate, verdict: false };
  const cause: RawCause = unusable === gateUnreadRows(gate) ? "unread-rows" : "not-a-verdict";
  return { gate: gateLiveSubmission(verdictEvidence(parsed, leg), sample, state.settings), verdict: false, unusable, cause };
}

type HeldLocalRelease = { kind: "verify"; verifyChat: ReviewProvider[] } | { kind: "fallback" };

/** verify-clean: the single release point of a held local leg, called only on an explicit terminal
 * signal of the chat round (docs/local-verify-clean.md §2): a clean structured chat result starts
 * the verification round; chat finishing with nothing usable (no valid JSON, or a findings=0
 * pre-gate salvage / salvaged_no_repair), or a bridge disconnected past its grace, starts the
 * fallback. It releases once (a stamp is set), returns the job to awaiting_chat with the chat legs
 * kept, starts local and makes sure a watcher waits for it.
 * A validator-phase caller must pass the generation it locked with; without a matching generation,
 * status===validator is refused so a concurrent watcher cannot steal an in-flight validation. */
function releaseHeldLocal(
  jobId: string,
  token: string,
  release: HeldLocalRelease,
  plan: string,
  legs: ChatLeg[] = [],
  opts?: { validatorGeneration?: number },
): boolean {
  let released = false;
  let pinnedPrompt = "";
  const job = transitionJob(jobId, (j) => {
    if (!canReleaseHeldLocal(j, opts)) return j;
    released = true;
    // Pin prompt + triggering chat legs in the same transaction that stamps the release, so a
    // concurrent mutation of chatPrompt/storedLegs cannot retarget the local verification run.
    pinnedPrompt = releaseLocalPrompt(j);
    const stamp = release.kind === "verify"
      ? { localVerifyStartedAt: Date.now(), localVerifyChat: release.verifyChat, localReleasePrompt: pinnedPrompt }
      : { localFallbackAt: Date.now(), localReleasePrompt: pinnedPrompt };
    return { ...j, ...stamp, status: "awaiting_chat", storedLegs: upsertLegs(j.storedLegs, legs), plan, updatedAt: Date.now() };
  });
  if (!released || !job) return false;
  void kickLocalRace(jobId, pinnedPrompt);
  void watchReviewers(jobId, token);
  return true;
}

/** Test seam: held-local release with optional validator-generation ownership. */
export function releaseHeldLocalForTest(
  jobId: string,
  token: string,
  release: HeldLocalRelease,
  plan: string,
  legs: ChatLeg[] = [],
  opts?: { validatorGeneration?: number },
): boolean {
  return releaseHeldLocal(jobId, token, release, plan, legs, opts);
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
  // Review-loop step (design §5 4–8): gated OFF by default (Settings fixAgent.enabled +
  // fixAgent.provider, read from the live state.settings, so a saved toggle applies here with no
  // restart). Best-effort — never un-posts the review.
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
    noteDeliveryHistory(ev);
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 403, reject: decision.reason, queued: false };
  }

  if (decision.skip || !decision.job) {
    // Ordinary/bot comments and duplicate deliveries are not reviewer executions.
    if (!isBotMention(opts.thread?.userText, state.settings) || /^duplicate delivery_id/.test(decision.skip || "")) {
      const ev: WebhookLog = {id:nid("ev"),deliveryId:opts.deliveryId,event:opts.eventName,action:"ignored",hmac:"ok",
        httpStatus:202,at:Date.now(),summary:`${opts.sample.owner}/${opts.sample.repo}#${opts.sample.pr} ignored`,skipReason:decision.skip || "filtered"};
      noteDeliveryHistory(ev,{owner:opts.sample.owner,repo:opts.sample.repo,pr:opts.sample.pr,commentId:opts.thread?.commentId});
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
    noteJobHistory(skipJob);
    noteDeliveryHistory(ev,{owner:opts.sample.owner,repo:opts.sample.repo,pr:opts.sample.pr,commentId:opts.thread?.commentId});
    insertJob(skipJob);
    state = { ...state, events: trim([ev, ...state.events]) };
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
    createdSeq: nextCreationSeq(),
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
  insertJob(job);
  state = { ...state, events: trim([ev, ...state.events]) };

  noteDeliveryHistory(ev,{owner:job.owner,repo:job.repo,pr:job.pr,commentId:job.thread?.commentId});
  noteJobHistory(job);
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
      if (controlResultLogged(r)) console.warn(`[review-loop] start ${job.owner}/${job.repo}#${job.pr}: ${r.reason}`);
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
  const run = (label: string, step: (token: string) => Promise<ControlResult>) => {
    void (async () => {
      try {
        const r = await step(await installationToken(installationId));
        if (!r.posted && /failed|in flight/.test(r.reason)) loopControlClaims.release(deliveryId); // a redelivery may retry what did not land
        if (controlResultLogged(r)) console.warn(`[review-loop] ${label}: ${r.reason}`);
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
}): HarborFireResult & { pong?: boolean; ignored?: string; cancelled?: string[] } {
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
    noteDeliveryHistory(ev);
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
    noteDeliveryHistory(ev);
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
    noteDeliveryHistory(ev);
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 202, queued: false, pong: true };
  }

  if (parsed.kind === "closed") {
    const why = `pull request ${parsed.merged ? "merged" : "closed"}`;
    // A job created after the close (a redelivered or late "closed" behind a "reopened") is the
    // reopened PR's: kept. closed_at has whole-second resolution, so one created within that second
    // may still precede the close.
    const live = state.jobs.filter((j) => j.owner === parsed.owner && j.repo === parsed.repo && j.pr === parsed.pr && isLive(j.status) &&
      !(parsed.closedAt !== undefined && j.createdAt > parsed.closedAt + 1000));
    for (const j of live) {
      cancelLocalJsonRepairs("superseded", j.id);
      transitionJob(j.id, (cur) => (isLive(cur.status) ? { ...cur, status: "cancelled", skipReason: why, updatedAt: Date.now() } : cur));
    }
    const ev: WebhookLog = {
      id: nid("ev"),
      deliveryId: opts.deliveryId,
      event: opts.event,
      action: "closed",
      hmac: "ok",
      httpStatus: 202,
      at: Date.now(),
      summary: `${parsed.owner}/${parsed.repo}#${parsed.pr} ${why}: ${live.length} live job(s) cancelled`,
    };
    noteDeliveryHistory(ev);
    state = { ...state, events: trim([ev, ...state.events]) };
    return { httpStatus: 202, queued: false, cancelled: live.map((j) => j.id) };
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
      // The PR the ignored delivery is about (bot comments, reviews, pushes): lane tooling filters
      // webhook-driven signals by repo#pr, and a bare "<event> ignored" could not be attributed.
      summary: `${ignoredTarget(opts.payload)}${opts.event} ignored`,
      skipReason: parsed.reason,
    };
    noteDeliveryHistory(ev);
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

// Boot, once per process: hand off the fix rounds a restart cut — sessions left at FIXING with
// nothing running them (review-loop-runtime sweepCutFixRounds). Loop OFF: no GitHub call; never throws.
const BOOT_SWEPT = Symbol.for("ashlar.review-loop.boot-sweep");
if (!(globalThis as Record<symbol, unknown>)[BOOT_SWEPT]) {
  (globalThis as Record<symbol, unknown>)[BOOT_SWEPT] = true;
  void sweepCutFixRounds(state.settings);
}
