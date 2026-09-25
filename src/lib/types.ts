import type {RepairReceipt} from "./json-repair-types.ts";
import type { ProviderProgress } from "./review-progress.ts";
import type { ChatgptReasoning, GrokReasoning } from "./reasoning.ts";
import type { ReviewLoopDirective } from "./review-loop.ts";

/** null means the head repository provenance is not established. */
export type ForkStatus = boolean | null;

export type Severity = "P0" | "P1" | "P2";
export type FindingStatus = "candidate" | "accepted" | "dropped";
export type MergeRec = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
export type JobStatus =
  | "queued"
  | "snapshot"
  | "explorer"
  | "reviewer"
  | "awaiting_chat"
  | "validator"
  | "posting"
  | "posted"
  | "skipped"
  | "dlq"
  | "cancelled";

export type ReviewProvider = "chatgpt" | "grok" | "local";

/** How the local reviewer leg runs. "single" is the one-shot prompt (browser-parity, rollback);
 * "multiturn" runs the SDK tool loop that reads files and iterates; "auto" picks single for a PR
 * that fits one completion window and multiturn for a larger one. Only the local leg has an SDK, so
 * only it can do this — ChatGPT/Grok stay one-shot browser tabs. */
export type LocalReviewMode = "single" | "multiturn" | "auto";

export const LOCAL_REVIEW_MODES: LocalReviewMode[] = ["single", "multiturn", "auto"];

export const CHAT_PROVIDERS: ReviewProvider[] = ["chatgpt", "grok"];

export function isChatProvider(p: ReviewProvider): p is "chatgpt" | "grok" {
  return p === "chatgpt" || p === "grok";
}

export type Trigger =
  | "pull_request.opened"
  | "pull_request.reopened"
  | "pull_request.synchronize"
  | "pull_request.ready_for_review"
  | "pull_request.body_mention"
  | "issue_comment.mention"
  | "pull_request_review_comment.followup";

export interface Finding {
  id: string;
  status: FindingStatus;
  severity: Severity;
  file: string;
  line: number;
  side: "RIGHT" | "LEFT";
  title: string;
  failureScenario: string;
  rootCause: string;
  evidence: string;
  recommendedFix: string;
  recommendedTest: string;
  dropReason?: string;
}

export interface ToolTrace {
  id: string;
  pass: "explorer" | "reviewer" | "validator";
  tool: string;
  args: string;
  result: string;
  ms: number;
  at: number;
}

export interface JobThread {
  kind: "mention" | "followup" | "pr_body";
  commentId: number;
  userText: string;
  /** Parsed `/review-loop*` directive when the trigger body carried one (design §2). */
  loop?: ReviewLoopDirective;
  /** When the directive happened (the webhook's event time): a recorded loop start carries it. */
  eventAt?: string;
}

export interface Job {
  id: string;
  deliveryId: string;
  trigger: Trigger;
  owner: string;
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  baseSha: string;
  sender: string;
  isFork: ForkStatus;
  isDraft: boolean;
  thread?: JobThread;
  status: JobStatus;
  skipReason?: string;
  createdAt: number;
  /** Process-wide creation order shared with review-loop fix items (creation-seq.ts); breaks a
   * createdAt tie in the bridge's cross-kind take order. Absent on jobs created before it existed. */
  createdSeq?: number;
  updatedAt: number;
  ingressMs: number;
  traces: ToolTrace[];
  plan: string;
  candidates: Finding[];
  findings: Finding[];
  mergeRecommendation?: MergeRec;
  highestRisk?: string;
  // Verbatim model reply kept when it was not parseable review JSON and local repair was off;
  // surfaced in the review body for the fixing agent (see salvageReviewJson).
  rawReview?: string;
  investigatedSafe: string[];
  assumptions: string[];
  postedReviewId?: string;
  sampleKey?: string;
  origin?: "tape" | "github";
  installationId?: number;
  postedToGithub?: boolean;
  githubError?: string;
  chatPrompt?: string;
  chatPromptByProvider?: Partial<Record<ReviewProvider, string>>;
  bridgeClaimedAt?: number;
  /** Foreground-submission start; NOT refreshed by keepalive. Serializes the tab-focus window. */
  bridgeSubmitAt?: number;
  /** Ownership lease only, never a deadline for queueing or generation. */
  bridgeLeaseId?: string;
  bridgeClientId?: string;
  providerProgress?: Partial<Record<ReviewProvider, ProviderProgress>>;
  providerErrors?: Partial<Record<ReviewProvider, ProviderError>>;
  reviewProviders?: ReviewProvider[];
  fpProviders?: ReviewProvider[];
  chatFpRound?: boolean;
  fpPending?: {
    agreed: Finding[];
    disputed: { source: ReviewProvider; finding: Finding }[];
    fpQueue: ReviewProvider[];
    investigatedSafe: string[];
    assumptions: string[];
    skipped: string[];
    dropped: string[];
  };
  storedLegs?: { provider: ReviewProvider; raw: string; originalText?: string; repair?: RepairReceipt }[];
  reviewOrder?: ReviewProvider[];
  opsCommentId?: number;
  attemptedProviders?: ReviewProvider[];
  generating?: Partial<Record<ReviewProvider, boolean>>;
  /** Review-coverage: prompt attachment sizes, measured at prompt assembly. */
  promptStats?: { diffChars: number; contextChars: number; policyChars: number; diffFilesFull: number; diffFilesTotal: number };
  /** Review-coverage: model-reported per-file coverage. Never affects the verdict. */
  coverage?: { file: string; status: "cleared" | "not_cleared"; reason: string }[];
  /** Review-coverage: deterministic (harness) coverage per changed code file. */
  coverageDeterministic?: { path: string; inDiff: boolean; inContext: boolean; reason?: string }[];
  /** Review-coverage: findings dropped by the precision gate. */
  droppedCount?: number;
  /** Review-coverage: PR head sha at post time when it moved from the reviewed sha. */
  headMovedTo?: string;
  /** Public snapshot only — never includes reviewer raw JSON. */
  reviewerLanes?: ReviewerLane[];
}

export interface ProviderError {
  code: "quota" | "empty" | "error" | "tab_closed" | "cancelled" | "disconnected";
  message: string;
}

export type ReviewerLaneState = "queued" | "waiting" | "generating" | "answered" | "skipped" | "empty";

export interface ReviewerLane {
  provider: ReviewProvider;
  state: ReviewerLaneState;
  label: string;
  detail: string;
  answered: boolean;
  jsonChars?: number;
  findingCount?: number;
}

export interface PostedComment {
  id: string;
  findingId: string;
  file: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface PostedReview {
  id: string;
  jobId: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  event: MergeRec;
  body: string;
  comments: PostedComment[];
  at: number;
  dismissed?: boolean;
  githubId?: number;
}

export interface WebhookLog {
  id: string;
  deliveryId: string;
  event: string;
  action: string;
  hmac: "ok" | "fail";
  httpStatus: 202 | 403;
  at: number;
  summary: string;
  skipReason?: string;
  rejectReason?: string;
  jobId?: string;
}

export interface BotSettings {
  username: string;
  mention: string[];
  skipForks: boolean;
  skipDrafts: boolean;
  maxInlineComments: number;
  maxTurns: number;
  exploreTurns: number;
  publishMinSeverity: Severity;
  requestChangesMin: Severity;
  precisionOverRecall: boolean;
  webhookSecret: string;
  reviewChatgpt: boolean;
  reviewGrok: boolean;
  reviewLocal: boolean;
  /** Review-loop fix agent (design §6b) — the Settings screen is its only switch. */
  fixAgent: FixAgentSettings;
  /** Formatting-only recovery; independent of Local reviewer participation. */
  localJsonRepairEnabled: boolean;
  chatgptReasoning: ChatgptReasoning;
  grokReasoning: GrokReasoning;
  localLlmBaseUrl: string;
  localLlmApiKey: string;
  localLlmModel: string;
  /** Completion-token budget for a local generation; must clear a reasoning model's thinking + JSON. */
  localReviewMaxTokens: number;
  /** "single" = one-shot prompt; "multiturn" = SDK tool loop; "auto" = pick by PR size. */
  localReviewMode: LocalReviewMode;
  /** auto-mode cutoff: a single-turn prompt estimated at or below this many tokens stays single-turn. */
  localReviewSingleTurnMaxTokens: number;
  reviewOrder: ReviewProvider[];
  /** Review-coverage: char budgets for the three reviewer attachments + context pad. */
  promptDiffMaxChars: number;
  promptContextMaxChars: number;
  promptPolicyMaxChars: number;
  contextPadLines: number;
  localLlmApiKeySet?: boolean;
  webhookSecretSet?: boolean;
}

export interface SnapshotFile {
  path: string;
  content: string;
  language: "ts" | "md" | "json";
}

export interface SamplePr {
  key: string;
  owner: string;
  repo: string;
  pr: number;
  title: string;
  body: string;
  sender: string;
  headSha: string;
  baseSha: string;
  isFork: ForkStatus;
  isDraft: boolean;
  labels: string[];
  files: SnapshotFile[];
  diff: string;
  changedPaths: string[];
  /** Review-coverage: changed files dropped from the diff by the prompt budget. */
  diffDroppedPaths?: string[];
  /** Unchanged modules that changed files import from, fetched at head so cross-file helper
   * definitions can be attached (chat) or served by the loop's cache (local). Not review targets. */
  referenceFiles?: SnapshotFile[];
}

export type FixAgentProvider = "chatgpt" | "grok" | "local" | "coding-agent";
export type FixDelivery = "script-apply" | "chat-push" | "coding-agent";
export type FixMode = "suggest" | "apply";
export const FIX_AGENT_PROVIDERS: readonly FixAgentProvider[] = ["chatgpt", "grok", "local", "coding-agent"];
export const FIX_DELIVERIES: readonly FixDelivery[] = ["script-apply", "chat-push", "coding-agent"];
export const FIX_MODES: readonly FixMode[] = ["suggest", "apply"];

/** Review-loop fix agent (design §6b). EVERY field is operated from the Settings screen and read
 * per loop step from the live settings (no restart). The loop runs only when `enabled` is true AND
 * a provider is chosen (review-loop-runtime loopEnabled) — nothing else (no env var) turns it on. */
export interface FixAgentSettings {
  /** The ONE switch for the review loop / fix agent. Default false: no loop, no fix item. */
  enabled: boolean;
  /** Who fixes. null = no provider chosen: the loop stays off even when `enabled`. */
  provider: FixAgentProvider | null;
  /** How the fix reaches the PR (§6 A/B/C). Only "script-apply" is wired. */
  delivery: FixDelivery;
  /** suggest = proposal / draft commit (human 1-click); apply = auto-commit + push (high-risk). */
  mode: FixMode;
  /** Max distinct PRs fixed concurrently — shares the reviewer bridge capacity. */
  parallelPrs: number;
  /** Fix-round budget: at most this many review→fix rounds, then a human decides. */
  roundCap: number;
  /** Attempts per fix round for a retryable outcome (unusable reply). */
  attempts: number;
  /** Generation deadline per fix request (ms, from the provider's first output). */
  timeoutMs: number;
  /** Backstop for a fix request still queued at the provider (ms). */
  queueMaxMs: number;
  /** chatgpt: a chat fix item's deadline, queue + generation (ms). */
  chatTimeoutMs: number;
  /** chatgpt: the largest inline fix prompt (chars); bigger is rejected up front. */
  chatMaxPromptChars: number;
}

export type FixAgentKnob = "parallelPrs" | "roundCap" | "attempts" | "timeoutMs" | "queueMaxMs" | "chatTimeoutMs" | "chatMaxPromptChars";

/** Numeric fix-agent knobs: default, bounds, and the env var that seeds it before the first save
 * (settings.server overlayEnv). The saved Settings value always wins over the env default. */
export const FIX_AGENT_KNOBS: Record<FixAgentKnob, { def: number; min: number; max: number; env: string }> = {
  parallelPrs: { def: 3, min: 1, max: 20, env: "ASHLAR_FIX_PARALLEL_PRS" },
  // max = MAX_CONTINUE_ROUND - 1 (review-loop.ts): review cap+1 must stay a valid continuation round.
  roundCap: { def: 5, min: 1, max: 9998, env: "ASHLAR_LOOP_ROUND_CAP" },
  attempts: { def: 2, min: 1, max: 5, env: "ASHLAR_FIX_ATTEMPTS" },
  timeoutMs: { def: 60 * 60_000, min: 60_000, max: 6 * 60 * 60_000, env: "ASHLAR_FIX_TIMEOUT_MS" },
  queueMaxMs: { def: 6 * 60 * 60_000, min: 10 * 60_000, max: 24 * 60 * 60_000, env: "ASHLAR_FIX_QUEUE_MAX_MS" },
  chatTimeoutMs: { def: 30 * 60_000, min: 60_000, max: 6 * 60 * 60_000, env: "ASHLAR_FIX_CHAT_TIMEOUT_MS" },
  chatMaxPromptChars: { def: 100_000, min: 10_000, max: 1_000_000, env: "ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS" },
};

/** A numeric fix-agent knob, clamped to its bounds; missing / non-numeric → its default. Readers
 * call this per use with the live settings, so a saved change applies on the next call. */
export function fixKnob(fixAgent: Partial<FixAgentSettings> | undefined, key: FixAgentKnob): number {
  const k = FIX_AGENT_KNOBS[key];
  const v = fixAgent?.[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return k.def;
  return Math.min(k.max, Math.max(k.min, Math.floor(v)));
}

// Which providers / deliveries the loop can execute (WIRED_FIX_*), and the validator every save
// runs, live in settings-rules.ts — shared by the Settings screen, the save path and the runtime.

export const DEFAULT_SETTINGS: BotSettings = {
  username: "ashlar-bot",
  mention: ["@ashlar-bot", "/review"],
  skipForks: true,
  skipDrafts: true,
  maxInlineComments: 8,
  maxTurns: 20,
  exploreTurns: 8,
  publishMinSeverity: "P2",
  requestChangesMin: "P1",
  precisionOverRecall: true,
  webhookSecret: "ashlar-dev-secret",
  reviewChatgpt: true,
  reviewGrok: true,
  reviewLocal: false,
  fixAgent: {
    enabled: false,
    provider: null,
    delivery: "script-apply",
    mode: "suggest",
    parallelPrs: FIX_AGENT_KNOBS.parallelPrs.def,
    roundCap: FIX_AGENT_KNOBS.roundCap.def,
    attempts: FIX_AGENT_KNOBS.attempts.def,
    timeoutMs: FIX_AGENT_KNOBS.timeoutMs.def,
    queueMaxMs: FIX_AGENT_KNOBS.queueMaxMs.def,
    chatTimeoutMs: FIX_AGENT_KNOBS.chatTimeoutMs.def,
    chatMaxPromptChars: FIX_AGENT_KNOBS.chatMaxPromptChars.def,
  },
  localJsonRepairEnabled: true,
  chatgptReasoning: "pro",
  grokReasoning: "heavy",
  localLlmBaseUrl: "http://127.0.0.1:11434/v1",
  localLlmApiKey: "",
  localLlmModel: "",
  localReviewMaxTokens: 32_768,
  localReviewMode: "auto",
  localReviewSingleTurnMaxTokens: 30_000,
  reviewOrder: ["local", "chatgpt", "grok"],
  promptDiffMaxChars: 300_000,
  promptContextMaxChars: 200_000,
  promptPolicyMaxChars: 32_768,
  contextPadLines: 20,
};

export const DEFAULT_REVIEW_ORDER: ReviewProvider[] = ["local", "chatgpt", "grok"];

export const PROVIDER_LABEL: Record<ReviewProvider, string> = {
  local: "Local LLM",
  chatgpt: "ChatGPT",
  grok: "Grok",
};

export const SECRET_MASK = "••••••••••••";
export const SECRET_MASK_PEM = `-----BEGIN PRIVATE KEY-----\n${SECRET_MASK}\n${SECRET_MASK}\n-----END PRIVATE KEY-----`;

/** Empty or bullets — do not send as a new secret; keep what is stored. */
export function isMaskedSecret(v: string | undefined): boolean {
  const t = (v ?? "").trim();
  if (!t) return true;
  if (t === SECRET_MASK || t === SECRET_MASK_PEM) return true;
  return /^•+$/.test(t) || t.includes(SECRET_MASK);
}

export function normalizeReviewOrder(order?: ReviewProvider[]): ReviewProvider[] {
  const seen = new Set<ReviewProvider>();
  const out: ReviewProvider[] = [];
  for (const p of [...(order ?? []), ...DEFAULT_REVIEW_ORDER]) {
    if ((p === "local" || p === "chatgpt" || p === "grok") && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function localLlmReady(
  s: Pick<BotSettings, "reviewLocal"> & Partial<Pick<BotSettings, "localLlmBaseUrl" | "localLlmModel">>,
): boolean {
  return Boolean(s.reviewLocal && s.localLlmBaseUrl?.trim() && s.localLlmModel?.trim());
}

export function providersFromSettings(
  s: Pick<BotSettings, "reviewChatgpt" | "reviewGrok" | "reviewLocal"> &
    Partial<Pick<BotSettings, "localLlmBaseUrl" | "localLlmModel">>,
): ReviewProvider[] {
  const out: ReviewProvider[] = [];
  if (s.reviewChatgpt) out.push("chatgpt");
  if (s.reviewGrok) out.push("grok");
  if (localLlmReady(s)) out.push("local");
  return out;
}

export function chatProvidersOf(providers: readonly ReviewProvider[]): Array<"chatgpt" | "grok"> {
  return providers.filter(isChatProvider);
}

export function describeEnabledReviewers(providers: readonly ReviewProvider[]): string {
  const chat = chatProvidersOf(providers as ReviewProvider[]);
  const local = providers.includes("local");
  const chatBit = !chat.length
    ? ""
    : chat.length === 1
      ? `${chat[0]} (Chrome)`
      : `${chat.join(" + ")} in parallel (Chrome)`;
  const localBit = !local ? "" : chat.length ? "local racing" : "local only";
  return [chatBit, localBit].filter(Boolean).join("; ") || "none configured";
}

export function claimedReviewerNote(providers: readonly ReviewProvider[]): string {
  const chat = chatProvidersOf(providers as ReviewProvider[]);
  if (!chat.length) return "Chrome bridge claimed this job.";
  if (chat.length === 1) {
    return `Chrome bridge claimed this job. ${PROVIDER_LABEL[chat[0]]} is running the review.`;
  }
  return `Chrome bridge claimed this job. ${chat.map((p) => PROVIDER_LABEL[p]).join(" and ")} run in parallel.`;
}

/** Heartbeat ownership lease only. Expiry permits resuming, never failing/restarting generation. */
export const BRIDGE_CLAIM_MS = 20 * 60_000;
/** Chrome MV3 alarms are ≥1 minute; keep connected across that gap. */
export const BRIDGE_CONNECTED_MS = 120_000;

export const LIVE_INFLIGHT_STATUSES: JobStatus[] = [
  "queued",
  "snapshot",
  "explorer",
  "reviewer",
  "awaiting_chat",
  "validator",
  "posting",
];

export type GithubReady = {
  webhookSecret: boolean;
  appId: boolean;
  clientId?: boolean;
  privateKey: boolean;
  appIdValue?: string;
  clientIdValue?: string;
  jwtIssuer?: "client_id" | "app_id" | "missing";
  publicHost?: string;
  webhookUrl?: string;
  from?: {
    webhookSecret: "ui" | "env" | "missing";
    appId: "ui" | "env" | "missing";
    clientId: "ui" | "env" | "missing";
    privateKey: "ui" | "env" | "missing";
  };
};
