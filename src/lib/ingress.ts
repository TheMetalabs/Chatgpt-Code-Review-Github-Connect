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

const MENTION_TRIGGERS: Trigger[] = ["issue_comment.mention", "pull_request_review_comment.followup"];

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

  if (opts.settings.skipDrafts && opts.sample.isDraft) {
    return { ok: true, skip: "draft" };
  }
  if (opts.settings.skipForks && opts.sample.isFork) {
    return { ok: true, skip: "fork (allowlist empty) · PR body not promoted to policy" };
  }

  if (MENTION_TRIGGERS.includes(opts.trigger)) {
    if (!isBotMention(opts.thread?.userText, opts.settings)) {
      return { ok: true, skip: "not a mention" };
    }
  } else {
    // No silent auto-review on PR open/push/reopen — LLM only after explicit @ashlar-bot (or settings mention tokens).
    return { ok: true, skip: "LLM only on explicit @ashlar-bot mention" };
  }

  const sameHead = opts.existing.find(
    (j) =>
      j.owner === opts.sample.owner &&
      j.repo === opts.sample.repo &&
      j.pr === opts.sample.pr &&
      j.headSha === opts.sample.headSha &&
      Boolean(opts.sample.headSha) &&
      j.trigger === opts.trigger &&
      (j.status === "posted" || j.status === "skipped"),
  );
  if (sameHead && !MENTION_TRIGGERS.includes(opts.trigger)) {
    return { ok: true, skip: "idempotent (repo, pr, head_sha, trigger)" };
  }

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
      thread: MENTION_TRIGGERS.includes(opts.trigger) ? opts.thread : undefined,
      sampleKey: opts.sample.sampleKey ?? opts.sample.key,
    },
  };
}

export function sampleByKey(key: string) {
  return SAMPLE_PRS[key];
}
