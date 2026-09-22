import { llmWorkAllowed } from "./ops-comment.ts";
import { isBotMention } from "./poster.ts";
import { parseReviewLoopDirective, stripLoopDirectives } from "./review-loop.ts";
import { SAMPLE_PRS } from "./samples.ts";
import type { BotSettings, ForkStatus, Job, Trigger, WebhookLog } from "./types.ts";

export type IngressTarget = {
  owner: string;
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  baseSha: string;
  sender: string;
  isFork: ForkStatus;
  isDraft: boolean;
  key?: string;
  sampleKey?: string;
};

export type IngressDecision =
  | {
      ok: true;
      job: Omit<
        Job,
        | "id"
        | "traces"
        | "candidates"
        | "findings"
        | "plan"
        | "investigatedSafe"
        | "assumptions"
        | "createdAt"
        | "updatedAt"
        | "status"
        | "ingressMs"
      >;
      skip?: undefined;
    }
  | { ok: true; skip: string; job?: undefined }
  | { ok: false; status: 403; reason: string };

/** Shared by ingress and the worker after comment events resolve the real PR metadata.
 * PR lifecycle state is not an execution gate for an explicit request. Fork trust
 * policy, authentication and duplicate-delivery checks remain independent.
 */
export function reviewSkipReason(opts: {
  sample: Pick<IngressTarget, "isDraft" | "isFork">;
  trigger: Trigger;
  thread?: Job["thread"];
  settings: BotSettings;
  /** Ingress may queue metadata resolution, never snapshot or reviewer work. */
  deferUnknownFork?: boolean;
}): string | undefined {
  const mentionTrigger = llmWorkAllowed(opts);
  // The `/review-loop*` triggers are fixed literals (design §2), independent of the
  // configurable @-mention tokens. A start directive is an explicit request; a stop
  // directive is a control command, not a review (the loop engine handles it later).
  const loop = opts.thread?.loop ?? parseReviewLoopDirective(opts.thread?.userText);
  // An INDEPENDENT mention is one that survives after the loop-directive spans are removed:
  // `@ashlar-bot review-loop stop` has none (the mention is part of the directive), while
  // `@ashlar-bot review … /review-loop stop` still has the explicit `@ashlar-bot review`.
  const independentMention = isBotMention(stripLoopDirectives(opts.thread?.userText), opts.settings);
  // A stop directive is control-only unless the body ALSO carries an independent mention,
  // which must still queue its own review.
  if (mentionTrigger && loop?.kind === "stop" && !independentMention)
    return "review-loop stop (no active loop engine)";
  const requested = mentionTrigger && (loop?.kind === "start" || independentMention);
  if (opts.settings.skipDrafts && opts.sample.isDraft && !requested) return "draft";
  if (opts.settings.skipForks) {
    if (opts.sample.isFork === true) return "fork (allowlist empty) · PR body not promoted to policy";
    if (opts.sample.isFork !== false && !opts.deferUnknownFork) return "fork provenance unknown · head repository could not be verified";
  }
  if (!requested) return mentionTrigger ? "not a mention" : "LLM only on explicit @ashlar-bot mention";
  return undefined;
}

export function acceptedDeliveryIds(events: Pick<WebhookLog, "deliveryId" | "httpStatus">[]): string[] {
  return events.filter((e) => e.httpStatus === 202).map((e) => e.deliveryId);
}

export function decideIngress(opts: {
  hmacOk: boolean;
  settings: BotSettings;
  sample: IngressTarget;
  trigger: Trigger;
  deliveryId: string;
  existing: Job[];
  knownDeliveries?: string[];
  thread?: Job["thread"];
}): IngressDecision {
  if (!opts.hmacOk) return { ok: false, status: 403, reason: "HMAC mismatch" };

  const known = opts.knownDeliveries ?? [];
  if (known.includes(opts.deliveryId) || opts.existing.some((j) => j.deliveryId === opts.deliveryId)) {
    return { ok: true, skip: `duplicate delivery_id ${opts.deliveryId}` };
  }

  // An unknown head may enter the metadata queue. The worker must resolve it
  // and apply the default fail-closed policy before fetching source files.
  const skip = reviewSkipReason({ ...opts, deferUnknownFork: true });
  if (skip) return { ok: true, skip };
  // Each explicit request is new work, even at a previously posted/skipped head.
  // Only redelivery of the same event is suppressed above.

  return {
    ok: true,
    job: {
      deliveryId: opts.deliveryId,
      trigger: opts.trigger,
      owner: opts.sample.owner,
      repo: opts.sample.repo,
      pr: opts.sample.pr,
      title: opts.sample.title,
      headSha: opts.sample.headSha,
      baseSha: opts.sample.baseSha,
      sender: opts.sample.sender,
      isFork: opts.sample.isFork,
      isDraft: opts.sample.isDraft,
      thread: opts.thread,
      sampleKey: opts.sample.sampleKey ?? opts.sample.key,
    },
  };
}

export function sampleByKey(key: string) {
  return SAMPLE_PRS[key];
}
