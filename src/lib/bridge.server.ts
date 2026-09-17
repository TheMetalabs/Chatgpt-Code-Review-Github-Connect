import { randomBytes, timingSafeEqual } from "node:crypto";
import { getHarbor, patchHarborJob, submitHarborChat, type ChatLeg } from "./harbor.server";
import type { Job, ReviewProvider, ProviderError } from "./types";
import { BRIDGE_CLAIM_MS, BRIDGE_CONNECTED_MS, claimedReviewerNote, isChatProvider, providersFromSettings } from "./types";
import { llmWorkAllowed } from "./ops-comment";
import { extractChatJson } from "./extract-chat-json";
import { loadDotenvFile, writeEnvPatch } from "./dotenv-file.server";
import { BRIDGE_TOKEN_ENV, resolveBridgeToken } from "./bridge-token";

type BridgeMeta = {
  token: string;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
  lastTakeAt?: number;
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
    pendingJobs: getHarbor().jobs.filter(job => job.status === "awaiting_chat" && llmWorkAllowed(job) && pendingChatProviders(job).length > 0).length,
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

export function bridgeHeartbeat() {
  meta.lastSeen = Date.now();
}

/** This is an ownership lease, NOT a generation deadline. Expiry only enables resume. */
const STALE_CLAIM = (job: Job) => Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt > BRIDGE_CLAIM_MS);

function pendingChatProviders(job: Job): ReviewProvider[] {
  const providers = job.fpProviders?.length ? job.fpProviders : job.reviewProviders?.length
    ? job.reviewProviders : providersFromSettings(getHarbor().settings);
  return providers.filter(isChatProvider).filter(provider =>
    !(job.storedLegs ?? []).some(leg => leg.provider === provider && leg.raw.trim()) &&
    (!job.providerErrors?.[provider] || job.providerErrors[provider]?.code === "disconnected"),
  );
}

export function bridgeJobState(jobId: string) {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  return {active: job?.status === "awaiting_chat", status: job?.status ?? "missing"};
}

export function nextBridgeJob(clientId = "", excludeJobIds: readonly string[] = []): {
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
  for (const job of harbor.jobs) {
    if (excludeJobIds.includes(job.id) || job.status !== "awaiting_chat" || !llmWorkAllowed(job)) continue;
    if (job.bridgeClaimedAt && !STALE_CLAIM(job)) continue;
    const providers = pendingChatProviders(job);
    if (!providers.length) continue;
    const attempted = job.attemptedProviders ?? [];
    // Only the owning Chrome profile has the original tab. Never start a replacement
    // generation from another profile merely because the heartbeat expired.
    if (attempted.length && job.bridgeClientId && job.bridgeClientId !== clientId) continue;
    const prompts = job.chatPromptByProvider;
    const prompt = job.chatPrompt || prompts?.chatgpt || prompts?.grok || "";
    if (!prompt) continue;
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

export function takeNextBridgeJob(clientId = "", excludeJobIds: readonly string[] = []): ReturnType<typeof nextBridgeJob> {
  meta.lastTakeAt = Date.now();
  const job = nextBridgeJob(clientId, excludeJobIds);
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

export function promptForJob(jobId: string): {prompt: string; prompts?: Partial<Record<ReviewProvider, string>>} | null {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !llmWorkAllowed(job)) return null;
  const prompt = job.chatPrompt || job.chatPromptByProvider?.chatgpt || job.chatPromptByProvider?.grok;
  return prompt ? {prompt, prompts: job.chatPromptByProvider} : null;
}

function ownsLease(job: Job, leaseId?: string): boolean {
  return Boolean(job.bridgeClaimedAt) && (!job.bridgeLeaseId || job.bridgeLeaseId === leaseId);
}

export function refreshBridgeClaim(
  jobId: string,
  generating?: Partial<Record<ReviewProvider, boolean>>,
  errors?: Partial<Record<ReviewProvider, ProviderError>>,
  leaseId?: string,
): boolean {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return false;
  patchHarborJob(jobId, current => {
    const nextGenerating = {...current.generating};
    const nextErrors = {...current.providerErrors};
    const enabled = pendingChatProviders(current);
    for (const provider of enabled) {
      const error = errors?.[provider];
      if (error) {
        nextErrors[provider] = error;
        nextGenerating[provider] = error.code === "disconnected";
      } else if (generating?.[provider] === true) {
        delete nextErrors[provider];
        nextGenerating[provider] = true;
      }
      // A bare false flag says nothing about completion. Final JSON is stored by complete;
      // terminal failures require their explicit provider-specific outcome.
    }
    return {...current, bridgeClaimedAt: Date.now(), generating: nextGenerating, providerErrors: nextErrors, updatedAt: Date.now()};
  });
  meta.lastJobId = jobId;
  return true;
}

export function claimBridgeJob(jobId: string, clientId = ""): {ok: true; leaseId: string} | {ok: false; error: string} {
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
    ...current, bridgeClaimedAt: Date.now(), bridgeLeaseId: leaseId, bridgeClientId: clientId,
    plan: claimedReviewerNote(current.fpProviders?.length ? current.fpProviders : current.reviewProviders ?? []),
    updatedAt: Date.now(),
  }));
  meta.lastJobId = jobId;
  meta.lastError = undefined;
  return {ok: true, leaseId};
}

export function releaseBridgeJob(jobId: string, leaseId?: string) {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return;
  patchHarborJob(jobId, current => ({
    ...current, bridgeClaimedAt: undefined, bridgeLeaseId: undefined, updatedAt: Date.now(),
    // Keep attempts and terminal outcomes. Release is not authorization for a new generate.
  }));
}

/** Explicit terminal outcome; transient disconnection is reported by ping instead. */
export function failBridgeProvider(jobId: string, provider: ReviewProvider, error: string, leaseId?: string): boolean {
  if (!isChatProvider(provider)) return false;
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return true;
  if (!llmWorkAllowed(job) || !ownsLease(job, leaseId)) return false;
  if (job.storedLegs?.some(leg => leg.provider === provider && leg.raw.trim())) return true;
  const enabled = job.fpProviders?.length ? job.fpProviders : job.reviewProviders ?? [];
  if (!enabled.includes(provider)) return false;
  const prefix = error.split(":", 1)[0];
  const code: ProviderError["code"] = prefix === "quota" || prefix === "empty" || prefix === "tab_closed" || prefix === "cancelled"
    ? prefix : "error";
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
  return true;
}

export async function completeBridgeJob(jobId: string, raw: string, legs?: ChatLeg[], leaseId?: string) {
  const job = getHarbor().jobs.find(j => j.id === jobId);
  if (!job) return {ok: false, error: "job not found"};
  const incoming = (legs?.length ? legs : raw.trim() ? [{provider: "chatgpt" as const, raw}] : [])
    .map(leg => ({...leg, raw: extractChatJson(leg.raw) ?? leg.raw}));
  // Compare normalized payloads as stored, including after posting changed job status.
  if (incoming.length && incoming.every(leg => job.storedLegs?.some(stored => stored.provider === leg.provider && stored.raw === leg.raw))) {
    return {ok: true};
  }
  if (job.status !== "awaiting_chat" || !ownsLease(job, leaseId)) return {ok: false, error: "job is not claimed by this worker", code: "lease_conflict"};
  const enabled = job.fpProviders?.length ? job.fpProviders : job.reviewProviders?.length ? job.reviewProviders : providersFromSettings(getHarbor().settings);
  const accepted: ChatLeg[] = [];
  for (const leg of incoming) {
    if (!isChatProvider(leg.provider) || !enabled.includes(leg.provider)) continue;
    const parsed = extractChatJson(leg.raw);
    if (!parsed) return {ok: false, error: "completed response is not review JSON"};
    accepted.push({provider: leg.provider, raw: parsed});
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
