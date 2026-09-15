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
  kind: "mention" | "followup";
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
  isFork: boolean;
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
  storedLegs?: { provider: ReviewProvider; raw: string }[];
  reviewOrder?: ReviewProvider[];
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
  localLlmBaseUrl: string;
  localLlmApiKey: string;
  localLlmModel: string;
  reviewOrder: ReviewProvider[];
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
  isFork: boolean;
  isDraft: boolean;
  labels: string[];
  files: SnapshotFile[];
  diff: string;
  changedPaths: string[];
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
  localLlmBaseUrl: "http://127.0.0.1:11434/v1",
  localLlmApiKey: "",
  localLlmModel: "",
  reviewOrder: ["local", "chatgpt", "grok"],
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

export function providersFromSettings(
  s: Pick<BotSettings, "reviewChatgpt" | "reviewGrok" | "reviewLocal">,
): ReviewProvider[] {
  const out: ReviewProvider[] = [];
  if (s.reviewChatgpt !== false) out.push("chatgpt");
  if (s.reviewGrok !== false) out.push("grok");
  if (s.reviewLocal) out.push("local");
  return out;
}

export const BRIDGE_CLAIM_MS = 4 * 60_000;

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

