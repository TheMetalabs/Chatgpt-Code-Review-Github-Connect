// WHY: the one-shot review prompt had no prior-round context, so a finding the fix agent already
// answered in-thread (pushback / decline / defer with file:line evidence) was re-raised every round
// (aicc #455, job-muicvggu-74: the same false CORS P1 until fix-declined). Codex reads its own
// thread replies natively; this block is the one-shot analog.

/** A review comment row as github.server listReviewComments returns it. */
export type ReviewCommentRow = {
  id?: number;
  inReplyToId?: number;
  line?: number;
  userLogin: string;
  userType?: string;
  path: string;
  createdAt?: string;
  body?: string;
};

/** One prior bot finding and the latest answer to it. */
export type PriorThread = { file: string; line?: number; title: string; replyBy: string; reply: string; at: string };

export const PRIOR_THREADS_MAX = 20;
export const PRIOR_THREADS_MAX_CHARS = 8_000;
export const PRIOR_REPLY_MAX_CHARS = 400;

/** The fix agent posts under the App's own login; threadReplyBody always carries this phrase. */
const FIX_AGENT_REPLY = /\bby the Ashlar fix agent\b/;

const sameLogin = (a: string, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const isBotAccount = (r: ReviewCommentRow) => r.userType === "Bot" || /\[bot\]$/i.test(r.userLogin);

/** inlineFindingComment renders `<badge>  **title**`; the badge is itself bold, so take the last bold run on line 1. */
function findingTitle(body: string): string {
  const first = String(body || "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const bold = [...first.matchAll(/\*\*([^*]+?)\*\*/g)].map((m) => m[1]).filter((t) => !/^<sub>/.test(t));
  return (bold.at(-1) ?? first).trim();
}

/**
 * Threads started by the Ashlar App whose latest qualifying reply comes from a human (non-bot) or
 * from the App's own fix agent. Newest answer first, capped at PRIOR_THREADS_MAX.
 */
export function selectPriorThreads(rows: readonly ReviewCommentRow[], botLogin: string): PriorThread[] {
  const roots = new Map<number, ReviewCommentRow>();
  for (const r of rows) {
    if (r.id && r.inReplyToId === undefined && sameLogin(r.userLogin, botLogin)) roots.set(r.id, r);
  }
  const latest = new Map<number, ReviewCommentRow>();
  for (const r of rows) {
    if (r.inReplyToId === undefined || !roots.has(r.inReplyToId)) continue;
    const self = sameLogin(r.userLogin, botLogin);
    const qualifies = self ? FIX_AGENT_REPLY.test(String(r.body ?? "")) : !isBotAccount(r);
    if (!qualifies) continue;
    const prev = latest.get(r.inReplyToId);
    if (!prev || String(r.createdAt ?? "") > String(prev.createdAt ?? "") ||
        (String(r.createdAt ?? "") === String(prev.createdAt ?? "") && (r.id ?? 0) > (prev.id ?? 0))) {
      latest.set(r.inReplyToId, r);
    }
  }
  return [...latest.entries()]
    .sort(([, a], [, b]) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || (b.id ?? 0) - (a.id ?? 0))
    .slice(0, PRIOR_THREADS_MAX)
    .map(([rootId, reply]) => {
      const root = roots.get(rootId)!;
      return {
        file: root.path,
        line: root.line,
        title: findingTitle(String(root.body ?? "")),
        replyBy: reply.userLogin,
        reply: String(reply.body ?? ""),
        at: String(reply.createdAt ?? ""),
      };
    });
}

/**
 * Untrusted text as render-stable plain text. ChatGPT renders a sent user turn as Markdown, and the
 * extension binds the turn by its text (composer.js reviewTurnHolds), so nothing here may be
 * transformed by that rendering: links keep their text and URL, `<`/`>` (HTML, autolinks, the
 * block markers) become ‹ ›, backslash escapes and entities are defused, emphasis and code markers
 * are dropped, and all whitespace collapses to one line so no content starts a Markdown block.
 */
function plain(text: string, max: number): string {
  const t = String(text ?? "")
    .replace(/!?\[([^\]\n]*)\]\(([^()\s]*)\)/g, "$1 ($2)")
    .replace(/</g, "‹").replace(/>/g, "›")
    .replace(/\\/g, "∖")
    .replace(/&(?=#?\w+;)/g, "& ")
    .replace(/[`]/g, "'")
    .replace(/[*~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * The thread lines, newest first, bounded by count and total chars (whole entries only). Each entry
 * starts with a fixed word, never a list, heading or quote marker (aicc #455: the Markdown list form
 * rendered as <li>, whose text drops the `- ` the sent prompt holds).
 */
export function formatPriorThreads(
  threads: readonly PriorThread[],
  opts: { maxThreads?: number; maxChars?: number; replyMax?: number } = {},
): string {
  const maxThreads = opts.maxThreads ?? PRIOR_THREADS_MAX;
  const maxChars = opts.maxChars ?? PRIOR_THREADS_MAX_CHARS;
  const replyMax = opts.replyMax ?? PRIOR_REPLY_MAX_CHARS;
  const out: string[] = [];
  let used = 0;
  for (const [i, t] of threads.slice(0, maxThreads).entries()) {
    const where = `${plain(t.file, 200)}${t.line ? `:${t.line}` : ""}`;
    const entry = `Thread ${i + 1} — ${where} — ${plain(t.title, 200)}\nReply by ${plain(t.replyBy, 60)}: ${plain(t.reply, replyMax)}`;
    if (used + entry.length + 1 > maxChars) break;
    out.push(entry);
    used += entry.length + 1;
  }
  return out.join("\n");
}
