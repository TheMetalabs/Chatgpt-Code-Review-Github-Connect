// The local fix agent's model call (the local-llm branch of review-loop-runtime's productionRequestFix).
// Kept in its own module so the shared runtime (chat fix transport, loop control) stays untouched.
import type { RequestFix } from "./fix-agent.ts";
import type { requestLocalChat } from "./local-chat-request.server.ts";
import type { LocalModelLease } from "./local-model-lease.ts";
import type { BotSettings } from "./types.ts";

export type LocalFixDeps = {
  /** The process-wide local-model lease (injected for tests). */
  lease?: () => LocalModelLease;
  /** The local chat transport (injected for tests). */
  requestLocalChat?: typeof requestLocalChat;
};

type RequestFixControl = Parameters<RequestFix>[1];
/** The PR a fix is for (structurally review-loop-control's PrRef; not imported: only the gated
 * engine and runtime may import the control module). */
type PrRef = { owner: string; repo: string; pr: number };

let localFixSeq = 0;

/** One local fix call. It holds the process-wide local-model lease (the one review local legs
 * take) for the whole call, in the "fix" lane: queued ahead of every queued review, but never
 * preempting the review that holds the model now. Abort-aware: a cancelled fix leaves the queue at
 * once, and a cancel that lands between the grant and this continuation gives the model back before
 * anything is sent. Released in finally. The wait is announced to the watcher (ctl.waitForModel): it
 * counts toward the queue ceiling (queueMaxMs, from send), never the generation deadline, and the
 * liveness clock stays unarmed until the server shows a sign of life. */
export async function requestLocalFix(
  settings: BotSettings,
  ref: PrRef,
  prompt: string,
  ctl: RequestFixControl | undefined,
  deps: LocalFixDeps = {},
): Promise<string> {
  const signal = ctl?.signal;
  const lease = deps.lease ? deps.lease() : (await import("./local-model-lease.ts")).localModelLease();
  const dispatched = ctl?.waitForModel?.();
  const handle = await lease.acquire(`fix:${ref.owner}/${ref.repo}#${ref.pr}:${++localFixSeq}`, { signal, lane: "fix" });
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("local fix cancelled before its request");
    const request = deps.requestLocalChat ?? (await import("./local-chat-request.server.ts")).requestLocalChat;
    const llm = await import("./local-llm.server.ts");
    dispatched?.();
    return await request(
      settings.localLlmBaseUrl,
      settings.localLlmApiKey,
      {
        model: settings.localLlmModel,
        messages: [
          { role: "system", content: "You are the Ashlar fix agent. Return ONLY the JSON object described in the prompt." },
          { role: "user", content: prompt },
        ],
        // The review path's tuned sampling + budget: without it a reasoning model decodes greedily,
        // loops, and ends at the token cap (finish_reason=length) before emitting the JSON.
        ...llm.samplingRequestFields(llm.localGenerationParams(settings)),
      },
      signal,
      { onActivity: (a) => ctl?.onActivity?.(a.kind === "output" ? "generating" : "queued") },
    );
  } finally {
    handle.release();
  }
}
