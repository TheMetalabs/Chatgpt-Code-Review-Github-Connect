import type {RepairReceipt} from "./json-repair-types.ts";
import type { ProviderProgress } from "./review-progress.ts";
import type { ChatgptReasoning, GrokReasoning } from "./reasoning.ts";

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
  /** Formatting-only recovery; independent of Local reviewer participation. */
  localJsonRepairEnabled: boolean;
  chatgptReasoning: ChatgptReasoning;
  grokReasoning: GrokReasoning;
  localLlmBaseUrl: string;
  localLlmApiKey: string;
  localLlmModel: string;
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
}

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
  localJsonRepairEnabled: true,
  chatgptReasoning: "pro",
  grokReasoning: "heavy",
  localLlmBaseUrl: "http://127.0.0.1:11434/v1",
  localLlmApiKey: "",
  localLlmModel: "",
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
