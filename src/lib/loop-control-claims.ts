/**
 * Delivery claims for review-loop control (stop / push continuation / start recording).
 *
 * WHY: a control-only delivery (a stop, a push that queues no job) leaves no job or accepted event
 * behind, so a redelivered webhook cannot be recognized from harbor's records. Loop control claims
 * the delivery id BEFORE its side effect; a claim is released when the step did not land (failed
 * or blocked), so a redelivery can retry it. Bounded, oldest first; in-process only.
 */
export function createDeliveryClaims(max = 1000) {
  const claimed = new Map<string, true>();
  return {
    /** True for the first claim of an id (run the side effect); false for a repeat (skip it). */
    claim(id: string): boolean {
      if (claimed.has(id)) return false;
      claimed.set(id, true);
      for (const k of claimed.keys()) {
        if (claimed.size <= max) break;
        claimed.delete(k);
      }
      return true;
    },
    /** Forget a claim whose step did not land, so a redelivery may retry it. */
    release(id: string): void {
      claimed.delete(id);
    },
    get size(): number {
      return claimed.size;
    },
  };
}
