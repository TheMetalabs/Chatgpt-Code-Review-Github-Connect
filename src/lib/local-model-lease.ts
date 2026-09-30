/**
 * Process-wide FIFO lease on the local model server, held by one review's local leg for its whole run.
 *
 * WHY: the local model server (concurrency 1) generates one request at a time. Without a lease every
 * review sent its own chat/completions calls straight to the server, so the server's queue interleaved
 * reviews turn by turn (A-turn1, B-turn1, A-turn2, …): each switch evicted the other conversation's
 * prompt cache, every turn re-prefilled its whole history, and every review finished late.
 *
 * With the lease a review's local leg holds the model across ALL its file groups and turns; the next
 * queued review starts when it releases. Waiting is FIFO and abort-aware (a cancelled job leaves the
 * queue at once) and has no deadline: waiting behind another review is normal and may take hours.
 * The review local leg, the local fix agent and local JSON repair take this lease; the manual run is
 * unchanged.
 *
 * Lanes: a waiter joins the queue in its lane and is granted before every waiter of a lower lane, FIFO
 * within a lane: "short" (JSON repair: 1-3 small calls) before "fix" (one call that unblocks a PR)
 * before "review" (can take hours). A lane never preempts: the holder keeps the model until it
 * releases — except that a review holder calls checkpoint() at each turn boundary, which lends the
 * model to waiting "short" jobs (at most `cap` per checkpoint) and then gives it back to that same
 * review, ahead of every other queued job.
 */

/** Queue lane; a lower rank is granted first. */
export type LocalModelLane = "short" | "fix" | "review";
const LANE_RANK: Record<LocalModelLane, number> = { short: 0, fix: 1, review: 2 };
const lanePrecedes = (a: LocalModelLane, b: LocalModelLane): boolean => LANE_RANK[a] < LANE_RANK[b];

/** Short jobs a holder lends the model to per checkpoint unless the caller says otherwise. */
export const DEFAULT_SHORT_PER_CHECKPOINT = 2;
/** Safety ceiling for one checkpoint so an operator setting cannot starve the review holder. */
export const MAX_SHORT_PER_CHECKPOINT = 16;

/** ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT: short jobs (JSON repairs) a review lends the model to at
 * each turn boundary. Default 2, capped at 16; 0 turns lending off (repairs then wait for the review
 * to finish). */
export function shortJobsPerCheckpoint(
  env: Record<string, string | undefined> | undefined = typeof process !== "undefined" ? process.env : undefined,
): number {
  const raw = env?.ASHLAR_LOCAL_SHORT_JOBS_PER_CHECKPOINT;
  if (raw == null || raw.trim() === "") return DEFAULT_SHORT_PER_CHECKPOINT;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_SHORT_PER_CHECKPOINT) : DEFAULT_SHORT_PER_CHECKPOINT;
}

export type LocalModelLeaseHandle = {
  readonly owner: string;
  /** Idempotent. A handle already released (e.g. by releaseOwner) is a no-op. */
  release(): void;
};

export type LocalModelLeaseWait = {
  signal?: AbortSignal;
  /** Queue lane (default "review"). */
  lane?: LocalModelLane;
  /** Called with the 1-based queue position while waiting (only when it changes). Never throws out. */
  onPosition?: (position: number) => void;
};

type Waiter = {
  id: number;
  owner: string;
  lane: LocalModelLane;
  lastPosition: number;
  onPosition?: (position: number) => void;
  resolve: (handle: LocalModelLeaseHandle) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
};

/** A holder that lent its slot to a short job at a checkpoint. */
type Parked = { owner: string; wake: () => void };

export class LocalModelLeaseReleased extends Error {
  constructor(owner: string) {
    super(`local model lease wait for ${owner} was released before it was granted`);
    this.name = "LocalModelLeaseReleased";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("local model lease wait aborted"), { name: "AbortError" });
}

export class LocalModelLease {
  private seq = 0;
  private readonly active = new Map<number, string>();
  /** Holders whose slot is lent out (id → owner); they still occupy capacity. */
  private readonly parked = new Map<number, Parked>();
  /** Short job id → the parked holder id whose slot it runs on. */
  private readonly lends = new Map<number, number>();
  private readonly ids = new WeakMap<LocalModelLeaseHandle, number>();
  private queue: Waiter[] = [];
  private readonly capacity: number;

  constructor(capacity = 1) {
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
  }

  /** Wait (by lane, FIFO within it) for the model. Resolves with a handle the caller must release. */
  acquire(owner: string, opts: LocalModelLeaseWait = {}): Promise<LocalModelLeaseHandle> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = ++this.seq;
    if (!this.queue.length && this.occupied() < this.capacity) return Promise.resolve(this.grant(id, owner));
    return new Promise<LocalModelLeaseHandle>((resolve, reject) => {
      const onAbort = () => {
        if (this.drop(id)) reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const lane = opts.lane ?? "review";
      const waiter: Waiter = {
        id, owner, lane, lastPosition: 0, onPosition: opts.onPosition, resolve, reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      // Insert before the first waiter this lane precedes; equal lanes stay FIFO.
      const at = this.queue.findIndex((w) => lanePrecedes(lane, w.lane));
      this.queue.splice(at < 0 ? this.queue.length : at, 0, waiter);
      this.notifyPositions();
    });
  }

  /**
   * Turn boundary of a holder: lend the model to waiting "short" jobs, one at a time, at most `cap`
   * of them, then take it back ahead of every other queued job. Returns how many short jobs it lent to.
   * A no-op (0) when no short job is waiting or `handle` does not hold the model. When the holder is
   * revoked (releaseOwner / release) while its slot is lent, this returns at once; the short job
   * keeps running and the slot goes to the next waiter when it finishes. `signal` (the holder's own
   * cancellation) is honored before lending and while lent: an abort revokes the parked holder and
   * returns at once, leaving the borrower active on its slot until its own release.
   */
  async checkpoint(handle: LocalModelLeaseHandle, cap = DEFAULT_SHORT_PER_CHECKPOINT, signal?: AbortSignal): Promise<number> {
    const holderId = this.ids.get(handle);
    let served = 0;
    while (
      holderId !== undefined && served < cap && !signal?.aborted && this.active.has(holderId) && this.queue[0]?.lane === "short"
    ) {
      const owner = this.active.get(holderId) as string;
      const waiter = this.queue.shift() as Waiter;
      waiter.detach();
      const back = new Promise<void>((wake) => {
        this.active.delete(holderId);
        this.parked.set(holderId, { owner, wake });
      });
      this.lends.set(waiter.id, holderId);
      waiter.resolve(this.grant(waiter.id, waiter.owner));
      this.notifyPositions();
      const onAbort = () => { this.unpark(holderId); this.pump(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try { await back; } finally { signal?.removeEventListener("abort", onAbort); }
      served += 1;
    }
    return served;
  }

  /** Release everything `owner` holds and drop its queued waits (rejected with LocalModelLeaseReleased).
   * Returns how many holds + waits were removed. Used when a job is cancelled or removed. */
  releaseOwner(owner: string): number {
    let removed = 0;
    for (const [id, holder] of [...this.active]) {
      if (holder !== owner) continue;
      this.free(id, false);
      removed += 1;
    }
    for (const [id, parked] of [...this.parked]) {
      if (parked.owner !== owner) continue;
      this.unpark(id);
      removed += 1;
    }
    for (const waiter of this.queue.filter((w) => w.owner === owner)) {
      if (!this.drop(waiter.id)) continue;
      waiter.reject(new LocalModelLeaseReleased(owner));
      removed += 1;
    }
    if (removed) this.pump();
    return removed;
  }

  /** 1-based queue position of the owner's first wait; undefined when it is not waiting. */
  position(owner: string): number | undefined {
    const i = this.queue.findIndex((w) => w.owner === owner);
    return i < 0 ? undefined : i + 1;
  }

  /** Holders and waiters in grant order (waiters listed as they will be granted). A holder whose slot
   * is lent at a checkpoint is listed under `parked` (only when there is one). */
  snapshot(): { active: string[]; queued: string[]; parked?: string[] } {
    const out: { active: string[]; queued: string[]; parked?: string[] } = {
      active: [...this.active.values()], queued: this.queue.map((w) => w.owner),
    };
    if (this.parked.size) out.parked = [...this.parked.values()].map((p) => p.owner);
    return out;
  }

  /** Distinct slots in use. A parked holder's slot is the one its borrower runs on (counted once,
   * through the active borrower); a parked holder without a live borrower still holds its slot. */
  private occupied(): number {
    const lent = new Set(this.lends.values());
    let idle = 0;
    for (const id of this.parked.keys()) if (!lent.has(id)) idle += 1;
    return this.active.size + idle;
  }

  private grant(id: number, owner: string): LocalModelLeaseHandle {
    this.active.set(id, owner);
    const handle: LocalModelLeaseHandle = {
      owner,
      release: () => {
        if (this.active.has(id)) this.free(id, true);
        else if (this.parked.has(id)) { this.unpark(id); this.pump(); }
      },
    };
    this.ids.set(handle, id);
    return handle;
  }

  /** A holder's slot is freed. A short job running on a lent slot hands it straight back to its
   * parked holder (no pump: nobody else may take it); otherwise the queue advances when `pump`. */
  private free(id: number, pump: boolean) {
    if (!this.active.delete(id)) return;
    const lender = this.lends.get(id);
    if (lender !== undefined) {
      this.lends.delete(id);
      const parked = this.parked.get(lender);
      if (parked) {
        // Synchronously back to the holder, so no waiter can slip in before it resumes.
        this.parked.delete(lender);
        this.active.set(lender, parked.owner);
        parked.wake();
        // The hand-back keeps occupancy unchanged; any spare slot (capacity > 1) still goes to waiters.
        if (pump) this.pump();
        return;
      }
    }
    if (pump) this.pump();
  }

  /** Revoke a parked holder: its checkpoint returns; the lent short job keeps the slot until it ends. */
  private unpark(id: number) {
    const parked = this.parked.get(id);
    if (!parked) return;
    this.parked.delete(id);
    for (const [shortId, lender] of this.lends) if (lender === id) this.lends.delete(shortId);
    parked.wake();
  }

  /** Remove a queued waiter (true when it was still queued). */
  private drop(id: number): boolean {
    const i = this.queue.findIndex((w) => w.id === id);
    if (i < 0) return false;
    const [waiter] = this.queue.splice(i, 1);
    waiter.detach();
    this.notifyPositions();
    return true;
  }

  private pump() {
    let granted = false;
    while (this.queue.length && this.occupied() < this.capacity) {
      const waiter = this.queue.shift() as Waiter;
      waiter.detach();
      waiter.resolve(this.grant(waiter.id, waiter.owner));
      granted = true;
    }
    if (granted) this.notifyPositions();
  }

  private notifyPositions() {
    this.queue.forEach((waiter, i) => {
      const position = i + 1;
      if (waiter.lastPosition === position) return;
      waiter.lastPosition = position;
      try { waiter.onPosition?.(position); } catch { /* a progress observer never breaks the queue */ }
    });
  }
}

const GLOBAL_KEY = Symbol.for("ashlar.localModelLease");

/** The one process-wide lease review local legs, local fix calls and JSON repairs share (kept on
 * globalThis so a module loaded twice — e.g. Vite SSR — still shares a single queue). */
export function localModelLease(): LocalModelLease {
  const g = globalThis as unknown as Record<symbol, LocalModelLease | undefined>;
  return (g[GLOBAL_KEY] ??= new LocalModelLease());
}
