/**
 * Chrome-bridge FIX work items — the chat transport of the review-loop fix agent for the
 * chatgpt / grok providers (design §6 mechanism A, script-apply).
 *
 * WHY not a harbor Job: harbor jobs carry the REVIEW lifecycle (awaiting_chat → validator →
 * posting), supersede per PR (a fix would cancel the review that asked for it) and every bridge
 * completion of a Job is validated as review JSON (422 repair, salvage). A fix needs only "type
 * this prompt into a chat tab and hand back the answer TEXT"; the runtime parses that text
 * deterministically (fix-apply.ts) and owns retries / ESCALATE.
 *
 * Pure + dependency-injected (clock, ids, timers, settings) so it unit-tests without the
 * harbor/GitHub graph. bridge.server.ts owns the single production registry and routes every
 * per-id bridge handler here for `fix-` ids.
 *
 * STATES: queued → claimed → done (resolve) | failed (reject); claimed → queued (explicit
 * release); queued | claimed → cancelled (deadline "timeout" | newer request "superseded" |
 * the caller's abort "aborted" — the loop no longer wants the fix).
 * INVARIANTS:
 *   - ONE live (queued | claimed) item per PR: a newer request for the same PR cancels the older
 *     one (its promise rejects "superseded"; the extension force-closes that tab);
 *   - at most parallelLimit() (fixAgent.parallelPrs) items are claimed at once; the rest wait
 *     queued (the cap is enforced at claim, so neither take nor a direct claim can exceed it);
 *   - every request settles exactly once: resolve on complete, reject on failure / timeout /
 *     supersede / abort (an aborted item is cancelled like a superseded one, so the extension
 *     force-closes its tab instead of generating an answer nobody reads). The deadline (default 30 min, ASHLAR_FIX_CHAT_TIMEOUT_MS) spans queue AND
 *     generation, so a fix is never awaited forever (fail closed → the runtime ESCALATEs);
 *   - leases mirror review items: only the lease holder refreshes / completes / fails; only the
 *     claiming Chrome profile may re-claim (its tab owns the generation); release requeues;
 *   - settled items answer late bridge calls consistently (a lost-ACK replay is idempotent) and
 *     are then forgotten. An UNKNOWN `fix-` id reports cancelled: the registry is in-memory, so
 *     after a restart nothing can ever be delivered and the extension must release that tab;
 *   - the prompt inlines file contents: it is dropped at settlement and never copied into an
 *     error, a status or a log line;
 *   - the extension types the WHOLE prompt into the chat composer and confirms the send by finding
 *     that text in the rendered user message. A prompt over maxPromptChars() (default 100k chars,
 *     ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS) is rejected up front instead of risking a submission that
 *     can never be confirmed (it would only end at the deadline). The file contents are NOT moved
 *     into the <<<ASHLAR_ATTACHMENTS_V2>>> upload envelope: a full-file rewrite needs the model to
 *     see every byte of the current file, and a chat may read attachments through retrieval — a
 *     partial view becomes a confidently wrong "complete" file.
 * NON-GOALS: parsing or validating the answer (fix-apply / the runtime); review JSON, capture or
 * repair; persistence across restarts; tab management (the extension, driven by these states).
 */

export type FixChatProvider = "chatgpt" | "grok";
export type FixItemState = "queued" | "claimed" | "done" | "failed" | "cancelled";

export const FIX_ID_PREFIX = "fix-";
export const DEFAULT_FIX_TIMEOUT_MS = 30 * 60_000;
export const MIN_FIX_TIMEOUT_MS = 60_000;
export const MAX_FIX_TIMEOUT_MS = 6 * 60 * 60_000;
export const DEFAULT_FIX_MAX_PROMPT_CHARS = 100_000;
export const MIN_FIX_MAX_PROMPT_CHARS = 10_000;
export const MAX_FIX_MAX_PROMPT_CHARS = 1_000_000;
/** A settled item keeps answering late bridge calls (lost-ACK replays) this long, then is forgotten. */
export const FIX_TERMINAL_RETAIN_MS = 10 * 60_000;
/** Memory bound for settled items under a burst (the oldest are forgotten first). */
const MAX_SETTLED_ITEMS = 200;
const ERROR_MAX = 240;

export interface FixRequest {
  owner: string;
  repo: string;
  pr: number;
  provider: FixChatProvider;
  prompt: string;
  /** Deadline override (clamped like the env value); default deps.timeoutMs(). */
  timeoutMs?: number;
  /** The caller's cancellation (head moved, loop stopped, its own deadline): cancels the item.
   * Already aborted → rejected up front, never queued. */
  signal?: AbortSignal;
}

/** The `take` payload of a fix item. Review payloads omit `kind`. */
export interface FixOffer {
  kind: "fix";
  jobId: string;
  provider: FixChatProvider;
  providers: FixChatProvider[];
  resumeProviders: FixChatProvider[];
  leaseId: string;
  prompt: string;
  reasoning: { chatgpt: string; grok: string };
  title: string;
  owner: string;
  repo: string;
  pr: number;
}

export interface FixItem {
  id: string;
  kind: "fix";
  key: string;
  owner: string;
  repo: string;
  pr: number;
  provider: FixChatProvider;
  /** Emptied at settlement (it inlines file contents). */
  prompt: string;
  createdAt: number;
  deadlineAt: number;
  state: FixItemState;
  leaseId?: string;
  clientId?: string;
  claimedAt?: number;
  submitAt?: number;
  generating?: boolean;
  /** Latest reported progress stage (diagnostics for the timeout message). */
  stage?: string;
  endedAt?: number;
  reason?: string;
}

export interface FixRegistryDeps {
  now(): number;
  /** Unguessable opaque token (item ids and leases). */
  newId(): string;
  /** fixAgent.parallelPrs: the most fix items claimed at once. */
  parallelLimit(): number;
  reasoning(): { chatgpt: string; grok: string };
  /** Default deadline in ms (already clamped, see fixChatTimeoutMs). */
  timeoutMs(): number;
  /** Largest inline prompt in chars (already clamped, see fixChatMaxPromptChars). */
  maxPromptChars(): number;
  /** Lease staleness (BRIDGE_CLAIM_MS): an ownership lease, never a generation deadline. */
  claimMs: number;
  /** Foreground-submission window shared with review tabs (SUBMIT_WINDOW_MS). */
  submitWindowMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type FixCompleteResult = { ok: true } | { ok: false; code: "lease_conflict" | "invalid"; error: string };

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** ASHLAR_FIX_CHAT_TIMEOUT_MS, clamped to [1 min, 6 h]; default 30 min. */
export function fixChatTimeoutMs(env: Record<string, string | undefined> | undefined): number {
  return clampInt(env?.ASHLAR_FIX_CHAT_TIMEOUT_MS, DEFAULT_FIX_TIMEOUT_MS, MIN_FIX_TIMEOUT_MS, MAX_FIX_TIMEOUT_MS);
}

/** ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS, clamped to [10k, 1M]; default 100k. */
export function fixChatMaxPromptChars(env: Record<string, string | undefined> | undefined): number {
  return clampInt(env?.ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS, DEFAULT_FIX_MAX_PROMPT_CHARS, MIN_FIX_MAX_PROMPT_CHARS, MAX_FIX_MAX_PROMPT_CHARS);
}

export function isFixItemId(id: unknown): id is string {
  return typeof id === "string" && id.length > FIX_ID_PREFIX.length && id.startsWith(FIX_ID_PREFIX);
}

const labelOf = (item: Pick<FixItem, "owner" | "repo" | "pr">) => `${item.owner}/${item.repo}#${item.pr}`;
const oneLine = (text: string) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, ERROR_MAX);
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Why a request cannot be queued at all (undefined = acceptable). Never echoes the prompt. */
function requestProblem(req: FixRequest, maxChars: number): string | undefined {
  if (req?.provider !== "chatgpt" && req?.provider !== "grok") {
    return `fix provider ${String(req?.provider)} is not a Chrome bridge provider (chatgpt | grok)`;
  }
  if (typeof req.owner !== "string" || !req.owner || typeof req.repo !== "string" || !req.repo || !Number.isSafeInteger(req.pr) || req.pr < 1) {
    return "fix request needs owner, repo and a PR number";
  }
  if (typeof req.prompt !== "string" || !req.prompt.trim()) return "empty fix prompt";
  if (req.prompt.length > maxChars) {
    return `fix prompt is ${req.prompt.length} chars; the Chrome bridge types the whole prompt into the chat composer and accepts at most ${maxChars} (ASHLAR_FIX_CHAT_MAX_PROMPT_CHARS) — use the local fix provider or split the PR`;
  }
  return undefined;
}

export type FixRegistry = ReturnType<typeof createFixRegistry>;

export function createFixRegistry(deps: FixRegistryDeps) {
  const items = new Map<string, FixItem>();
  const waiters = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void; timer: unknown }>();
  const live = (item: FixItem) => item.state === "queued" || item.state === "claimed";
  const limit = () => Math.max(1, Math.floor(Number(deps.parallelLimit()) || 1));
  const stale = (item: FixItem) => item.claimedAt !== undefined && deps.now() - item.claimedAt > deps.claimMs;
  const claimedCount = () => [...items.values()].filter((item) => item.state === "claimed").length;
  const holds = (item: FixItem, leaseId: string | undefined) => item.state === "claimed" && Boolean(item.leaseId) && item.leaseId === leaseId;

  /** The only transition out of queued/claimed: settles the waiter exactly once. */
  function settle(item: FixItem, state: "done" | "failed" | "cancelled", reason: string, outcome: { text: string } | { error: Error }) {
    item.state = state;
    item.reason = reason;
    item.endedAt = deps.now();
    item.prompt = "";
    item.generating = false;
    const waiter = waiters.get(item.id);
    waiters.delete(item.id);
    if (!waiter) return;
    deps.clearTimer(waiter.timer);
    if ("text" in outcome) waiter.resolve(outcome.text);
    else waiter.reject(outcome.error);
  }

  function expire(id: string) {
    const item = items.get(id);
    if (!item || !live(item)) return;
    const where = item.stage
      ? `last stage: ${item.stage}`
      : item.state === "claimed"
        ? "claimed by the Chrome bridge, no progress reported"
        : "never picked up by the Chrome bridge (extension offline or without fix support, or no free tab)";
    const error = new Error(`fix request for ${labelOf(item)} timed out after ${minutes(item.deadlineAt - item.createdAt)} min (${where})`);
    settle(item, "cancelled", "timeout", { error });
  }

  function abort(id: string) {
    const item = items.get(id);
    if (!item || !live(item)) return;
    settle(item, "cancelled", "aborted", { error: new Error(`fix request for ${labelOf(item)} was cancelled by the review loop`) });
  }

  /** Lazy deadline backstop (a late timer) + forgetting settled items. Never drops a live item. */
  function prune() {
    const now = deps.now();
    for (const item of items.values()) if (live(item) && now >= item.deadlineAt) expire(item.id);
    for (const [id, item] of items) if (!live(item) && now - (item.endedAt ?? now) > FIX_TERMINAL_RETAIN_MS) items.delete(id);
    let settled = [...items.values()].filter((item) => !live(item)).length;
    for (const [id, item] of items) {
      if (settled <= MAX_SETTLED_ITEMS) break;
      if (!live(item)) {
        items.delete(id);
        settled -= 1;
      }
    }
  }

  function request(req: FixRequest): Promise<string> {
    prune();
    const problem = requestProblem(req, deps.maxPromptChars());
    if (problem) return Promise.reject(new Error(problem));
    if (req.signal?.aborted) return Promise.reject(new Error(`fix request for ${labelOf(req)} was cancelled before it was queued`));
    const key = `${req.owner.toLowerCase()}/${req.repo.toLowerCase()}#${req.pr}`;
    for (const item of items.values()) {
      if (!live(item) || item.key !== key) continue;
      settle(item, "cancelled", "superseded", { error: new Error(`fix request for ${labelOf(item)} superseded by a newer request for the same PR`) });
    }
    const now = deps.now();
    const timeoutMs =
      req.timeoutMs === undefined ? deps.timeoutMs() : clampInt(req.timeoutMs, DEFAULT_FIX_TIMEOUT_MS, MIN_FIX_TIMEOUT_MS, MAX_FIX_TIMEOUT_MS);
    const item: FixItem = {
      id: FIX_ID_PREFIX + deps.newId(),
      kind: "fix",
      key,
      owner: req.owner,
      repo: req.repo,
      pr: req.pr,
      provider: req.provider,
      prompt: req.prompt,
      createdAt: now,
      deadlineAt: now + timeoutMs,
      state: "queued",
    };
    items.set(item.id, item);
    const answer = new Promise<string>((resolve, reject) => {
      waiters.set(item.id, { resolve, reject, timer: deps.setTimer(() => expire(item.id), timeoutMs) });
    });
    req.signal?.addEventListener("abort", () => abort(item.id), { once: true });
    return answer;
  }

  /** The oldest queued item a client may take now (none while parallelLimit() are claimed). */
  function peek(exclude: readonly string[] = []): { id: string; createdAt: number } | undefined {
    prune();
    if (claimedCount() >= limit()) return undefined;
    let oldest: FixItem | undefined;
    for (const item of items.values()) {
      if (item.state !== "queued" || exclude.includes(item.id)) continue;
      if (!oldest || item.createdAt < oldest.createdAt) oldest = item;
    }
    return oldest && { id: oldest.id, createdAt: oldest.createdAt };
  }

  function claim(id: string, clientId = ""): { ok: true; leaseId: string } | { ok: false; error: string } {
    const item = items.get(id);
    if (!item || !live(item)) return { ok: false, error: "fix item is not waiting for chat" };
    const now = deps.now();
    if (item.state === "claimed") {
      // Only the claiming profile holds the tab that owns this generation (mirrors review items).
      if (item.clientId !== clientId) return { ok: false, error: "fix generation belongs to another Chrome profile" };
      if (!stale(item) && item.leaseId) return { ok: true, leaseId: item.leaseId };
    } else if (claimedCount() >= limit()) {
      return { ok: false, error: "fix parallel limit reached (fixAgent.parallelPrs)" };
    } else {
      item.state = "claimed";
      item.clientId = clientId;
      item.submitAt = now;
      item.generating = false;
    }
    const leaseId = deps.newId();
    item.leaseId = leaseId;
    item.claimedAt = now;
    return { ok: true, leaseId };
  }

  function offer(item: FixItem, leaseId: string): FixOffer {
    return {
      kind: "fix",
      jobId: item.id,
      provider: item.provider,
      providers: [item.provider],
      // A fix is only ever offered while queued (never re-offered as a resume of a claimed tab).
      resumeProviders: [],
      leaseId,
      prompt: item.prompt,
      reasoning: deps.reasoning(),
      title: `fix ${labelOf(item)}`,
      owner: item.owner,
      repo: item.repo,
      pr: item.pr,
    };
  }

  /** Claim a queued item for `clientId` and build its take payload (null when not claimable). */
  function take(id: string, clientId = ""): FixOffer | null {
    const item = items.get(id);
    if (!item || item.state !== "queued") return null;
    const out = claim(id, clientId);
    return out.ok ? offer(item, out.leaseId) : null;
  }

  /** Heartbeat: renews the lease (not a deadline extension) and records generation start. */
  function refresh(id: string, leaseId: string | undefined, generating?: Partial<Record<string, boolean>>): boolean {
    const item = items.get(id);
    if (!item || !holds(item, leaseId)) return false;
    item.claimedAt = deps.now();
    if (generating?.[item.provider] === true) item.generating = true;
    return true;
  }

  /** Bridge status vocabulary the extension already acts on: active → keep working; posted /
   * dlq → deliver (idempotent) and clean up; cancelled → release the tab. */
  function state(id: string): { active: boolean; status: string } {
    prune();
    const item = items.get(id);
    if (!item) return { active: false, status: "cancelled" };
    if (live(item)) return { active: true, status: "awaiting_chat" };
    return { active: false, status: item.state === "done" ? "posted" : item.state === "failed" ? "dlq" : "cancelled" };
  }

  function prompt(id: string): { prompt: string } | null {
    const item = items.get(id);
    return item && live(item) && item.prompt ? { prompt: item.prompt } : null;
  }

  /** The lease holder hands the item back: it is queued again for any profile. */
  function release(id: string, leaseId?: string): boolean {
    const item = items.get(id);
    if (!item || !holds(item, leaseId)) return false;
    item.state = "queued";
    item.leaseId = item.clientId = undefined;
    item.claimedAt = item.submitAt = undefined;
    item.generating = false;
    return true;
  }

  /** Explicit terminal failure from the lease holder. A settled/unknown item has nothing left to fail. */
  function fail(id: string, provider: string, error: string, leaseId?: string): boolean {
    const item = items.get(id);
    if (!item || !live(item)) return true;
    if (!holds(item, leaseId) || item.provider !== provider) return false;
    settle(item, "failed", "failure", { error: new Error(`${provider} fix request failed: ${oneLine(error) || "no detail"}`) });
    return true;
  }

  function complete(id: string, provider: string | undefined, text: string, leaseId?: string): FixCompleteResult {
    const item = items.get(id);
    if (!item) return { ok: false, code: "lease_conflict", error: "fix item is unknown or expired" };
    if (item.state === "done") {
      // Lost-ACK replay by the same lease holder: acknowledge, never deliver twice.
      return item.leaseId === leaseId ? { ok: true } : { ok: false, code: "lease_conflict", error: "fix item already completed" };
    }
    if (!holds(item, leaseId)) {
      const why = item.state === "cancelled" ? `fix item was cancelled (${item.reason})` : item.state === "failed" ? "fix item already failed" : "fix item is not claimed by this worker";
      return { ok: false, code: "lease_conflict", error: why };
    }
    if (provider !== undefined && provider !== item.provider) return { ok: false, code: "invalid", error: "provider does not match the fix item" };
    if (typeof text !== "string" || !text.trim()) return { ok: false, code: "invalid", error: "empty fix answer" };
    settle(item, "done", "completed", { text });
    return { ok: true };
  }

  function progress(id: string, leaseId: string | undefined, stage?: string): boolean {
    const item = items.get(id);
    if (!item || !holds(item, leaseId)) return false;
    if (stage) item.stage = stage.slice(0, 80);
    return true;
  }

  /** A claimed, not-yet-generating item of this profile inside the submission window. */
  function submitting(clientId: string): boolean {
    if (!clientId) return false;
    const now = deps.now();
    return [...items.values()].some(
      (item) =>
        item.state === "claimed" &&
        item.clientId === clientId &&
        !item.generating &&
        !stale(item) &&
        item.submitAt !== undefined &&
        now - item.submitAt < deps.submitWindowMs,
    );
  }

  function counts(): { queued: number; claimed: number } {
    prune();
    let queued = 0;
    for (const item of items.values()) if (item.state === "queued") queued += 1;
    return { queued, claimed: claimedCount() };
  }

  const providerOf = (id: string): FixChatProvider | undefined => items.get(id)?.provider;
  /** Test/diagnostic copy of one item. */
  const snapshot = (id: string): FixItem | undefined => {
    const item = items.get(id);
    return item && { ...item };
  };

  return { request, peek, claim, take, refresh, state, prompt, release, fail, complete, progress, submitting, counts, providerOf, snapshot };
}
