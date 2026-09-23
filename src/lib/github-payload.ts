import type { IngressTarget } from "./ingress.ts";
import { DEFAULT_SETTINGS, type BotSettings, type JobThread, type Trigger } from "./types.ts";
import { canonicalContinuation, DEFAULT_ASHLAR_BOT_LOGIN, freshLoopDirective, isSelfLogin, stripLoopDirectives } from "./review-loop.ts";
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

export function parseGitHubPayload(
  event: string,
  raw: unknown,
  settings: BotSettings = DEFAULT_SETTINGS,
  opts: { botLogin?: string } = {},
): ParsedDelivery {
  if (event === "ping") return { ok: true, kind: "ping" };
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "malformed payload" };
  const body = raw as Gh;
  const installationId = Number.isFinite(body.installation?.id) ? Number(body.installation?.id) : undefined;
  const repo = splitRepo(body.repository?.full_name);
  const sender = body.sender?.login ?? "unknown";
  // INVARIANT (design §2): a comment authored by this App is never a command. Its findings,
  // fix reports, ops updates and replies quote trigger phrases (`/review-loop apply`,
  // `@ashlar-bot review`); parsing them re-triggered the bot on its own output. The single
  // exception is the loop driver's continuation marker (issue comment, created, same PR).
  const selfAuthored = isSelfLogin(body.sender?.login, opts.botLogin ?? DEFAULT_ASHLAR_BOT_LOGIN);

  if (event === "pull_request") {
    const pr = body.pull_request;
    const text = String(pr?.body ?? "");
    // Match the full body, not the preview. Retained mentions on push/reopen/ready
    // and unrelated edits must not turn a one-shot request into auto-review.
    const previous = body.changes?.body?.from;
    // Detect an INDEPENDENT mention from the body with loop-directive spans removed, so a
    // mention that is part of the directive itself (@ashlar-bot review-loop stop) is not
    // promoted to a body request — mirrors ingress's independentMention (design §2).
    const strippedText = stripLoopDirectives(text);
    const strippedPrev = stripLoopDirectives(previous ?? "");
    const newlyMentioned = body.action === "edited" && (typeof previous === "string" || previous === null) &&
      !isBotMention(strippedPrev, settings) && isBotMention(strippedText, settings);
    const bodyMention = (body.action === "opened" && isBotMention(strippedText, settings)) || newlyMentioned;
    // Only a START directive (suggest/apply) is a review request on PR lifecycle events; a
    // stop is a no-op here (avoids a spurious skipped job on PR open/edit). freshLoopDirective
    // also drops a directive left unchanged during an unrelated body edit.
    const freshLoop = freshLoopDirective(body.action, text, previous);
    const bodyLoopStart = freshLoop?.kind === "start" ? freshLoop : undefined;
    // The App never authors PR bodies; should a self-authored body edit ever carry a mention or
    // directive it is not a command either (same invariant as comments). Its pushes
    // (synchronize) still parse as lifecycle events below.
    const bodyRequest = !selfAuthored && (bodyMention || bodyLoopStart != null);
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
      // Preserve the full directive (incl. a coexisting stop) as metadata when a review is
      // requested, matching the issue_comment path; bodyLoopStart only gates promotion above.
      thread: bodyRequest ? { kind: "pr_body", commentId: 0, userText: text, loop: freshLoop } : undefined,
      untrustedBody: text.slice(0, 4000),
    };
  }

  if (event === "issue_comment") {
    if (body.action !== "created" && body.action !== "edited") {
      return { ok: true, kind: "ignore", reason: `action ignored (${body.action ?? "none"})` };
    }
    if (!body.issue?.pull_request) return { ok: true, kind: "ignore", reason: "not a pull request comment" };
    if (!repo || !body.issue.number) return { ok: false, reason: "issue_comment missing repo or number" };
    // The continuation is honored only as a NEW comment that IS the driver's canonical
    // continuation for THIS PR (exact text, marker first); any other self-authored comment — a
    // report quoting a marker in model text included — or an edit of one is ignored outright.
    const continuation = selfAuthored && body.action === "created"
      ? canonicalContinuation(body.comment?.body, { authoredByBot: true })
      : null;
    if (selfAuthored && (!continuation || continuation.pr !== body.issue.number)) {
      return { ok: true, kind: "ignore", reason: "bot-authored comment (never a trigger)" };
    }
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
        loop: continuation
          ? { kind: "start", mode: continuation.mode }
          : freshLoopDirective(body.action, body.comment?.body, body.changes?.body?.from),
      },
      untrustedBody: String(body.comment?.body ?? "").slice(0, 4000),
    };
  }

  if (event === "pull_request_review_comment") {
    if (body.action !== "created" && body.action !== "edited") return { ok: true, kind: "ignore", reason: `action ignored (${body.action ?? "none"})` };
    // Inline comments by the App are its own findings / thread replies — never commands.
    if (selfAuthored) return { ok: true, kind: "ignore", reason: "bot-authored review comment (never a trigger)" };
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
        loop: freshLoopDirective(body.action, body.comment?.body, body.changes?.body?.from),
      },
      untrustedBody: String(body.comment?.body ?? "").slice(0, 4000),
    };
  }

  return { ok: true, kind: "ignore", reason: "event ignored" };
}
