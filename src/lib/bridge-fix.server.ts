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
 * LIFECYCLE (the one table every operation below implements; tested row by row in
 * bridge-fix.server.test.ts "lifecycle table"). An item's state is (state, owner, run):
 *
 *   Q0  queued, no owner                 (requested, never leased)
 *   QU  queued, owner, no run            (released before any run was reported)
 *   QP  queued, owner, run pinned        (released after its run was pinned)
 *   CU  claimed, lease, no run           (a fresh submission handed out; run not reported yet)
 *   CP  claimed, lease, run pinned       (the run lives in the owner's tab)
 *   DONE | FAILED | CANCELLED            (terminal; settled exactly once, see settle())
 *   "stale" (no heartbeat for claimMs) is a property of CU/CP: it holds no parallelPrs slot.
 *
 * Every lease hand-out is CLASSIFIED once, before the lease moves (offerKindOf), by the run alone:
 *   fresh  = no run and not handed out yet (Q0, QU): the worker must type the prompt into a NEW tab;
 *   replay = CU re-offered to its own profile, which does not list it (the take response was
 *            lost): the SAME delivery again, never a second one;
 *   resume = a run is pinned (QP, CP, or recover proving the page's binding): nothing is re-sent,
 *            the offer names the binding.
 * Lease bookkeeping (lease(): state, clientId, leaseId, claimedAt) is separate from submission
 * bookkeeping (beginSubmission(): submitAt, generating, deliveryId), which only a fresh or replay
 * offer writes. Every offer carries the item's `deliveryId`, minted by a fresh hand-out only: a
 * replay is the SAME delivery (same deliveryId), so two overlapping takes of one profile get one
 * delivery twice, never two, and the worker opens at most one tab per jobId+deliveryId
 * (extension/background.js admitJob + rememberFixDelivery).
 *
 *   #    from     operation (who)                    to     offer   bookkeeping set
 *   T1   -        request                            Q0     -       createdAt, deadlineAt, timer;
 *                                                                    older live item of the PR → CANCELLED "superseded"
 *   T2   Q0       take / claim (any profile, slot)   CU     fresh   lease + clientId; submitAt=now, generating=false,
 *                                                                    deliveryId=new
 *   T3   CU       take (owner, not in exclude)       CU     replay  same lease (renewed only if stale), SAME deliveryId;
 *                                                                    submitAt=now (re-armed for that one delivery)
 *   T4   CU       progress(runId) (holder)           CP     -       runId pinned, stage
 *   T5   CU       recover(runId) (owner)             CP     resume  lease; runId pinned; submitAt/generating untouched
 *   T6   CP       recover(same run) (owner)          CP     resume  lease; submitAt/generating untouched
 *   T7   CU|CP    refresh (holder)                   same   -       claimedAt; generating=true when flagged
 *   T8   CU|CP    claim (owner: lease renewal)       same   -       same lease, or a new one if stale; nothing else
 *   T9   CU       release (holder)                   QU     -       lease, claimedAt, submitAt cleared; owner kept
 *   T10  CP       release (holder)                   QP     -       lease, claimedAt, submitAt cleared; owner, run kept
 *   T11  QU       take / claim (owner, slot)         CU     fresh   lease; submitAt=now, generating=false, deliveryId=new
 *   T12  QP       take / claim (owner, slot)         CP     resume  lease only: submitAt stays unset, generating as it was
 *   T13  QU|QP    recover(runId) (owner, slot)       CP     resume  lease; runId pinned (QU) / matched (QP)
 *   T14  CU|CP    complete (holder)                  DONE   -       answerDigest; prompt dropped
 *   T15  CU|CP    fail (holder)                      FAILED -       reason; prompt dropped
 *   T16  live     deadline | newer request | abort   CANCELLED -    "timeout" | "superseded" | "aborted"
 *   refused: another profile (any owned state), no free slot (T2/T11-T13, a stale T3/T8), a
 *   different run (T5/T6/T13), a take of CP (only recover resumes a run), anything past deadlineAt.
 *
 * TERMINAL verdicts: the server's DONE / FAILED / CANCELLED, and on the page every PERMANENT
 * ownership verdict (extension/json.js: "takenOver" — follow-up, edited turn, draft, replaced
 * response — and a changed or unusable pinned conversation). A permanent verdict ends the run at
 * once: the page frees its managed slot and reports `taken_over`, and the worker delivers it as a
 * failure (T15), so the runtime retries or escalates now instead of at the deadline. Only a
 * transient "unknown" (journal unreadable, turn not rendered yet, still generating) keeps the run
 * polling, and the deadline (T16) bounds that.
 * TAB ENDS (extension/background.js cleanupFixTab): a fix tab is closed ONLY on the proven-success
 * path — DONE (T14) acknowledged to the worker AND the page's complete-phase proof passing at close
 * time (send-time conversation, exact sent turn, stored completion unchanged, no draft or
 * follow-up). Every other end of the item (FAILED, CANCELLED for timeout / superseded / aborted,
 * an unknown id) and every unproven tab (taken over, another binding, unreachable, still loading,
 * a lost delivery record) is PRESERVED: the page frees its managed slot and stops its run, and the
 * worker retires the job. Nothing on this server authorises a close.
 * INVARIANTS:
 *   - ONE live (queued | claimed) item per PR: a newer request for the same PR cancels the older
 *     one (its promise rejects "superseded"; the extension preserves that tab and frees its slot);
 *   - at most parallelLimit() (fixAgent.parallelPrs) items are claimed at once; the rest wait
 *     queued (the cap is enforced at claim, so neither take nor a direct claim can exceed it);
 *   - every request settles exactly once: resolve on complete, reject on failure / timeout /
 *     supersede / abort (an aborted item is cancelled like a superseded one, so the extension
 *     stops its run and preserves its tab instead of generating an answer nobody reads). The deadline (default 30 min, Settings fix_agent.chat_timeout_minutes) spans queue AND
 *     generation, so a fix is never awaited forever (fail closed → the runtime ESCALATEs);
 *   - leases mirror review items: only the lease holder refreshes / completes / fails; only the
 *     claiming Chrome profile may re-claim (its tab owns the generation); release frees the
 *     lease and the parallelPrs slot but keeps the profile and run (a later take resumes a pinned
 *     run; released before any run it is a fresh submission: resume only with a runId);
 *     tests/review/bridge-lease-conformance.test.mjs runs every rule against both kinds;
 *   - settled items answer late bridge calls consistently (a lost-ACK replay is idempotent) and
 *     are then forgotten. An UNKNOWN `fix-` id reports cancelled: the registry is in-memory, so
 *     after a restart nothing can ever be delivered and the extension must release that tab;
 *   - the prompt inlines file contents: it is dropped at settlement and never copied into an
 *     error, a status or a log line;
 *   - the extension types the WHOLE prompt into the chat composer and confirms the send by finding
 *     that text in the rendered user message. A prompt over maxPromptChars() (default 100k chars,
 *     Settings fix_agent.chat_max_prompt_chars) is rejected up front instead of risking a submission that
 *     can never be confirmed (it would only end at the deadline). The file contents are NOT moved
 *     into the <<<ASHLAR_ATTACHMENTS_V2>>> upload envelope: a full-file rewrite needs the model to
 *     see every byte of the current file, and a chat may read attachments through retrieval — a
 *     partial view becomes a confidently wrong "complete" file.
 * NON-GOALS: parsing or validating the answer (fix-apply / the runtime); review JSON, capture or
 * repair; persistence across restarts; tab management (the extension, driven by these states).
 */

import { createHash } from "node:crypto";
import { createdBefore, nextCreationSeq } from "./creation-seq.ts";

export type FixChatProvider = "chatgpt" | "grok";
export type FixItemState = "queued" | "claimed" | "done" | "failed" | "cancelled";
/** How a lease hand-out relates to the prompt (LIFECYCLE above): fresh = submit it in a new tab;
 * replay = the same fresh delivery again (its take response was lost); resume = the run already
 * in a tab (nothing is re-sent). */
export type FixOfferKind = "fresh" | "replay" | "resume";

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
  /** The offer's classification (offerKindOf): the worker submits the prompt only for fresh/replay. */
  offerKind: FixOfferKind;
  /** The fresh hand-out this offer delivers (minted by fresh only; a replay repeats it): the worker
   * opens at most one tab per jobId + deliveryId. */
  deliveryId: string;
  provider: FixChatProvider;
  providers: FixChatProvider[];
  resumeProviders: FixChatProvider[];
  leaseId: string;
  /** Recovery only: the tab binding (the run already in that tab) being resumed. */
  bindings?: { jobId: string; provider: FixChatProvider; runId: string }[];
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
  /** Process-wide creation order shared with review jobs (creation-seq.ts): breaks a createdAt tie. */
  createdSeq: number;
  deadlineAt: number;
  state: FixItemState;
  leaseId?: string;
  clientId?: string;
  claimedAt?: number;
  submitAt?: number;
  generating?: boolean;
  /** The current fresh hand-out's nonce (beginSubmission): a replay re-delivers the same one. */
  deliveryId?: string;
  /** The run the lease holder started for this claim, pinned by its first progress report (or by a
   * recovery that proves the page's binding). It is the ONLY source of resume semantics: an item
   * with a run lives in a tab and is resumed through that binding (recover, or the owner's take
   * after a release), never offered again as a fresh submission; an item without one is always a
   * fresh submission (there is no binding a resume could observe). */
  runId?: string;
  /** Digest of the delivered answer: a lost-ACK replay is acknowledged only for this exact text
   * (a review acknowledges only an identical stored leg). */
  answerDigest?: string;
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
  /** Default deadline in ms (Settings fixAgent.chatTimeoutMs, clamped by settings normalization). */
  timeoutMs(): number;
  /** Largest inline prompt in chars (Settings fixAgent.chatMaxPromptChars, clamped by settings normalization). */
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

export function isFixItemId(id: unknown): id is string {
  return typeof id === "string" && id.length > FIX_ID_PREFIX.length && id.startsWith(FIX_ID_PREFIX);
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64url");
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
    return `fix prompt is ${req.prompt.length} chars; the Chrome bridge types the whole prompt into the chat composer and accepts at most ${maxChars} (Settings → Fix agent / review loop → fix_agent.chat_max_prompt_chars) — raise that limit, use the local fix provider or split the PR`;
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
  // A stale claim (no heartbeat for claimMs: Chrome crashed, or the take response was lost) no
  // longer holds a parallelPrs slot: nothing else would free it before its deadline, so every
  // other PR's fix would stall behind a dead profile. Its own profile may still resume it.
  const claimedCount = () => [...items.values()].filter((item) => item.state === "claimed" && !stale(item)).length;
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

  /** One item, with its deadline enforced first: a live item past deadlineAt is expired right here,
   * synchronously, so a late or delayed timer never lets a completion, failure or lease mutation
   * act on work that has already timed out. Every per-id lease operation reads through this. */
  function current(id: string): FixItem | undefined {
    const item = items.get(id);
    if (item && live(item) && deps.now() >= item.deadlineAt) expire(id);
    return item;
  }

  /** Lazy deadline backstop (a late timer) + forgetting settled items. Never drops a live item. */
  function prune() {
    const now = deps.now();
    for (const item of items.values()) if (live(item) && now >= item.deadlineAt) expire(item.id);
    for (const [id, item] of items) if (!live(item) && now - (item.endedAt ?? now) > FIX_TERMINAL_RETAIN_MS) items.delete(id);
    // Over the cap, forget the items that SETTLED first (endedAt), not the ones created first: a
    // long-running fix that just completed keeps its lost-ACK replay and its posted state.
    const settled = [...items.values()].filter((item) => !live(item)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const item of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_ITEMS))) items.delete(item.id);
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
      createdSeq: nextCreationSeq(),
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

  /** The next item `clientId` may take: first a fix it claimed but does not know and never started
   * a run for (its take response was lost; the worker lists every job it knows in `exclude`),
   * offered again under its lease, then the oldest queued item (none while parallelLimit() are
   * claimed). A claim with a run is in a tab: only recover() resumes it. */
  function peek(exclude: readonly string[] = [], clientId = ""): { id: string; createdAt: number; createdSeq: number } | undefined {
    prune();
    if (clientId) {
      for (const item of items.values()) {
        if (item.state === "claimed" && item.clientId === clientId && !item.runId && !exclude.includes(item.id)) return { id: item.id, createdAt: item.createdAt, createdSeq: item.createdSeq };
      }
    }
    if (claimedCount() >= limit()) return undefined;
    let oldest: FixItem | undefined;
    for (const item of items.values()) {
      if (item.state !== "queued" || exclude.includes(item.id)) continue;
      // A released claim stays with its profile (review: bridgeClientId + attemptedProviders).
      if (item.clientId && item.clientId !== clientId) continue;
      if (!oldest || createdBefore(item, oldest)) oldest = item;
    }
    return oldest && { id: oldest.id, createdAt: oldest.createdAt, createdSeq: oldest.createdSeq };
  }

  /** THE classification of a lease hand-out on `item` (LIFECYCLE), read before the lease moves:
   * a pinned run is always a resume; a claim without one was already handed out (replay); anything
   * else has never reached a tab (fresh). */
  function offerKindOf(item: FixItem): FixOfferKind {
    if (item.runId) return "resume";
    return item.state === "claimed" ? "replay" : "fresh";
  }

  /** Lease claim / renewal ONLY (state, owner, leaseId, claimedAt) under the ownership and
   * parallelPrs rules. Never touches submission bookkeeping (submitAt, generating): that follows
   * the offer's classification (beginSubmission). */
  function lease(item: FixItem, clientId: string): { ok: true; leaseId: string } | { ok: false; error: string } {
    if (item.state === "claimed") {
      // Only the claiming profile holds the tab that owns this generation (mirrors review items).
      if (item.clientId !== clientId) return { ok: false, error: "fix generation belongs to another Chrome profile" };
      if (!stale(item) && item.leaseId) return { ok: true, leaseId: item.leaseId };
      // A stale claim gave up its slot; it may resume only while one is free again.
      if (claimedCount() >= limit()) return { ok: false, error: "fix parallel limit reached (fixAgent.parallelPrs)" };
    } else if (item.clientId && item.clientId !== clientId) {
      // Released: it stays with its profile (a run may live in that profile's tab, or its first
      // progress report was lost): never a replacement generation from another profile.
      return { ok: false, error: "fix generation belongs to another Chrome profile" };
    } else if (claimedCount() >= limit()) {
      return { ok: false, error: "fix parallel limit reached (fixAgent.parallelPrs)" };
    } else {
      item.state = "claimed";
      item.clientId = clientId;
    }
    const leaseId = deps.newId();
    item.leaseId = leaseId;
    item.claimedAt = deps.now();
    return { ok: true, leaseId };
  }

  /** Submission bookkeeping, by classification: a fresh offer starts the profile's foreground
   * submission window (its generation has not started); a replay hands the SAME delivery out
   * again, so its window restarts with it; a resume sends nothing and changes nothing. */
  function beginSubmission(item: FixItem, kind: FixOfferKind) {
    if (kind === "resume") return;
    item.submitAt = deps.now();
    if (kind !== "fresh") return;
    item.generating = false;
    item.deliveryId = deps.newId();
  }

  /** The claim action: a lease for a live item. On a queued item it is that item's hand-out
   * (fresh without a run: T2/T11; resume with one: T12); on a claimed item it is a renewal (T8),
   * which is never a submission. */
  function claim(id: string, clientId = ""): { ok: true; leaseId: string } | { ok: false; error: string } {
    const item = current(id);
    if (!item || !live(item)) return { ok: false, error: "fix item is not waiting for chat" };
    const kind = item.state === "queued" ? offerKindOf(item) : undefined;
    const out = lease(item, clientId);
    if (out.ok && kind) beginSubmission(item, kind);
    return out;
  }

  /** The take/recover payload. A resume offer always names its binding (the pinned run); fresh
   * and replay offers carry none. */
  function offer(item: FixItem, leaseId: string, kind: FixOfferKind): FixOffer {
    const resume = kind === "resume" ? item.runId : undefined;
    return {
      kind: "fix",
      jobId: item.id,
      offerKind: kind,
      deliveryId: item.deliveryId ?? "",
      provider: item.provider,
      providers: [item.provider],
      resumeProviders: resume ? [item.provider] : [],
      ...(resume ? { bindings: [{ jobId: item.id, provider: item.provider, runId: resume }] } : {}),
      leaseId,
      prompt: item.prompt,
      reasoning: deps.reasoning(),
      title: `fix ${labelOf(item)}`,
      owner: item.owner,
      repo: item.repo,
      pr: item.pr,
    };
  }

  /** Hand out a queued item (fresh T2/T11, or the owner's resume of a pinned run T12) — or replay
   * this client's own unacknowledged claim (T3) — and build its take payload (null when not
   * claimable). A claim with a run is in a tab: only recover() resumes it. */
  function take(id: string, clientId = ""): FixOffer | null {
    const item = current(id);
    if (!item || !(item.state === "queued" || (item.state === "claimed" && Boolean(clientId) && item.clientId === clientId && !item.runId))) return null;
    const kind = offerKindOf(item);
    const out = lease(item, clientId);
    if (!out.ok) return null;
    beginSubmission(item, kind);
    return offer(item, out.leaseId, kind);
  }

  /** Resume a live claim this profile already runs in a tab (T5/T6/T13): same profile, provider
   * and the run pinned by its progress. Renews the lease under the claim rules (a stale claim needs
   * a free slot); always a resume: nothing is re-sent, so no submission bookkeeping changes. */
  function recover(id: string, clientId: string, provider: string, runId: string): FixOffer | null {
    prune();
    const item = current(id);
    // A released claim stays with its profile: the page's binding proves its run (pinned below,
    // as for a claim whose first progress report was lost), so it is resumable too.
    const live = item && (item.state === "claimed" || (item.state === "queued" && Boolean(item.clientId)));
    if (!item || !live || !clientId || item.clientId !== clientId || item.provider !== provider) return null;
    if (typeof runId !== "string" || !runId || runId.length > 128 || (item.runId && item.runId !== runId)) return null;
    const out = lease(item, clientId);
    if (!out.ok) return null;
    // The page's binding proves a run reached a tab of this profile even when its first progress
    // report was lost: pin that run now (atomically with the renewed lease), so the claim never
    // re-enters the lost-take replay (peek) as a fresh submission in a second tab.
    item.runId ??= runId;
    return offer(item, out.leaseId, "resume");
  }

  /** Heartbeat: renews the lease (not a deadline extension) and records generation start. */
  function refresh(id: string, leaseId: string | undefined, generating?: Partial<Record<string, boolean>>): boolean {
    const item = current(id);
    if (!item || !holds(item, leaseId)) return false;
    // A stale claim gave up its slot: its heartbeat may not revive it past parallelLimit().
    if (stale(item) && claimedCount() >= limit()) return false;
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
    const item = current(id);
    return item && live(item) && item.prompt ? { prompt: item.prompt } : null;
  }

  /** The lease holder hands the lease back (review: releaseBridgeJob). It frees the parallelPrs
   * slot and voids the lease; the item stays with its profile. Resume semantics follow the run
   * alone: with a pinned run the owner's next take resumes it through that binding (never re-sent);
   * released before any run was established, the item is a fresh submission again (no binding a
   * resume could observe; resumeProviders empty). */
  function release(id: string, leaseId?: string): boolean {
    const item = current(id);
    if (!item || !holds(item, leaseId)) return false;
    // Lease bookkeeping only (T9/T10): `generating` describes the run in the tab, not the lease; a
    // later resume keeps it as it was (a fresh hand-out resets it, beginSubmission).
    item.state = "queued";
    item.leaseId = undefined;
    item.claimedAt = item.submitAt = undefined;
    return true;
  }

  /** Explicit terminal failure from the lease holder. A settled/unknown item has nothing left to fail. */
  function fail(id: string, provider: string, error: string, leaseId?: string): boolean {
    const item = current(id);
    if (!item || !live(item)) return true;
    if (!holds(item, leaseId) || item.provider !== provider) return false;
    settle(item, "failed", "failure", { error: new Error(`${provider} fix request failed: ${oneLine(error) || "no detail"}`) });
    return true;
  }

  function complete(id: string, provider: string | undefined, text: string, leaseId?: string): FixCompleteResult {
    const item = current(id);
    if (!item) return { ok: false, code: "lease_conflict", error: "fix item is unknown or expired" };
    if (item.state === "done") {
      // A lost-ACK replay is identified by its payload, as a review's is (completeBridgeJob acks an
      // identical stored leg): the SAME answer is acknowledged, never delivered twice; any other
      // text is a conflict.
      return typeof text === "string" && item.answerDigest === digest(text) ? { ok: true } : { ok: false, code: "lease_conflict", error: "fix item already completed" };
    }
    if (!holds(item, leaseId)) {
      const why = item.state === "cancelled" ? `fix item was cancelled (${item.reason})` : item.state === "failed" ? "fix item already failed" : "fix item is not claimed by this worker";
      return { ok: false, code: "lease_conflict", error: why };
    }
    if (provider !== undefined && provider !== item.provider) return { ok: false, code: "invalid", error: "provider does not match the fix item" };
    if (typeof text !== "string" || !text.trim()) return { ok: false, code: "invalid", error: "empty fix answer" };
    item.answerDigest = digest(text);
    settle(item, "done", "completed", { text });
    return { ok: true };
  }

  function progress(id: string, leaseId: string | undefined, stage?: string, runId?: string): boolean {
    const item = current(id);
    if (!item || !holds(item, leaseId)) return false;
    // One run per claim (as review legs): a report from another run is rejected.
    if (runId && item.runId && item.runId !== runId) return false;
    if (runId && !item.runId) item.runId = runId.slice(0, 128);
    if (stage) item.stage = stage.slice(0, 80);
    return true;
  }

  /** A claimed, not-yet-generating item of this profile inside the submission window. With
   * `known` (the jobs the worker lists), an item it does not know is not being submitted: its
   * take response was lost, and peek offers it again. */
  function submitting(clientId: string, known?: readonly string[]): boolean {
    if (!clientId) return false;
    prune(); // an item past its deadline holds no submission window
    const now = deps.now();
    return [...items.values()].some(
      (item) =>
        item.state === "claimed" &&
        item.clientId === clientId &&
        (!known || known.includes(item.id)) &&
        !item.generating &&
        !stale(item) &&
        item.submitAt !== undefined &&
        now - item.submitAt < deps.submitWindowMs,
    );
  }

  /** Live items: queued, claimed (every live claim, stale ones included: their requests are still
   * pending), and active — the claims holding a parallelPrs slot (stale ones do not). */
  function counts(): { queued: number; claimed: number; active: number } {
    prune();
    let queued = 0;
    let claimed = 0;
    for (const item of items.values()) {
      if (item.state === "queued") queued += 1;
      else if (item.state === "claimed") claimed += 1;
    }
    return { queued, claimed, active: claimedCount() };
  }

  const providerOf = (id: string): FixChatProvider | undefined => items.get(id)?.provider;
  /** Test/diagnostic copy of one item. */
  const snapshot = (id: string): FixItem | undefined => {
    const item = items.get(id);
    return item && { ...item };
  };

  return { request, peek, claim, take, recover, refresh, state, prompt, release, fail, complete, progress, submitting, counts, providerOf, snapshot };
}
