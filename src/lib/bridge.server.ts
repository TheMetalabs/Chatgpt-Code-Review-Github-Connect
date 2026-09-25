import {mergeWorkerStatus, workerStatusIsFresh, type WorkerStatus} from "./bridge-worker-status";
import {JsonRepairService, localJsonRepairAvailable, cancelLocalJsonRepairs} from "./json-repair.server";
import type {RepairInput} from "./json-repair.server";
import {inspectReviewFormat} from "./review-json-repair";
import type {RepairRecord} from "./json-repair-types";
import {reviewHistory} from "./review-history.server";
import {sanitizeProgressEvents} from "./review-progress";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getHarbor, patchHarborJob, submitHarborChat, type ChatLeg } from "./harbor.server";
import type { Job, ReviewProvider, ProviderError } from "./types";
import { BINDING_LOST_MS, BRIDGE_CLAIM_MS, BRIDGE_CONNECTED_MS, claimedReviewerNote, fixKnob, isChatProvider, providersFromSettings } from "./types";
import { llmWorkAllowed } from "./ops-comment";
import { extractChatJson, salvageReviewJson } from "./extract-chat-json";
import { loadDotenvFile, writeEnvPatch } from "./dotenv-file.server";
import { BRIDGE_TOKEN_ENV, resolveBridgeToken } from "./bridge-token";
import { createFixRegistry, isFixItemId, type FixItemSummary, type FixOffer, type FixRequest } from "./bridge-fix.server";
import { createdBefore } from "./creation-seq";

type BridgeMeta = {
  token: string;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
  lastTakeAt?: number;
  workerStatus?: WorkerStatus;
};

function newToken() {
  return randomBytes(18).toString("base64url");
}

function persistToken(token: string) {
  process.env[BRIDGE_TOKEN_ENV] = token;
  if (process.env.NODE_TEST_CONTEXT) return;
  try {
    writeEnvPatch({ [BRIDGE_TOKEN_ENV]: token });
  } catch {
    /* .env may be missing or read-only */
  }
}

function loadToken(): string {
  loadDotenvFile();
  const resolved = resolveBridgeToken(process.env[BRIDGE_TOKEN_ENV], newToken);
  if (resolved.persist) persistToken(resolved.token);
  else process.env[BRIDGE_TOKEN_ENV] = resolved.token;
  return resolved.token;
}

let meta: BridgeMeta = { token: loadToken(), lastSeen: 0 };
// Diagnostic only, never used as authorization or to cancel a generation.
const serverInstanceId = randomBytes(12).toString("base64url");

export type BridgeStatus = {
  token: string;
  connected: boolean;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
};

export type BridgePublic = Omit<BridgeStatus, "token"> & {
  protocolVersion: 1;
  serverInstanceId: string;
  pendingJobs: number;
  lastTakeAt?: number;
  repairProtocol: 1;
  captureProtocol: 1;
  recoveryProtocol: 1;
  workerStatus?: WorkerStatus;
  workerStatusFresh: boolean;
  localJsonRepairEnabled: boolean;
  /** Live review-loop fix items (queued + claimed); never counted in pendingJobs. */
  pendingFixes: number;
  /** Every fix item the registry still holds (live and recently settled): state and timing only. */
  fixItems: FixItemSummary[];
};

export function getBridgeStatus(): BridgeStatus {
  return {
    token: meta.token,
    connected: meta.lastSeen > 0 && Date.now() - meta.lastSeen < BRIDGE_CONNECTED_MS,
    lastSeen: meta.lastSeen,
    lastJobId: meta.lastJobId,
    lastError: meta.lastError,
  };
}

export function getBridgePublic(): BridgePublic {
  const { token: _t, ...rest } = getBridgeStatus();
  return {...rest, protocolVersion: 1, serverInstanceId, lastTakeAt: meta.lastTakeAt,
    workerStatus: meta.workerStatus,
    workerStatusFresh: workerStatusIsFresh(meta.workerStatus, Date.now(), BRIDGE_CONNECTED_MS),
    repairProtocol: 1, captureProtocol: 1, recoveryProtocol: 1, localJsonRepairEnabled: localJsonRepairAvailable(getHarbor().settings),
    pendingJobs: getHarbor().jobs.filter(job => job.status === "awaiting_chat" && llmWorkAllowed(job) && pendingChatProviders(job).length > 0).length,
    pendingFixes: fixLiveCount(),
    fixItems: fixes().summaries(),
  };
}

export function rotateBridgeToken() {
  const token = newToken();
  persistToken(token);
  meta = { token, lastSeen: 0 };
  return getBridgeStatus();
}

export function bridgeTokenOk(provided: string | null | undefined) {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(meta.token);
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bridgeHeartbeat(report?: unknown, extensionVersion?: unknown) {
  meta.lastSeen = Date.now();
  if (report !== undefined) {
    // Malformed reports cannot turn a stale/blocked worker into a healthy one.
    meta.workerStatus = mergeWorkerStatus(meta.workerStatus, report, extensionVersion, meta.lastSeen);
  }
}

/** This is an ownership lease, NOT a generation deadline. Expiry only enables resume. */
const STALE_CLAIM = (job: Job) => Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt > BRIDGE_CLAIM_MS);

// Foreground-submission serialization. A review tab is opened active:true (steals focus)
// and prompt insertion (execCommand) needs the foreground, so a second tab opened while
// the first is still submitting clobbers it ("Submission unconfirmed · no automatic
// resend"). Do not hand a Chrome profile a new job while it is still submitting one
// (claimed, not yet generating). Bounded so a stuck submission never blocks forever.
const SUBMIT_WINDOW_MS = 3 * 60_000;
function isGenerating(job: Job): boolean {
  return Object.values(job.generating ?? {}).some((v) => v === true);
}
function submissionInFlightForClient(jobs: readonly Job[], clientId: string): boolean {
  if (!clientId) return false;
  return jobs.some(
    (j) =>
      j.bridgeClientId === clientId &&
      j.status === "awaiting_chat" &&
      Boolean(j.bridgeClaimedAt) &&
      !STALE_CLAIM(j) &&
      !isGenerating(j) &&
      j.bridgeSubmitAt !== undefined &&
      Date.now() - j.bridgeSubmitAt < SUBMIT_WINDOW_MS,
  );
}

// ── Review-loop fix items (bridge-fix.server.ts) ─────────────────────────────
// A fix is NOT a harbor Job. Every per-id handler below branches on the `fix-` prefix FIRST, so a
// fix never meets the review lifecycle, review-JSON validation, capture or repair.
let fixRegistry: ReturnType<typeof createFixRegistry> | undefined;
function fixes() {
  return (fixRegistry ||= createFixRegistry({
    now: () => Date.now(),
    newId: () => randomBytes(18).toString("base64url"),
    parallelLimit: () => getHarbor().settings.fixAgent?.parallelPrs ?? 1,
    reasoning: () => ({chatgpt: getHarbor().settings.chatgptReasoning, grok: getHarbor().settings.grokReasoning}),
    // Settings (fixAgent.chatTimeoutMs / chatMaxPromptChars), read per request: no restart.
    timeoutMs: () => fixKnob(getHarbor().settings.fixAgent, "chatTimeoutMs"),
    maxPromptChars: () => fixKnob(getHarbor().settings.fixAgent, "chatMaxPromptChars"),
    claimMs: BRIDGE_CLAIM_MS,
    submitWindowMs: SUBMIT_WINDOW_MS,
    bindingLostMs: BINDING_LOST_MS,
    // unref: a pending fix deadline must never keep the server (or a test runner) alive.
    setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }));
}
function fixLiveCount() {
  const {queued, claimed} = fixes().counts();
  return queued + claimed;
}

/** Review-loop fix transport for chatgpt/grok: queue the prompt for a Chrome chat tab and resolve
 * with the model's answer TEXT (rejects on failure / deadline / supersede — see bridge-fix.server.ts). */
export function requestBridgeFix(request: FixRequest): Promise<string> {
  return fixes().request(request);
}

export function isBridgeFixId(jobId: unknown): boolean {
  return isFixItemId(jobId);
}

/** THE fix-protocol gate: every operation on a review-loop fix item needs the worker's
 * fixProtocol:2 opt-in (FIX_PROTOCOL; a worker without it cannot harvest a plain-text fix answer
 * and would wait
 * for review JSON forever). The route applies it once, before dispatching any action:
 * - per-id operations on a `fix-` id (claim, ping, prompt, progress, release, failure, complete and
 *   the review-only observe/capture/repair lanes) are refused (409 fix_protocol_required) and
 *   never touch the item;
 * - take offers a fix item only to an opted-in worker (takeNextBridgeJob `fixes`);
 * - recover skips fix bindings for a worker that has not opted in (recoverBridgeJob `fixes`);
 *   its review bindings are recovered as before.
 * Review operations are unchanged. True when the operation must be refused. */
/** 2 since #93: a fix request carries its source as a file attachment (fix-attachment.ts). A
 * protocol-1 worker would type that frame into the composer, pasting the source inline, so it is
 * never offered, nor allowed to operate, a fix item. */
export const FIX_PROTOCOL = 2;

export function fixOperationRefused(jobId: unknown, fixProtocol: unknown): boolean {
  return isFixItemId(jobId) && fixProtocol !== FIX_PROTOCOL;
}

/** A fix answer is plain text for the runtime's deterministic parser: resolved as-is (the page's
 * full text), never review-validated, salvaged or archived as a review. */
export function completeBridgeFix(jobId: string, raw: string, legs: ChatLeg[] | undefined, leaseId?: string) {
  const leg = legs?.[0];
  const out = fixes().complete(jobId, leg?.provider, leg ? leg.originalText || leg.raw : raw, leaseId);
  if (out.ok) {
    meta.lastJobId = jobId;
    meta.lastError = undefined;
  }
  return out;
}

/** Fix progress is diagnostics only (a timeout names the last stage); it never enters review history. */
function recordFixProgress(jobId: string, leaseId: string | undefined, reports: unknown): boolean {
  const provider = fixes().providerOf(jobId);
  if (!provider || !reports || typeof reports !== "object" || Array.isArray(reports)) return false;
  const report = (reports as Record<string, unknown>)[provider];
  const events = report && typeof report === "object" ? sanitizeProgressEvents((report as {events?: unknown}).events) : [];
  const latest = events.reduce<(typeof events)[number] | undefined>((last, event) => (!last || event.at >= last.at ? event : last), undefined);
  const runId = (report as {runId?: unknown} | undefined)?.runId;
  return fixes().progress(jobId, leaseId, latest?.stage, typeof runId === "string" && runId.length <= 128 ? runId : undefined);
}

/** The oldest queued fix unless an eligible review is older. Neither kind starves: live fixes
 * are bounded by fixAgent.parallelPrs and their deadline; a review waits for at most the fixes
 * requested before it. A review without a known age keeps today's precedence. A fix blocked by an
 * older review names that OLDEST review (`reviewFirst`) so the caller dispatches it rather than
 * nextBridgeJob's newest-first candidate: otherwise a stream of newer reviews would starve the
 * fix while the old review never ran. */
function takeFix(clientId: string, excludeJobIds: readonly string[], review: ReturnType<typeof nextBridgeJob>): {fix?: FixOffer; reviewFirst?: string} {
  // nextBridgeJob is null while a review submission is in flight; a fix must wait for it too.
  if (submissionInFlightForClient(getHarbor().jobs, clientId)) return {};
  const next = fixes().peek(excludeJobIds, clientId);
  if (!next) return {};
  if (review) {
    // The OLDEST review this profile could take, not the candidate (harbor lists jobs newest
    // first): a fix never jumps ahead of a review requested before it.
    const waiting = getHarbor().jobs.filter(j => reviewEligible(j, clientId, excludeJobIds));
    // A review of unknown age keeps today's precedence (the candidate goes first).
    if (!waiting.length || !waiting.every(j => Number.isFinite(j.createdAt))) return {};
    // Creation order is (createdAt, createdSeq): one sequence spans both kinds, so a fix created
    // in the same millisecond as an earlier review still waits for it. A review without a
    // sequence (created before it existed) ties as today: the fix goes first.
    const oldest = waiting.reduce((a, b) => (createdBefore(b, a) ? b : a));
    if (createdBefore(oldest, next)) return {reviewFirst: oldest.id};
  }
  const offer = fixes().take(next.id, clientId);
  if (offer) {
    meta.lastJobId = offer.jobId;
    meta.lastError = undefined;
  }
  return offer ? {fix: offer} : {};
}

function pendingChatProviders(job: Job): ReviewProvider[] {
  const providers = job.fpProviders?.length ? job.fpProviders : job.reviewProviders?.length
    ? job.reviewProviders : providersFromSettings(getHarbor().settings);
  return providers.filter(isChatProvider).filter(provider =>
    !(job.storedLegs ?? []).some(leg => leg.provider === provider && leg.raw.trim()) &&
    (!job.providerErrors?.[provider] || job.providerErrors[provider]?.code === "disconnected"),
  );
}

/** The leg's binding has been reported unavailable for BINDING_LOST_MS with no bound run since. */
function bindingLostExpired(job: Job, provider: ReviewProvider, now: number): boolean {
  const since = job.bindingLostAt?.[provider];
  return since !== undefined && now - since >= BINDING_LOST_MS && job.providerErrors?.[provider]?.code === "disconnected";
}

/** Settle every leg whose original binding stayed unavailable past BINDING_LOST_MS as a provider
 * failure, so its job ends instead of waiting unboundedly: the worker's heartbeats keep the claim
 * fresh (never re-offered) and `disconnected` is not terminal. Runs on each heartbeat and on each
 * take, so a worker that stopped heartbeating is bounded too. */
function settleLostBindings(jobs: readonly Job[]) {
  const now = Date.now();
  for (const job of [...jobs]) {
    if (job.status !== "awaiting_chat") continue;
    const lost = pendingChatProviders(job).filter(provider => bindingLostExpired(job, provider, now));
    if (!lost.length) continue;
    const message = `original job binding unavailable for ${Math.round(BINDING_LOST_MS / 60_000)} min with no bound run reported`;
    patchHarborJob(job.id, current => {
      const next = {...current, generating: {...current.generating}, providerErrors: {...current.providerErrors},
        bindingLostAt: {...current.bindingLostAt}, assumptions: [...(current.assumptions ?? [])], updatedAt: now};
      for (const provider of lost) {
        next.generating[provider] = false;
        next.providerErrors[provider] = {code: "error", message};
        delete next.bindingLostAt[provider];
        next.assumptions = [...next.assumptions.filter(note => !note.startsWith(`Skipped ${provider}:`)), `Skipped ${provider}: ${message}`];
      }
      return next;
    });
    for (const provider of lost) cancelLocalJsonRepairs("superseded", job.id, provider);
  }
}

export function bridgeJobState(jobId: string) {
  if (isFixItemId(jobId)) return fixes().state(jobId);
  const job = getHarbor().jobs.find(j => j.id === jobId);
  return {active: job?.status === "awaiting_chat", status: job?.status ?? "missing"};
}

/** A review job this Chrome profile may take now (nextBridgeJob's filter; takeFix orders by it). */
function reviewEligible(job: Job, clientId: string, excludeJobIds: readonly string[]): boolean {
  if (excludeJobIds.includes(job.id) || job.status !== "awaiting_chat" || !llmWorkAllowed(job)) return false;
  if (job.bridgeClaimedAt && !STALE_CLAIM(job)) return false;
  if (!pendingChatProviders(job).length) return false;
  // Only the owning Chrome profile has the original tab. Never start a replacement
  // generation from another profile merely because the heartbeat expired.
  const attempted = job.attemptedProviders ?? [];
  if (attempted.length && job.bridgeClientId && job.bridgeClientId !== clientId) return false;
  const prompts = job.chatPromptByProvider;
  return Boolean(job.chatPrompt || prompts?.chatgpt || prompts?.grok);
}

export function nextBridgeJob(clientId = "", excludeJobIds: readonly string[] = [], onlyJobId?: string): {
  jobId: string;
  provider: ReviewProvider;
  providers: ReviewProvider[];
  resumeProviders: ReviewProvider[];
  leaseId?: string;
  prompt: string;
  prompts?: Partial<Record<ReviewProvider, string>>;
  reasoning: {chatgpt: string; grok: string};
  title: string;
  owner: string;
  repo: string;
  pr: number;
} | null {
  const harbor = getHarbor();
  // Only one foreground submission at a time per Chrome profile (see SUBMIT_WINDOW_MS).
  if (submissionInFlightForClient(harbor.jobs, clientId)) return null;
  for (const job of harbor.jobs) {
    if ((onlyJobId !== undefined && job.id !== onlyJobId) || !reviewEligible(job, clientId, excludeJobIds)) continue;
    const providers = pendingChatProviders(job);
    const attempted = job.attemptedProviders ?? [];
    const prompts = job.chatPromptByProvider;
    const prompt = job.chatPrompt || prompts?.chatgpt || prompts?.grok || "";
    return {
      jobId: job.id, provider: providers[0], providers,
      resumeProviders: providers.filter(p => attempted.includes(p)),
      prompt, prompts,
      reasoning: {chatgpt: harbor.settings.chatgptReasoning, grok: harbor.settings.grokReasoning},
      title: job.title, owner: job.owner, repo: job.repo, pr: job.pr,
    };
  }
  return null;
}

export type BridgeOffer = NonNullable<ReturnType<typeof nextBridgeJob>> | FixOffer;

/** `fixes` is the worker's fixProtocol:2 opt-in: a worker that cannot harvest a plain-text fix
 * answer (it would wait for review JSON forever) is never offered a fix item. */
export function takeNextBridgeJob(clientId = "", excludeJobIds: readonly string[] = [], options: {fixes?: boolean} = {}): BridgeOffer | null {
  meta.lastTakeAt = Date.now();
  settleLostBindings(getHarbor().jobs);
  // A fix tab pastes its prompt in the foreground exactly like a review tab: one submission per
  // Chrome profile across BOTH kinds (see SUBMIT_WINDOW_MS).
  if (fixes().submitting(clientId, excludeJobIds)) return null;
  let job = nextBridgeJob(clientId, excludeJobIds);
  const {fix, reviewFirst} = options.fixes ? takeFix(clientId, excludeJobIds, job) : {};
  if (fix) return fix;
  // A fix waits for the reviews requested before it: dispatch the oldest of those, not the
  // newest-first candidate, so newer reviews cannot starve the fix.
  if (reviewFirst && reviewFirst !== job?.jobId) job = nextBridgeJob(clientId, excludeJobIds, reviewFirst);
  if (!job) return null;
  const claim = claimBridgeJob(job.jobId, clientId);
  if (!claim.ok) return null;
  patchHarborJob(job.jobId, current => ({
    ...current,
    attemptedProviders: [...new Set([...(current.attemptedProviders ?? []), ...job.providers])],
    updatedAt: Date.now(),
  }));
  return {...job, leaseId: claim.leaseId};
}

/** Recover only the original profile's already-attempted, positively bound run.
 * This is NOT a capacity bypass for take/new generation and never widens providers.
 */
export function recoverBridgeJob(clientId: string, values: unknown, options: {fixes?: boolean} = {}) {
  if (!clientId || !Array.isArray(values) || values.length > 16) return null;
  const bindings = values.filter((item): item is {jobId:string;provider:"chatgpt"|"grok";runId:string} =>
    Boolean(item && typeof item === "object" && typeof item.jobId === "string" && item.jobId.length <= 160 &&
      isChatProvider(item.provider) && typeof item.runId === "string" && item.runId.length > 0 && item.runId.length <= 128));
  // A fix item's run is resumed the same way: same profile, provider and pinned run - and only for a
  // worker that opted into fix items (fixOperationRefused); an older worker's fix bindings are skipped.
  for (const binding of bindings) {
    if (!isFixItemId(binding.jobId) || options.fixes !== true) continue;
    const offer = fixes().recover(binding.jobId, clientId, binding.provider, binding.runId);
    if (offer) return offer;
  }
  const harbor=getHarbor();
  for (const id of new Set(bindings.map(item=>item.jobId))) {
    if (isFixItemId(id)) continue;
    const job=harbor.jobs.find(row=>row.id===id);
    if (!job || job.status!=="awaiting_chat" || !llmWorkAllowed(job) || job.bridgeClientId!==clientId ||
        job.chatFpRound || job.fpProviders?.length) continue;
    const pending=pendingChatProviders(job);
    const matched=bindings.filter(item=>item.jobId===id && pending.includes(item.provider) &&
      job.attemptedProviders?.includes(item.provider) && job.providerProgress?.[item.provider]?.runId===item.runId);
    if (!matched.length) continue;
    const claim=claimBridgeJob(id,clientId);
    if (!claim.ok) continue;
    const providers=[...new Set(matched.map(item=>item.provider))];
    return {jobId:id,leaseId:claim.leaseId,provider:providers[0],providers,resumeProviders:providers,
      bindings:providers.map(provider=>({jobId:id,provider,runId:matched.find(item=>item.provider===provider)!.runId})),
      prompt:job.chatPrompt || job.chatPromptByProvider?.[providers[0]] || "",prompts:job.chatPromptByProvider,
      reasoning:{chatgpt:harbor.settings.chatgptReasoning,grok:harbor.settings.grokReasoning},
      title:job.title,owner:job.owner,repo:job.repo,pr:job.pr};
  }
  return null;
}

export function promptForJob(jobId: string): {prompt: string; prompts?: Partial<Record<ReviewProvider, string>>} | null {
  if (isFixItemId(jobId)) return fixes().prompt(jobId);
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !llmWorkAllowed(job)) return null;
  const prompt = job.chatPrompt || job.chatPromptByProvider?.chatgpt || job.chatPromptByProvider?.grok;
  return prompt ? {prompt, prompts: job.chatPromptByProvider} : null;
}

function ownsLease(job: Job, leaseId?: string): boolean {
  return Boolean(job.bridgeClaimedAt) && (!job.bridgeLeaseId || job.bridgeLeaseId === leaseId);
}

/** Unparsed text is private diagnostic evidence, never a completed reviewer leg. */
export function recordBridgeObservation(jobId: string, leaseId: string | undefined, provider: string, runId: string, text: string, totalChars: number, truncated: boolean): boolean {
  const job=getHarbor().jobs.find(j=>j.id===jobId);
  if(!job || !ownsLease(job,leaseId) || !isChatProvider(provider as ReviewProvider) ||
     !(job.reviewProviders || []).includes(provider as ReviewProvider) ||
     job.providerProgress?.[provider as ReviewProvider]?.runId !== runId) return false;
  reviewHistory().recordJob(job);
  reviewHistory().recordObservation(jobId,provider as ReviewProvider,runId,text,totalChars,truncated);
  return true;
}

export function recordBridgeProgress(jobId: string, leaseId: string | undefined, reports: unknown): boolean {
  if (isFixItemId(jobId)) return recordFixProgress(jobId, leaseId, reports);
  const job=getHarbor().jobs.find(j=>j.id===jobId);
  if(!job || !ownsLease(job,leaseId) || !reports || typeof reports!=="object" || Array.isArray(reports))return false;
  // Validate all run identities before recording either provider (no partial batch).
  for (const provider of ["chatgpt", "grok"] as const) {
    const report=(reports as Record<string,unknown>)[provider] as {runId?:unknown} | undefined;
    if (job.providerProgress?.[provider] && report?.runId && job.providerProgress[provider]!.runId !== report.runId) return false;
  }
  const next={...job.providerProgress};
  for(const provider of ["chatgpt","grok"] as const){
    if(!(job.reviewProviders || []).includes(provider))continue;
    const value=(reports as Record<string,unknown>)[provider];if(!value || typeof value!=="object")continue;
    const report=value as Record<string,unknown>;
    if(typeof report.runId!=="string" || !report.runId || report.runId.length>128)continue;
    if(next[provider]?.runId && next[provider]!.runId!==report.runId)return false;
    const events=sanitizeProgressEvents(report.events);if(!events.length)continue;
    reviewHistory().recordJob(job);
    reviewHistory().recordProgress(jobId,provider,report.runId,events);
    const latest=events.reduce((a,b)=>b.at>=a.at?b:a);
    if(!next[provider] || latest.at>=next[provider]!.observedAt)next[provider]={runId:report.runId,stage:latest.stage,
      observedAt:latest.at,receivedAt:Date.now(),extensionVersion:typeof report.extensionVersion==="string"?report.extensionVersion.slice(0,40):undefined};
  }
  patchHarborJob(jobId,current=>({...current,providerProgress:next}));
  return true;
}

export function refreshBridgeClaim(
  jobId: string,
  generating?: Partial<Record<ReviewProvider, boolean>>,
  errors?: Partial<Record<ReviewProvider, ProviderError>>,
  leaseId?: string,
): boolean {
  if (isFixItemId(jobId)) {
    // Provider errors on a fix are terminal only via the explicit failure action, or once its
    // binding has stayed unavailable past BINDING_LOST_MS (a heartbeat must not hold it forever).
    const accepted = fixes().refresh(jobId, leaseId, generating, errors);
    if (accepted) meta.lastJobId = jobId;
    return accepted;
  }
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return false;
  patchHarborJob(jobId, current => {
    const nextGenerating = {...current.generating};
    const nextErrors = {...current.providerErrors};
    const lostAt = {...current.bindingLostAt};
    const enabled = pendingChatProviders(current);
    for (const provider of enabled) {
      const error = errors?.[provider];
      if (error) {
        nextErrors[provider] = error;
        nextGenerating[provider] = error.code === "disconnected";
        // The bound starts at the FIRST binding-less heartbeat of an unbroken run of them.
        if (error.code === "disconnected") lostAt[provider] ??= Date.now();
        else delete lostAt[provider];
      } else if (generating?.[provider] === true) {
        delete nextErrors[provider];
        delete lostAt[provider];
        nextGenerating[provider] = true;
      }
      // A bare false flag says nothing about completion. Final JSON is stored by complete;
      // terminal failures require their explicit provider-specific outcome.
    }
    return {...current, bridgeClaimedAt: Date.now(), generating: nextGenerating, providerErrors: nextErrors, bindingLostAt: lostAt, updatedAt: Date.now()};
  });
  settleLostBindings(getHarbor().jobs.filter(job => job.id === jobId));
  meta.lastJobId = jobId;
  return true;
}

export function claimBridgeJob(jobId: string, clientId = ""): {ok: true; leaseId: string} | {ok: false; error: string; code?: string} {
  if (isFixItemId(jobId)) {
    const out = fixes().claim(jobId, clientId);
    if (out.ok) {
      meta.lastJobId = jobId;
      meta.lastError = undefined;
    }
    return out;
  }
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !llmWorkAllowed(job) || !(job.chatPrompt || job.chatPromptByProvider)) {
    return {ok: false, error: "job is not waiting for chat"};
  }
  const attempted = new Set(job.attemptedProviders ?? []);
  if (job.bridgeClientId && job.bridgeClientId !== clientId &&
      pendingChatProviders(job).some(provider => attempted.has(provider))) {
    return {ok: false, error: "pending generation belongs to another Chrome profile"};
  }
  if (job.bridgeClaimedAt && !STALE_CLAIM(job)) {
    if (clientId && job.bridgeClientId === clientId && job.bridgeLeaseId) return {ok: true, leaseId: job.bridgeLeaseId};
    return {ok: false, error: "already claimed"};
  }
  const leaseId = randomBytes(18).toString("base64url");
  patchHarborJob(jobId, current => ({
    ...current, bridgeClaimedAt: Date.now(), bridgeSubmitAt: Date.now(), bridgeLeaseId: leaseId, bridgeClientId: clientId,
    plan: claimedReviewerNote(current.fpProviders?.length ? current.fpProviders : current.reviewProviders ?? []),
    updatedAt: Date.now(),
  }));
  meta.lastJobId = jobId;
  meta.lastError = undefined;
  return {ok: true, leaseId};
}

export function releaseBridgeJob(jobId: string, leaseId?: string) {
  if (isFixItemId(jobId)) {
    fixes().release(jobId, leaseId);
    return;
  }
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return;
  patchHarborJob(jobId, current => ({
    ...current, bridgeClaimedAt: undefined, bridgeSubmitAt: undefined, bridgeLeaseId: undefined, updatedAt: Date.now(),
    // Keep attempts and terminal outcomes. Release is not authorization for a new generate.
  }));
}

/** Explicit terminal outcome; transient disconnection is reported by ping instead. */
export function failBridgeProvider(jobId: string, provider: ReviewProvider, error: string, leaseId?: string): boolean {
  if (!isChatProvider(provider)) return false;
  if (isFixItemId(jobId)) return fixes().fail(jobId, provider, error, leaseId);
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return true;
  if (!llmWorkAllowed(job) || !ownsLease(job, leaseId)) return false;
  if (job.storedLegs?.some(leg => leg.provider === provider && leg.raw.trim())) return true;
  const enabled = job.fpProviders?.length ? job.fpProviders : job.reviewProviders ?? [];
  if (!enabled.includes(provider)) return false;
  const prefix = error.split(":", 1)[0];
  const code: ProviderError["code"] = prefix === "quota" || prefix === "empty" || prefix === "tab_closed" || prefix === "cancelled" ||
    prefix === "logged_out" ? prefix : "error";
  patchHarborJob(jobId, current => ({
    ...current,
    generating: {...current.generating, [provider]: false},
    providerErrors: {...current.providerErrors, [provider]: {code, message: error.slice(0, 240)}},
    attemptedProviders: [...new Set([...(current.attemptedProviders ?? []), provider])],
    assumptions: [
      ...(current.assumptions ?? []).filter(note => !note.startsWith(`Skipped ${provider}:`)),
      `Skipped ${provider}: ${error.replace(/\s+/g, " ").slice(0, 400)}`,
    ],
    updatedAt: Date.now(),
  }));
  // The explicit provider outcome wins over any queued/ready formatting work.
  // Scope cancellation to this leg: other reviewers and transient ping failures
  // must remain recoverable, irrespective of how long they have been pending.
  cancelLocalJsonRepairs("superseded", jobId, provider);
  return true;
}

export async function completeBridgeJob(jobId: string, raw: string, legs?: ChatLeg[], leaseId?: string) {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job) return {ok: false, error: "job not found"};
  const repairAvailable = localJsonRepairAvailable(getHarbor().settings);
  // Canonicalize a leg once: prefer extracted review JSON; when it is not schema-valid AND no repair
  // can fix it, salvage into a raw_review review. Doing this BEFORE the replay/dup check makes a
  // lost-ack retry of the same prose normalize identically to the stored salvage (idempotent), and
  // catches schema-invalid (not only syntactically broken) replies so none is silently dropped.
  const canonicalLegRaw = (text: string): string => {
    const parsed = extractChatJson(text);
    if (repairAvailable) return parsed ?? text; // route 422s schema errors for a real repair
    return parsed && inspectReviewFormat(parsed, "review").ok ? parsed : salvageReviewJson(text);
  };
  const incoming = (legs?.length ? legs : raw.trim() ? [{provider: "chatgpt" as const, raw}] : [])
    .map(leg => {
      const canonical = canonicalLegRaw(leg.raw);
      // Keep the exact model prose for the archive even if the client omitted originalText and we
      // transformed raw (extract/salvage), so the async recordResponse cannot later overwrite the
      // first archive entry with an empty original.
      const originalText = leg.originalText || (canonical !== leg.raw ? leg.raw : undefined);
      return {...leg, raw: canonical, originalText};
    })
    .map(leg => {
      // An identical replay acknowledges the stored repair, not new provenance.
      const stored = job.storedLegs?.find(stored => stored.provider === leg.provider && stored.repair && stored.raw === leg.raw);
      return stored ?? leg;
    });
  // Compare normalized payloads as stored, including after posting changed job status.
  if (incoming.length && incoming.every(leg => job.storedLegs?.some(stored => stored.provider === leg.provider && stored.raw === leg.raw))) {
    try {
      reviewHistory().recordJob(job);
      for (const leg of incoming) reviewHistory().recordResponse(jobId, leg.provider, leg.raw, leg.originalText || "");
    } catch { return {ok: false, error: "response history storage unavailable; original reply must be retained", code: "history_unavailable"}; }
    return {ok: true};
  }
  if (incoming.some(leg => job.storedLegs?.some(stored => stored.provider === leg.provider && stored.repair && stored.raw !== leg.raw)))
    return {ok:false,error:"the provider result is already committed",code:"lease_conflict"};
  if (job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return {ok: false, error: "job is not claimed by this worker", code: "lease_conflict"};
  const enabled = job.fpProviders?.length ? job.fpProviders : job.reviewProviders?.length ? job.reviewProviders : providersFromSettings(getHarbor().settings);
  const accepted: ChatLeg[] = [];
  for (const leg of incoming) {
    if (!isChatProvider(leg.provider) || !enabled.includes(leg.provider)) continue;
    try {
      reviewHistory().recordJob(job);
      reviewHistory().recordResponse(jobId,leg.provider,leg.raw,leg.originalText || "");
    } catch {return {ok:false,error:"response archive unavailable; original response must be retained",code:"history_unavailable"};}
    const parsed = extractChatJson(leg.raw); // leg.raw is already canonical (valid review JSON, incl. salvage)
    if (!parsed) return {ok: false, error: "completed response is not review JSON"};
    accepted.push({...leg, raw: parsed});
  }
  if (!accepted.length) return {ok: false, error: "no enabled reviewer result"};
  patchHarborJob(jobId, current => {
    const storedLegs = [...(current.storedLegs ?? [])];
    const generating = {...current.generating};
    const providerErrors = {...current.providerErrors};
    for (const leg of accepted) {
      const index = storedLegs.findIndex(stored => stored.provider === leg.provider);
      if (index < 0) storedLegs.push(leg); else storedLegs[index] = leg;
      generating[leg.provider] = false;
      delete providerErrors[leg.provider];
    }
    // One patch: the watcher can never observe done-without-the-corresponding-payload.
    return {...current, storedLegs, generating, providerErrors, updatedAt: Date.now()};
  });
  for (const leg of accepted) if (!leg.repair) cancelLocalJsonRepairs("superseded", jobId, leg.provider);
  meta.lastJobId = jobId;
  meta.lastError = undefined;
  // ACK the already stored result now. Snapshot/validation/GitHub posting can be
  // slow and must not hold the Chrome delivery request open. The existing watcher
  // and status lock own downstream work; duplicate ACK retries never submit again.
  void Promise.resolve().then(() => submitHarborChat(jobId, accepted[0].raw, accepted))
    .then(out => { if (!out.ok && meta.lastJobId === jobId) meta.lastError = out.error; })
    .catch(error => {
      if (meta.lastJobId === jobId) meta.lastError = String(error?.message || error).slice(0, 240);
    });
  return {ok: true};
}


function currentRepairJob(input: RepairInput) {
  const job = getHarbor().jobs.find(row => row.id === input.jobId);
  return Boolean(job && job.status === "awaiting_chat" && llmWorkAllowed(job) &&
    job.headSha === input.headSha && !job.chatFpRound && !job.fpProviders?.length && input.schema === "review" &&
    job.reviewProviders?.includes(input.provider) && job.providerProgress?.[input.provider]?.runId === input.runId &&
    (!job.providerErrors?.[input.provider] || job.providerErrors[input.provider]?.code === "disconnected") &&
    !job.storedLegs?.some(leg => leg.provider === input.provider && leg.raw.trim()));
}
let repairService: JsonRepairService | undefined;
function repairs() {
  return repairService ||= new JsonRepairService({settings: () => getHarbor().settings, history: reviewHistory,
    isCurrent: currentRepairJob,
    isAccepted: record => Boolean(getHarbor().jobs.find(row => row.id === record.jobId)?.storedLegs?.some(leg =>
      leg.provider === record.provider && leg.repair?.id === record.id && leg.raw === record.raw)),
    accept: record => {
      const job = getHarbor().jobs.find(row => row.id === record.jobId);
      if (!job || !currentRepairJob(record)) return Promise.resolve({ok:false});
      return completeBridgeJob(record.jobId, record.raw!, [{provider:record.provider,raw:record.raw!,originalText:record.original,
        repair:{id:record.id,sourceHash:record.sourceHash,responseId:record.responseId,runId:record.runId,normalizedBy:"local"}}],job.bridgeLeaseId);
    },
  });
}
export function bridgeFormatErrors(jobId: string, raw: string, legs: ChatLeg[] | undefined, leaseId?: string, _captureProtocol = false): string[] {
  // Never demand a repair that cannot run: with local JSON repair off, a 422 makes the extension
  // hold for a repair that never happens (infinite pending). completeBridgeJob salvages instead.
  // (Independent of the capture protocol — capture only matters while a real repair can consume it.)
  if (!localJsonRepairAvailable(getHarbor().settings)) return [];
  const job=getHarbor().jobs.find(row=>row.id===jobId);
  if(!job || job.status!=="awaiting_chat" || !ownsLease(job,leaseId) || job.chatFpRound || job.fpProviders?.length) return [];
  return (legs?.length ? legs : [{provider:"chatgpt" as const,raw}]).flatMap(leg=>{
    if(!job.reviewProviders?.includes(leg.provider))return [];
    const check=inspectReviewFormat(extractChatJson(leg.raw) || leg.raw,"review");
    return check.ok ? [] : check.errors;
  }).slice(0,32);
}
export type BridgeRepairRequest = {
  jobId: string; leaseId?: string; provider?: string; runId?: string; responseId?: string; sourceHash?: string; repairId?: string; captureId?: string;
  source?: {captureId?: unknown; text?: unknown; totalChars?: unknown; truncated?: unknown; responseId?: unknown; completed?: unknown; stable?: unknown};
};
const sourceDigest = (text: string) => createHash("sha256").update(text).digest("hex");
function completedPageStage(jobId: string, provider: string, runId: string) {
  const pages = reviewHistory().getJob(jobId)?.steps.filter(step => step.source === "page" && step.provider === provider && step.runId === runId) || [];
  const latest = pages.reduce<(typeof pages)[number] | undefined>((last, item) =>
    !last || Number(item.id.split(":").at(-1)) > Number(last.id.split(":").at(-1)) ? item : last, undefined);
  return ["response_completed_json_invalid", "response_collected", "json_observed"].includes(latest?.stage || "");
}
/** Capture acknowledgement frees a browser resource, never settles the reviewer.
 * It does not depend on the formatter toggle. Full source is persisted, not the
 * truncated diagnostic preview. The owning page must revalidate before closing.
 */
export function captureBridgeSource(body: BridgeRepairRequest) {
  const job = getHarbor().jobs.find(row => row.id === body.jobId);
  if (!job || !ownsLease(job, body.leaseId) || !["chatgpt", "grok"].includes(body.provider || "") ||
      !job.reviewProviders?.includes(body.provider as ReviewProvider) || !body.runId ||
      job.providerProgress?.[body.provider as ReviewProvider]?.runId !== body.runId)
    return {ok:false as const, error:"capture_binding_mismatch", http:409};
  const source = body.source;
  if (!source || source.completed !== true || source.stable !== true || source.truncated !== false ||
      typeof source.text !== "string" || !source.text.trim() || source.text.length > 500000 ||
      source.totalChars !== source.text.length || typeof body.responseId !== "string" || !body.responseId ||
      body.responseId.length > 200 || source.responseId !== body.responseId || sourceDigest(source.text) !== body.sourceHash)
    return {ok:false as const, error:"invalid_capture_source", http:400};
  const id = sourceDigest(JSON.stringify(["source-v1",job.id,job.headSha,body.provider,body.runId,body.responseId,body.sourceHash]));
  const old = reviewHistory().getCapture(job.id,id);
  if (!old && (job.status !== "awaiting_chat" || !llmWorkAllowed(job) || job.chatFpRound || job.fpProviders?.length ||
      (job.providerErrors?.[body.provider as ReviewProvider] && job.providerErrors[body.provider as ReviewProvider]?.code !== "disconnected") ||
      job.storedLegs?.some(leg => leg.provider === body.provider && leg.raw.trim()) ||
      !completedPageStage(job.id,body.provider!,body.runId)))
    return {ok:false as const, error:"capture_not_current_or_complete", http:409};
  const record = reviewHistory().putCapture(old || {id,jobId:job.id,headSha:job.headSha,provider:body.provider as "chatgpt"|"grok",
    runId:body.runId,responseId:body.responseId,sourceHash:body.sourceHash!,text:source.text,at:Date.now()});
  const {text, ...capture} = record;
  return {ok:true as const, capture:{...capture,totalChars:text.length}, http:200};
}
/** Authenticated source read for a browserless pending formatter. The opaque
 * receipt is checked against every binding field; no inference is started here.
 */
export function readBridgeCapture(body: BridgeRepairRequest) {
  const job=getHarbor().jobs.find(row=>row.id===body.jobId);
  const record=typeof body.captureId === "string" ? reviewHistory().getCapture(body.jobId,body.captureId) : null;
  if(!record || record.provider!==body.provider || record.runId!==body.runId || record.responseId!==body.responseId ||
      record.sourceHash!==body.sourceHash || (job && (!ownsLease(job,body.leaseId) || job.headSha!==record.headSha)))
    return {ok:false as const,error:"capture_binding_mismatch",http:409};
  return {ok:true as const,capture:{...record,totalChars:record.text.length},http:200};
}
/** Short control RPC. Candidate readiness is never a final result ACK. */
export async function handleBridgeRepair(action: string, body: BridgeRepairRequest) {
  const job=getHarbor().jobs.find(row=>row.id===body.jobId);
  if(!job || !ownsLease(job,body.leaseId) || !["chatgpt","grok"].includes(body.provider || "") ||
     !job.reviewProviders?.includes(body.provider as ReviewProvider) || !body.runId ||
     job.providerProgress?.[body.provider as ReviewProvider]?.runId!==body.runId) return {ok:false as const,error:"repair_binding_mismatch",http:409};
  if(job.chatFpRound || job.fpProviders?.length) return {ok:false as const,error:"repair_stage_not_supported",http:409};
  if(action==="repair") {
    if(!localJsonRepairAvailable(getHarbor().settings))return {ok:true as const,repair:{status:"disabled" as const},http:200};
    const source=body.source;
    if(typeof body.responseId!=="string" || !body.responseId || body.responseId.length>200 || typeof body.sourceHash!=="string" ||
       !source || source.completed!==true || source.stable!==true || source.truncated!==false ||
       source.responseId!==body.responseId || typeof source.text!=="string" || source.totalChars!==source.text.length || source.text.length>500000)
      return {ok:false as const,error:"invalid_repair_source",http:400};
    // Once the exact completed source has been escrowed and released by the
    // page, formatting no longer needs a live tab. A supplied archive identity
    // must match every source field; it is not permission to substitute content.
    const captured = typeof source.captureId === "string" ? reviewHistory().getCapture(job.id,source.captureId) : null;
    if (source.captureId !== undefined && (!captured || captured.provider !== body.provider || captured.runId !== body.runId ||
        captured.headSha !== job.headSha || captured.responseId !== body.responseId || captured.sourceHash !== body.sourceHash || captured.text !== source.text))
      return {ok:false as const,error:"capture_binding_mismatch",http:409};
    if (!captured && !completedPageStage(job.id,body.provider!,body.runId))
      return {ok:false as const,error:"completion_not_observed",http:409};
    const input:RepairInput={jobId:body.jobId,provider:body.provider as "chatgpt"|"grok",runId:body.runId,
      responseId:body.responseId,sourceHash:body.sourceHash,original:source.text,headSha:job.headSha,schema:"review"};
    try{return {ok:true as const,repair:repairs().start(input),http:200};}
    catch(error){if(error instanceof Error && error.message==="invalid_repair_source")return {ok:false as const,error:error.message,http:400};throw error;}
  }
  const record=body.repairId ? reviewHistory().getRepair(body.jobId,body.repairId) : null;
  if(!record || record.provider!==body.provider || record.runId!==body.runId || record.responseId!==body.responseId ||
     record.sourceHash!==body.sourceHash || record.headSha!==job.headSha)return {ok:false as const,error:"repair_binding_mismatch",http:409};
  return {ok:true as const,repair:action==="repair-commit" ? await repairs().commit(body.jobId,record.id) : repairs().status(body.jobId,record.id),http:200};
}
