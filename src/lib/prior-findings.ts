// WHY (precision, D — latest head only, no re-posting): the bot re-posted the same finding on every
// head of a PR, and a second request on an unchanged head posted the same review twice. This module
// reads the bot's OWN earlier findings back from what it posted on GitHub — the inline finding
// comments (review-format inlineFindingComment) and the "Findings without an inline anchor" block of
// its review bodies (review-format unanchoredBlock) — so the finding gate can drop re-posts
// (GateContext.priorFindings) and the poster can skip a review that adds nothing on a head it
// already reviewed. Pure: the GitHub listing is the caller's (harbor loadPriorFindings), and every
// parse is fail-soft (an unrecognised comment is simply not a prior finding). What counts as a repeat
// is the gate's own predicate (finding-gate findPriorDuplicate), never a looser one.

import { extractEvidenceQuotes, findPriorDuplicate } from "./finding-gate.ts";
import type { BotSettings, PriorFinding } from "./types.ts";

/** A review comment row as github.server listReviewComments returns it (the fields read here). */
export type PriorCommentRow = {
  id?: number;
  inReplyToId?: number;
  line?: number;
  userLogin: string;
  path: string;
  commitId: string;
  body?: string;
};

/** A review row as github.server listPullReviews returns it. */
export type PriorReviewRow = { userLogin: string; body: string; commitId: string; submittedAt?: string };

export type PriorFindingsResult = {
  findings: PriorFinding[];
  /** Commits the bot already posted a review summary on (newest first, as GitHub listed them reversed). */
  reviewedHeads: string[];
};

/** Settings readers for BotSettings.postLatestHeadOnly / findingDedupePrior (Settings screen
 * "Finding precision", default true). A hand-built settings object without the field reads as the
 * default, like settings.server normalizes a file saved before the fields existed. */
export function postLatestHeadOnlyOn(settings: Pick<Partial<BotSettings>, "postLatestHeadOnly">): boolean {
  return settings.postLatestHeadOnly !== false;
}
export function dedupePriorOn(settings: Pick<Partial<BotSettings>, "findingDedupePrior">): boolean {
  return settings.findingDedupePrior !== false;
}

/** Same commit: equal, or one is an abbreviation (>= 7 chars) of the other. Empty never matches. */
export function sameSha(a: string | undefined, b: string | undefined): boolean {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

const sameLogin = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// The severity badge review-format.severityBadgeMarkdown renders: `![P1 Badge](https://img.shields.io/...)`.
const BADGE_RE = /!\[(P[0-9]) Badge\]\([^)]*\)/;
const SUMMARY_MARK = "<!-- ashlar-review-summary -->";
const FINDINGS_MARKER = "<!-- ashlar-findings";
const RAW_START = "<!-- ashlar-raw:start -->";
const RAW_END = "<!-- ashlar-raw:end -->";
const UNANCHORED_HEADER = "**Findings without an inline anchor**";

/** Undo neutralizeMarkers (the body escapes `<!--`/`-->` inside model text). */
const unneutralize = (s: string) => s.replace(/&lt;!--/g, "<!--").replace(/--&gt;/g, "-->");

/** The last bold run that is not the badge itself (`**<sub><sub>![…](…)</sub></sub>**`). */
function lastBoldTitle(line: string): string {
  const bold = [...line.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) => m[1]).filter((t) => !/^<sub>/.test(t) && !BADGE_RE.test(t));
  return (bold.at(-1) ?? "").trim();
}

/** One inline finding comment (inlineFindingComment): `<badge>  **title**`, then paragraphs, one of
 * which is `Evidence: …`. Anything without the badge on its first line (a fix-agent reply, an ops
 * note, a human comment) is not a finding. */
export function parseInlineFindingComment(body: string | null | undefined): { title: string; evidence?: string; severity: string } | null {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const badge = first.match(BADGE_RE);
  if (!badge) return null;
  const title = lastBoldTitle(first);
  if (!title) return null;
  const paras = text.split(/\n{2,}/);
  const ev = paras.find((p) => p.startsWith("Evidence: "));
  const evidence = ev ? ev.slice("Evidence: ".length).trim() : undefined;
  return { title, severity: badge[1], ...(evidence ? { evidence } : {}) };
}

/** Remove every verbatim salvaged block: model text inside it is not a structured finding and could
 * imitate one. */
function stripRawBlocks(body: string): string {
  let s = body;
  for (let start = s.indexOf(RAW_START); start >= 0; start = s.indexOf(RAW_START)) {
    const end = s.indexOf(RAW_END, start);
    s = `${s.slice(0, start)}${end < 0 ? "" : s.slice(end + RAW_END.length)}`;
  }
  return s;
}

/** The findings a review summary body lists in its "Findings without an inline anchor" block
 * (unanchoredBlock): `- <badge> \`file:line\` — **title**` followed by one indented detail line whose
 * parts are joined by " — " (failure — root cause — Evidence: … — Fix: …). Only that block is read: a
 * Notes section, the severity table or a verbatim reply are never findings. */
export function parseReviewBodyFindings(body: string | null | undefined): { file: string; line?: number; title: string; evidence?: string; severity: string }[] {
  const text = stripRawBlocks(String(body ?? "").replace(/\r\n/g, "\n"));
  const at = text.indexOf(UNANCHORED_HEADER);
  if (at < 0) return [];
  const lines = text.slice(at).split("\n").slice(1);
  const out: { file: string; line?: number; title: string; evidence?: string; severity: string }[] = [];
  let started = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      if (started) break; // the block ends at its first blank line after the rows
      continue;
    }
    if (line.startsWith("  ") && out.length) {
      const parts = line.trim().split(" — ");
      const ev = parts.find((p) => p.startsWith("Evidence: "));
      if (ev && !out.at(-1)!.evidence) out.at(-1)!.evidence = unneutralize(ev.slice("Evidence: ".length).trim());
      continue;
    }
    if (!line.startsWith("- ")) break;
    started = true;
    const badge = line.match(BADGE_RE);
    const loc = line.match(/`([^`]+?):(\d+)`/);
    const title = lastBoldTitle(line);
    if (!badge || !loc || !title) continue;
    out.push({ file: unneutralize(loc[1]), line: Number(loc[2]), title: unneutralize(title), severity: badge[1] });
  }
  return out;
}

/** Whether a review body is one of the bot's review summaries (not a loop/ops marker comment). */
export function isReviewSummaryBody(body: string | null | undefined): boolean {
  const s = String(body ?? "");
  return s.includes(SUMMARY_MARK) || s.includes(FINDINGS_MARKER);
}

/**
 * The bot's own earlier findings on a PR: its root inline finding comments plus the unanchored
 * findings of its review summaries, each with the commit it was posted on. Rows by anyone else, and
 * replies (the fix agent answers in-thread under the same login), are ignored.
 */
export function collectPriorFindings(input: { comments: readonly PriorCommentRow[]; reviews: readonly PriorReviewRow[]; botLogin: string }): PriorFindingsResult {
  const findings: PriorFinding[] = [];
  for (const c of input.comments) {
    if (c.inReplyToId !== undefined || !sameLogin(c.userLogin, input.botLogin) || !c.path) continue;
    const parsed = parseInlineFindingComment(c.body);
    if (!parsed) continue;
    findings.push({ file: c.path, title: parsed.title, ...(parsed.evidence ? { evidence: parsed.evidence } : {}), ...(c.commitId ? { commitId: c.commitId } : {}), ...(c.line ? { line: c.line } : {}) });
  }
  const reviewedHeads: string[] = [];
  for (const r of input.reviews) {
    if (!sameLogin(r.userLogin, input.botLogin) || !isReviewSummaryBody(r.body)) continue;
    if (r.commitId && !reviewedHeads.includes(r.commitId)) reviewedHeads.unshift(r.commitId);
    for (const f of parseReviewBodyFindings(r.body)) {
      findings.push({ file: f.file, title: f.title, ...(f.evidence ? { evidence: f.evidence } : {}), ...(r.commitId ? { commitId: r.commitId } : {}), ...(f.line ? { line: f.line } : {}) });
    }
  }
  return { findings, reviewedHeads };
}

/**
 * A finding repeats a prior one — the finding gate's own duplicate predicate (finding-gate
 * findPriorDuplicate), so the same-head repost check and the gate's dedupe never disagree: the same file
 * and a near-identical title, or shared quoted code together with a corroborating claim (similar title,
 * or two shared title words). Shared evidence alone is not a repeat: two independent defects can quote
 * one statement (an injection and a missing tenant filter on the same DELETE).
 */
export function isPriorDuplicate(f: { file: string; title: string; evidence?: string; line?: number }, prior: readonly PriorFinding[]): boolean {
  return findPriorDuplicate(f, { priorFindings: [...prior] }, extractEvidenceQuotes(f.evidence ?? "")) !== undefined;
}

/** The prior findings posted on exactly this head. */
export function priorOnHead(prior: readonly PriorFinding[], headSha: string): PriorFinding[] {
  return prior.filter((p) => sameSha(p.commitId, headSha));
}

/**
 * Same head reviewed twice (D4): the bot already posted a review summary on `headSha`, and every
 * finding about to be posted repeats one it posted on that head. An empty list is never "all
 * duplicates" here (whether an empty review posts is the poster's own rule).
 */
export function sameHeadRepost(
  findings: readonly { file: string; title: string; evidence?: string; line?: number }[],
  prior: Pick<PriorFindingsResult, "findings" | "reviewedHeads">,
  headSha: string,
): boolean {
  if (!findings.length) return false;
  if (!prior.reviewedHeads.some((h) => sameSha(h, headSha))) return false;
  const onHead = priorOnHead(prior.findings, headSha);
  return findings.every((f) => isPriorDuplicate(f, onHead));
}
