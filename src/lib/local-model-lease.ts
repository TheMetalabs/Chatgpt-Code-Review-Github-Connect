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
 * The review local leg and the local fix agent take this lease; other local callers (JSON repair,
 * manual run) are unchanged.
 *
 * Lanes: a waiter joins the queue in its lane. A queued "fix" waiter is granted before every queued
 * "review" waiter (a fix round is one call that unblocks a PR, a review round can take hours), FIFO
 * within a lane. A lane never preempts: the review that already holds the model keeps it until it
 * releases.
 */

/** Queue lane; a lower rank is granted first. */
export type LocalModelLane = "fix" | "review";
const LANE_RANK: Record<LocalModelLane, number> = { fix: 0, review: 1 };

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
  private queue: Waiter[] = [];
  private readonly capacity: number;

  constructor(capacity = 1) {
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
  }

  /** Wait (FIFO) for the model. Resolves with a handle the caller must release. */
  acquire(owner: string, opts: LocalModelLeaseWait = {}): Promise<LocalModelLeaseHandle> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = ++this.seq;
    if (!this.queue.length && this.active.size < this.capacity) return Promise.resolve(this.grant(id, owner));
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
      // Behind every waiter of the same or a higher-priority lane, ahead of every lower one.
      const at = this.queue.findIndex((w) => LANE_RANK[w.lane] > LANE_RANK[lane]);
      if (at < 0) this.queue.push(waiter);
      else this.queue.splice(at, 0, waiter);
      this.notifyPositions();
    });
  }

  /** Release everything `owner` holds and drop its queued waits (rejected with LocalModelLeaseReleased).
   * Returns how many holds + waits were removed. Used when a job is cancelled or removed. */
  releaseOwner(owner: string): number {
    let removed = 0;
    for (const [id, holder] of [...this.active]) {
      if (holder !== owner) continue;
      this.active.delete(id);
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

  /** Holders and waiters in grant order (waiters listed as they will be granted). */
  snapshot(): { active: string[]; queued: string[] } {
    return { active: [...this.active.values()], queued: this.queue.map((w) => w.owner) };
  }

  /** Ownership is registered HERE, synchronously, before the waiter's promise resolves: releaseOwner
   * revokes a grant whose holder has not resumed yet, without depending on that continuation. */
  private grant(id: number, owner: string): LocalModelLeaseHandle {
    this.active.set(id, owner);
    return {
      owner,
      release: () => {
        if (this.active.delete(id)) this.pump();
      },
    };
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
    while (this.queue.length && this.active.size < this.capacity) {
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

/** The one process-wide lease review local legs and local fix calls share (kept on globalThis so a module loaded twice —
 * e.g. Vite SSR — still shares a single queue). */
export function localModelLease(): LocalModelLease {
  const g = globalThis as unknown as Record<symbol, LocalModelLease | undefined>;
  return (g[GLOBAL_KEY] ??= new LocalModelLease());
}
