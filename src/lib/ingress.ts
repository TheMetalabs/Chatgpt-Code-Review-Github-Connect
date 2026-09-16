import { llmWorkAllowed } from "./ops-comment.ts";
import { isBotMention } from "./poster.ts";
import { SAMPLE_PRS } from "./samples.ts";
import type { BotSettings, Job, Trigger, WebhookLog } from "./types.ts";

export type IngressTarget = {
  owner: string;
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  baseSha: string;
  sender: string;
  isFork: boolean;
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
}): string | undefined {
  const mentionTrigger = llmWorkAllowed(opts);
  const requested = mentionTrigger && isBotMention(opts.thread?.userText, opts.settings);
  if (opts.settings.skipDrafts && opts.sample.isDraft && !requested) return "draft";
  if (opts.settings.skipForks && opts.sample.isFork) return "fork (allowlist empty) · PR body not promoted to policy";
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

  const skip = reviewSkipReason(opts);
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
