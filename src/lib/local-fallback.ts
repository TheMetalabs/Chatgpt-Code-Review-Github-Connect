import type { Job, ReviewProvider } from "./types.ts";
import { isChatProvider } from "./types.ts";

/** Wait this long for Chrome when the bridge is not connected / not claimed. */
export const LOCAL_FALLBACK_MS = 90_000;
/** If Chrome claimed the job but never completed, start local after this. */
export const LOCAL_FALLBACK_CLAIMED_MS = 6 * 60_000;

export function shouldStartLocalFallback(input: {
  providers: readonly ReviewProvider[];
  status: Job["status"];
  connected: boolean;
  claimed: boolean;
  localDone: boolean;
  localStarted: boolean;
  waitedMs: number;
}): boolean {
  if (input.localDone || input.localStarted) return false;
  if (input.status !== "awaiting_chat") return false;
  if (!input.providers.includes("local")) return false;
  if (!input.providers.some(isChatProvider)) return false;
  if (input.claimed) return input.waitedMs >= LOCAL_FALLBACK_CLAIMED_MS;
  if (input.connected) return input.waitedMs >= LOCAL_FALLBACK_MS;
  return input.waitedMs >= LOCAL_FALLBACK_MS;
}
