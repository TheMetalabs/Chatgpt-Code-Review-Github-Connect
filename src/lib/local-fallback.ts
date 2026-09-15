import type { Job, ReviewProvider } from "./types.ts";
import { isChatProvider } from "./types.ts";

export function shouldStartLocalRace(input: {
  providers: readonly ReviewProvider[];
  status: Job["status"];
  localDone: boolean;
  localStarted: boolean;
}): boolean {
  if (input.localDone || input.localStarted) return false;
  if (input.status !== "awaiting_chat" && input.status !== "reviewer") return false;
  return input.providers.includes("local");
}

export function skippedProvider(assumptions: readonly string[] | undefined, provider: ReviewProvider): boolean {
  const rows = assumptions ?? [];
  if (provider === "local") return rows.some((a) => /^Skipped local/i.test(a));
  return rows.some((a) => new RegExp(`Skipped ${provider}`, "i").test(a));
}

/** Wait only while an enabled reviewer is still producing an answer. No wall clock. */
export function stillRacing(input: {
  providers: readonly ReviewProvider[];
  payloads: readonly ReviewProvider[];
  assumptions?: readonly string[];
  localInFlight: boolean;
  generating?: Partial<Record<ReviewProvider, boolean>>;
  claimed: boolean;
  connected: boolean;
}): boolean {
  for (const p of input.providers) {
    if (input.payloads.includes(p)) continue;
    if (skippedProvider(input.assumptions, p)) continue;
    if (p === "local") {
      if (input.localInFlight) return true;
      continue;
    }
    const g = input.generating?.[p];
    if (g === true) return true;
    if (g === false) continue;
    if (input.claimed || input.connected) return true;
  }
  return false;
}

export function shouldHoldForLocal(input: {
  providers: readonly ReviewProvider[];
  haveLocal: boolean;
  localSkipped: boolean;
  localInFlight: boolean;
  chatFpRound?: boolean;
}): boolean {
  if (input.chatFpRound) return false;
  if (!input.providers.includes("local")) return false;
  if (input.haveLocal || input.localSkipped) return false;
  return input.localInFlight;
}

export function shouldHoldForChat(input: {
  providers: readonly ReviewProvider[];
  haveChat: boolean;
  chatSkipped: boolean;
  claimed: boolean;
  connected: boolean;
  chatFpRound?: boolean;
  allChatAttempted?: boolean;
  generating?: Partial<Record<ReviewProvider, boolean>>;
  payloads?: readonly ReviewProvider[];
  assumptions?: readonly string[];
}): boolean {
  if (input.chatFpRound) return false;
  return stillRacing({
    providers: input.providers.filter(isChatProvider),
    payloads: input.payloads ?? (input.haveChat ? input.providers.filter(isChatProvider) : []),
    assumptions: input.assumptions ?? (input.chatSkipped ? input.providers.filter(isChatProvider).map((p) => `Skipped ${p}`) : []),
    localInFlight: false,
    generating: input.generating,
    claimed: input.claimed,
    connected: input.connected,
  });
}