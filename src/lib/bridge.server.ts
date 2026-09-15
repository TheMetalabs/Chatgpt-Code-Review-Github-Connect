import { randomBytes, timingSafeEqual } from "node:crypto";
import { getHarbor, patchHarborJob, submitHarborChat, type ChatLeg } from "./harbor.server";
import type { Job, ReviewProvider } from "./types";
import { BRIDGE_CLAIM_MS, BRIDGE_CONNECTED_MS, isChatProvider, providersFromSettings } from "./types";
import { loadDotenvFile, writeEnvPatch } from "./dotenv-file.server";
import { BRIDGE_TOKEN_ENV, resolveBridgeToken } from "./bridge-token";

type BridgeMeta = {
  token: string;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
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

export type BridgeStatus = {
  token: string;
  connected: boolean;
  lastSeen: number;
  lastJobId?: string;
  lastError?: string;
};

export type BridgePublic = Omit<BridgeStatus, "token">;

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
  return rest;
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

const STALE_CLAIM = (job: Job) =>
  Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt > BRIDGE_CLAIM_MS);

export function nextBridgeJob(): {
  jobId: string;
  provider: ReviewProvider;
  providers: ReviewProvider[];
  prompt: string;
  prompts?: Partial<Record<ReviewProvider, string>>;
  reasoning: { chatgpt: string; grok: string };
  title: string;
  owner: string;
  repo: string;
  pr: number;
} | null {
  const harbor = getHarbor();
  const job = harbor.jobs.find(
    (j) =>
      j.status === "awaiting_chat" &&
      (Boolean(j.chatPrompt) || Boolean(j.chatPromptByProvider)) &&
      (!j.bridgeClaimedAt || STALE_CLAIM(j)),
  );
  if (!job) return null;
  const prompts = job.chatPromptByProvider;
  const rawProviders = job.fpProviders?.length
    ? job.fpProviders
    : job.reviewProviders?.length
      ? job.reviewProviders
      : providersFromSettings(harbor.settings);
  const providers = rawProviders.filter(isChatProvider);
  if (!providers.length) return null;
  const prompt = job.chatPrompt || prompts?.chatgpt || prompts?.grok || "";
  if (!prompt) return null;
  return {
    jobId: job.id,
    provider: providers[0],
    providers,
    prompt,
    prompts,
    reasoning: {
      chatgpt: harbor.settings.chatgptReasoning,
      grok: harbor.settings.grokReasoning,
    },
    title: job.title,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
  };
}

export function takeNextBridgeJob(): ReturnType<typeof nextBridgeJob> {
  const peek = nextBridgeJob();
  if (!peek) return null;
  const claimed = claimBridgeJob(peek.jobId);
  if (!claimed.ok) return null;
  return peek;
}

export function promptForJob(jobId: string): { prompt: string; prompts?: Partial<Record<ReviewProvider, string>> } | null {
  const job = getHarbor().jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return null;
  const prompt = job.chatPrompt || job.chatPromptByProvider?.chatgpt || job.chatPromptByProvider?.grok;
  if (!prompt) return null;
  return { prompt, prompts: job.chatPromptByProvider };
}

export function refreshBridgeClaim(jobId: string) {
  const job = getHarbor().jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat") return;
  patchHarborJob(jobId, (j) => ({ ...j, bridgeClaimedAt: Date.now(), updatedAt: Date.now() }));
  meta.lastJobId = jobId;
}

export function claimBridgeJob(jobId: string): { ok: true } | { ok: false; error: string } {
  const job = getHarbor().jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_chat" || !(job.chatPrompt || job.chatPromptByProvider)) {
    return { ok: false, error: "job is not waiting for chat" };
  }
  if (job.bridgeClaimedAt && !STALE_CLAIM(job)) {
    return { ok: false, error: "already claimed" };
  }
  patchHarborJob(jobId, (j) => ({
    ...j,
    bridgeClaimedAt: Date.now(),
    plan: "Chrome bridge claimed this job. ChatGPT/Grok tab is running the review.",
    updatedAt: Date.now(),
  }));
  meta.lastJobId = jobId;
  meta.lastError = undefined;
  return { ok: true };
}

export function releaseBridgeJob(jobId: string) {
  const job = getHarbor().jobs.find((j) => j.id === jobId);
  if (job && job.status === "awaiting_chat") {
    patchHarborJob(jobId, (j) => ({ ...j, bridgeClaimedAt: undefined, updatedAt: Date.now() }));
  }
}

export async function completeBridgeJob(jobId: string, raw: string, legs?: ChatLeg[]) {
  const out = await submitHarborChat(jobId, raw, legs);
  if (!out.ok) {
    releaseBridgeJob(jobId);
    meta.lastError = out.error;
    return out;
  }
  meta.lastJobId = jobId;
  meta.lastError = undefined;
  return out;
}
