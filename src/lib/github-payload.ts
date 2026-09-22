import type { IngressTarget } from "./ingress.ts";
import { DEFAULT_SETTINGS, type BotSettings, type JobThread, type Trigger } from "./types.ts";
import { parseReviewLoopDirective, sameDirective } from "./review-loop.ts";
import { isBotMention } from "./poster.ts";

const PR_ACTIONS: Record<string, Trigger> = {
  opened: "pull_request.opened",
  reopened: "pull_request.reopened",
  synchronize: "pull_request.synchronize",
  ready_for_review: "pull_request.ready_for_review",
};

export type ParsedDelivery =
  | { ok: true; kind: "ping" }
  | { ok: true; kind: "ignore"; reason: string }
  | {
      ok: true;
      kind: "review";
      trigger: Trigger;
      target: IngressTarget;
      thread?: JobThread;
      installationId?: number;
      untrustedBody: string;
    }
  | { ok: false; reason: string };

type Gh = {
  action?: string;
  changes?: { body?: { from?: string | null } };
  installation?: { id?: number };
  repository?: { full_name?: string; fork?: boolean };
  sender?: { login?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    draft?: boolean;
    head?: { sha?: string; repo?: { fork?: boolean } | null };
    base?: { sha?: string };
    user?: { login?: string };
  };
  issue?: { number?: number; pull_request?: unknown; title?: string };
  comment?: { id?: number; body?: string };
};

function splitRepo(full: string | undefined): { owner: string; repo: string } | null {
  if (!full) return null;
  const [owner, repo] = full.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function parseGitHubPayload(event: string, raw: unknown, settings: BotSettings = DEFAULT_SETTINGS): ParsedDelivery {
  if (event === "ping") return { ok: true, kind: "ping" };
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "malformed payload" };
  const body = raw as Gh;
  const installationId = Number.isFinite(body.installation?.id) ? Number(body.installation?.id) : undefined;
  const repo = splitRepo(body.repository?.full_name);
  const sender = body.sender?.login ?? "unknown";

  if (event === "pull_request") {
    const pr = body.pull_request;
    const text = String(pr?.body ?? "");
    // Match the full body, not the preview. Retained mentions on push/reopen/ready
    // and unrelated edits must not turn a one-shot request into auto-review.
    const previous = body.changes?.body?.from;
    const newlyMentioned = body.action === "edited" && (typeof previous === "string" || previous === null) &&
      !isBotMention(previous ?? "", settings) && isBotMention(text, settings);
    // A /review-loop directive in the PR body is a fixed trigger (design §2), like a
    // mention: honor it on open, or when it was newly added on edit — never re-review an
    // unrelated edit to a PR whose body already carried the directive.
    const bodyLoop = parseReviewLoopDirective(text);
    // A newly added OR changed directive on edit is a fresh request (start↔stop,
    // suggest→apply); an unchanged retained directive is an unrelated edit, ignored.
    const newlyLoop = body.action === "edited" && (typeof previous === "string" || previous === null) &&
      bodyLoop != null && !sameDirective(parseReviewLoopDirective(previous ?? ""), bodyLoop);
    const bodyRequest =
      (body.action === "opened" && (isBotMention(text, settings) || bodyLoop != null)) || newlyMentioned || newlyLoop;
    const trigger: Trigger | undefined = bodyRequest ? "pull_request.body_mention" : PR_ACTIONS[body.action ?? ""];
    if (!trigger) return { ok: true, kind: "ignore", reason: `action ignored (${body.action ?? "none"}; no new body mention)` };
    if (!repo || !pr?.number || !pr.head?.sha) return { ok: false, reason: "pull_request missing repo or head" };
    const target: IngressTarget = {
      owner: repo.owner,
      repo: repo.repo,
      pr: pr.number,
      title: String(pr.title ?? `PR #${pr.number}`).slice(0, 200),
      headSha: pr.head.sha,
      baseSha: pr.base?.sha ?? "",
      sender: bodyRequest ? sender : pr.user?.login ?? sender,
      isFork: typeof pr.head.repo?.fork === "boolean" ? pr.head.repo.fork : null,
      isDraft: Boolean(pr.draft),
    };
    return {
      ok: true,
      kind: "review",
      trigger,
      target,
      installationId,
      // A PR-body request has no comment ID: reactions belong on the PR itself.
      thread: bodyRequest ? { kind: "pr_body", commentId: 0, userText: text, loop: bodyLoop ?? undefined } : undefined,
      untrustedBody: text.slice(0, 4000),
    };
  }

  if (event === "issue_comment") {
    if (body.action !== "created" && body.action !== "edited") {
      return { ok: true, kind: "ignore", reason: `action ignored (${body.action ?? "none"})` };
    }
    if (!body.issue?.pull_request) return { ok: true, kind: "ignore", reason: "not a pull request comment" };
    if (!repo || !body.issue.number) return { ok: false, reason: "issue_comment missing repo or number" };
    const target: IngressTarget = {
      owner: repo.owner,
      repo: repo.repo,
      pr: body.issue.number,
      title: String(body.issue.title ?? `PR #${body.issue.number}`).slice(0, 200),
      headSha: "",
      baseSha: "",
      sender,
      // The destination repository says nothing about this PR's head.
      isFork: null,
      isDraft: false,
    };
    return {
      ok: true,
      kind: "review",
      trigger: "issue_comment.mention",
      target,
      installationId,
      thread: {
        kind: "mention",
        commentId: Number(body.comment?.id ?? 0),
        userText: String(body.comment?.body ?? ""),
        loop: parseReviewLoopDirective(String(body.comment?.body ?? "")) ?? undefined,
      },
      untrustedBody: String(body.comment?.body ?? "").slice(0, 4000),
    };
  }

  if (event === "pull_request_review_comment") {
    if (body.action !== "created" && body.action !== "edited") return { ok: true, kind: "ignore", reason: `action ignored (${body.action ?? "none"})` };
    const pr = body.pull_request;
    if (!repo || !pr?.number || !pr.head?.sha) return { ok: false, reason: "review comment missing pull_request" };
    const target: IngressTarget = {
      owner: repo.owner,
      repo: repo.repo,
      pr: pr.number,
      title: String(pr.title ?? `PR #${pr.number}`).slice(0, 200),
      headSha: pr.head.sha,
      baseSha: pr.base?.sha ?? "",
      sender,
      isFork: typeof pr.head.repo?.fork === "boolean" ? pr.head.repo.fork : null,
      isDraft: Boolean(pr.draft),
      };
    return {
      ok: true,
      kind: "review",
      trigger: "pull_request_review_comment.followup",
      target,
      installationId,
      thread: {
        kind: "followup",
        commentId: Number(body.comment?.id ?? 0),
        userText: String(body.comment?.body ?? ""),
        loop: parseReviewLoopDirective(String(body.comment?.body ?? "")) ?? undefined,
      },
      untrustedBody: String(body.comment?.body ?? "").slice(0, 4000),
    };
  }

  return { ok: true, kind: "ignore", reason: "event ignored" };
}
