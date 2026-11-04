/**
 * Finding gate — deterministic precision rules applied to a reviewer leg's findings BEFORE they are
 * partitioned for posting (poster.gateLiveSubmission). Pure: no I/O, type-only imports.
 *
 * CONTRACT
 * - gateFindings(findings, ctx, opts) never rewrites a finding's text. Each finding is kept, demoted
 *   (severity lowered, text unchanged), routed to notes (rendered under "Notes (not findings)" in the
 *   review body: not counted, never inline, never REQUEST_CHANGES), or dropped. Every decision records
 *   its reasons; the first reason is the primary one.
 * - mode "off" is the identity (everything kept, no notes); "rules" applies the deterministic rules.
 *   (A model refute pass is not part of this gate; the "refute" value an earlier build stored is read
 *   as "rules" — normalizeGateMode.)
 * - R2 self-retraction reads the claim only (title, failure scenario, root cause) plus a fix that is a
 *   no-op as a whole ("No change needed."); a verdict followed by a contrast ("X is safe. But Y") clears
 *   another path, not the finding.
 * - Rule order: dedupe → R2 self-retraction → R4 diff-contradicted → R5 own-reply contradiction →
 *   R1 speculation → R3 evidence verification → C1 notes routing → C2 P1 closed path. A note-category
 *   finding (C1) that fails R3 is routed to notes, not dropped: a note asserts no defect to prove.
 * - R1 speculation: an admitted-unverified premise drops ("I could not verify", "not in the snapshot");
 *   a bare "unverified" in the claim drops only without a verified quote on a changed line, unless the
 *   TITLE admits it ("the wiring is unverified"); a modal hedge in the TITLE (the headline claim is only
 *   a possibility) always drops, except "could" stating a security capability ("attackers could
 *   bypass …"); a hedge elsewhere in the claim drops only without a verified quote on a changed line.
 * - Rules are general (English + Korean phrasing) and never special-case repository names or texts.
 *
 * WHY: a finding only reached GitHub if every field was filled in. Findings that admit they rest on an
 * unverified premise, retract themselves, claim a changed file was not changed, are contradicted by the
 * same reply's own coverage notes, or quote code that is not in the head snapshot were posted as P1/P2;
 * style/docs/i18n/log/test-advice findings were posted as defects. This gate turns the reviewer's own
 * text and the head snapshot into keep/drop decisions.
 */
import type { Finding, Severity } from "./types.ts";

export type GateMode = "off" | "rules";
export const GATE_MODES: readonly GateMode[] = ["off", "rules"];

/** A stored gate mode as a GateMode: "refute" (an earlier build's toggle, which behaved exactly like
 * "rules") reads as "rules"; anything else unknown is `fallback`. */
export function normalizeGateMode(v: unknown, fallback: GateMode = "rules"): GateMode {
  if (v === "refute") return "rules";
  return GATE_MODES.includes(v as GateMode) ? (v as GateMode) : fallback;
}

/** One of the bot's earlier findings on this PR (another head, or an earlier review of this head). */
export interface PriorFinding {
  file: string;
  title: string;
  evidence?: string;
  /** The commit the finding was posted on. */
  commitId?: string;
  /** Posted line (informational; duplicate checks ignore line numbers). */
  line?: number;
}

export interface GateContext {
  /** path -> file content at the reviewed head (changed files + reference files + any extra fetched). */
  headFiles: Map<string, string>;
  changedPaths: string[];
  /** Unified diff base...head. */
  diff: string;
  prBody?: string;
  assumptions?: string[];
  investigatedSafe?: string[];
  coverage?: { path: string; reason: string; status?: "cleared" | "not_cleared" }[];
  /** The bot's earlier findings on this PR (other heads or earlier reviews). */
  priorFindings?: PriorFinding[];
  headSha?: string;
}

export interface GateOptions {
  mode: GateMode;
  /** C2: a P0/P1 keeps its severity only with a closed reproduction path. */
  p1ClosedPath: boolean;
  /** C1: route docs / i18n / style / log-wording / test-advice findings to notes. */
  notes: boolean;
  /** D: drop a finding the bot already reported on this PR. */
  dedupePrior: boolean;
}

export type GateAction = "keep" | "demote" | "note" | "drop";

export interface GateDecision {
  finding: Finding;
  action: GateAction;
  reasons: string[];
  severityBefore: Severity;
  severityAfter?: Severity;
}

export interface GateResult {
  kept: Finding[];
  notes: Finding[];
  dropped: { finding: Finding; reasons: string[] }[];
  decisions: GateDecision[];
}

/** Primary drop reasons, in rule order. */
export const GATE_DROP_REASONS = [
  "already_reported",
  "self_retracted",
  "contradicted_by_diff",
  "contradicted_by_own_reply",
  "speculative",
  "evidence_unverified",
  "evidence_unavailable",
] as const;
export type GateDropReason = (typeof GATE_DROP_REASONS)[number];

export const GATE_NOTE_CATEGORIES = ["docs", "i18n", "style", "log", "test"] as const;
export type GateNoteCategory = (typeof GATE_NOTE_CATEGORIES)[number];

export const P1_PATH_NOT_CLOSED = "p1_path_not_closed";

// ── text helpers ─────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** A claim field with its quoted code removed: a hedge or keyword inside a quote is code, not a claim. */
function stripQuoted(s: string): string {
  return String(s ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]{6,}"/g, " ")
    // Single-quoted code or state ('read could not be confirmed'): the opening quote is never an
    // apostrophe (no word character before it) and the closing one is not followed by a word character.
    .replace(/(?<![\w'])'[^'\n]{6,}'(?![\w])/g, " ");
}

function claimText(f: Finding): string {
  return stripQuoted([f.title, f.failureScenario, f.rootCause].join("\n"));
}

const basename = (p: string) => p.split("/").pop() ?? p;
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** `dir` is `file`'s directory or one of its ancestors ("" is the repository root). */
function isAncestorDir(dir: string, file: string): boolean {
  const d = dirname(file);
  return dir === "" || d === dir || d.startsWith(`${dir}/`);
}

const DOC_FILE = /\.(md|mdx|rst|adoc|txt)$/i;
const isDocPath = (p: string) => DOC_FILE.test(p) || /(^|\/)docs?\//i.test(p);

/** File-path-like tokens in free text (`a/b.ts`, `CLAUDE.md`, `a/b.ts:12`). */
function pathTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/(?:^|[\s([`'",;:|])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?::L?\d+(?:-L?\d+)?)?(?=$|[\s)\]`'",;:|.])/g)) {
    const p = m[1].replace(/^\.\//, "");
    if (/^\d+(\.\d+)+$/.test(p)) continue; // version numbers
    out.add(p);
  }
  return [...out];
}

/** Paths in `pool` the token names: exact, as a path suffix, or (bare file name) by basename. */
function resolvePath(token: string, pool: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of pool) {
    if (p === token || p.endsWith(`/${token}`)) out.push(p);
  }
  return out;
}

const STOP = new Set(
  "the a an of in on to for is are be been was were and or with when not no by at from this that it its as into via than then but if so does do did has have had can could may might will would should must per new old"
    .split(" "),
);

function stem(t: string): string {
  if (/^[a-z]+$/.test(t)) {
    if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
    if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  }
  return t;
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ── evidence quotes (R3) ──────────────────────────────────────────────────────────────────────────

/** Minimum length of a quote that verifies by substring; a full line of code verifies from 6 chars. */
const MIN_QUOTE = 12;
/** A quote must look like code (punctuation or spacing), or be long: a bare identifier is a mention. */
const CODE_SHAPE = /[\s(){}[\];:=<>,?!"'`+\-*/&|]/;

const LOCATOR = /(?:^|[\s([,;|])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5}):L?(\d+)(?:\s*[-–]\s*L?(\d+))?[:,)\]]?/g;

function cleanQuote(q: string): string {
  let s = norm(q);
  s = s.replace(/^(?:head\s+[0-9a-f]{6,40}\s+)/i, "");
  s = s.replace(/^[+-](?=\s)/, "").trim(); // a diff marker
  s = s.replace(/^L?\d+\s*[:|]\s+/, ""); // "12: code"
  const w = s[0];
  if ((w === '"' || w === "'" || w === "`") && s.length > 1 && s[s.length - 1] === w) s = s.slice(1, -1).trim();
  s = s.replace(/[;,.]+$/, "").trim();
  return s;
}

/** Code quotes a reviewer cites in its evidence: fenced blocks, `inline` spans, "quoted" spans, and the
 * text after a `path:line` locator; multi-quote evidence is split on `|`, `;` and newlines. Over-extraction
 * is harmless (a prose fragment never verifies against head code). */
export function extractEvidenceQuotes(evidence: string): string[] {
  const text = String(evidence ?? "");
  const out: string[] = [];
  // An elision (`…`, or `...` not starting a spread like `...rows`) splits a quote into the pieces the
  // reviewer actually copied; the whole quote is kept too.
  const push = (q: string) => {
    for (const part of [q, ...q.split(/\s*…\s*|\s*\.\.\.(?![\w$[{(])\s*/)]) {
      const c = cleanQuote(part);
      if (c.length >= 6) out.push(c);
    }
  };
  for (const m of text.matchAll(/```[^\n]*\n?([\s\S]*?)```/g)) for (const line of m[1].split("\n")) push(line);
  const unfenced = text.replace(/```[\s\S]*?```/g, " ");
  for (const m of unfenced.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of unfenced.matchAll(/"([^"\n]{8,})"/g)) push(m[1]);
  const plain = unfenced.replace(/`[^`\n]*`/g, " | ");
  for (const seg of plain.split(/\s+\|\s+|\n+|;\s+(?=(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5}:\d)/)) {
    const s = seg.trim();
    if (!s) continue;
    const locs = [...s.matchAll(LOCATOR)];
    if (!locs.length) {
      push(s);
      continue;
    }
    for (let i = 0; i < locs.length; i += 1) {
      const start = (locs[i].index ?? 0) + locs[i][0].length;
      const end = i + 1 < locs.length ? locs[i + 1].index ?? s.length : s.length;
      const tail = s.slice(start, end).trim();
      if (tail) push(tail);
    }
  }
  return [...new Set(out)];
}

/** Paths a finding's evidence cites by `path:line`. */
export function citedPaths(evidence: string): string[] {
  return [...new Set([...String(evidence ?? "").matchAll(LOCATOR)].map((m) => m[1]))];
}

/** Code as compared: whitespace collapsed, quote style unified, no spacing around punctuation, no
 * trailing `;`/`,` — so a quote that re-spaces `f( a,b )` or swaps '' for "" still matches its line. */
function loose(s: string): string {
  return norm(s)
    .replace(/['"`]/g, '"')
    .replace(/\s*([(){}[\],;:=<>+*/!?&|.-])\s*/g, "$1")
    .replace(/[;,]+$/, "");
}

type FileIndex = { path: string; lines: string[]; joined: string };
/** Hunk lines of the diff (`+`, `-` and context), loose-normalized; `files` = paths the diff touches. */
type DiffIndex = { changedAll: string[]; files: Set<string> };

export interface GateIndex {
  files: FileIndex[];
  diff: DiffIndex;
  changedPaths: Set<string>;
}

function parseDiff(diff: string): DiffIndex {
  const changedAll: string[] = [];
  const files = new Set<string>();
  let file = "";
  let inHunk = false;
  for (const raw of String(diff ?? "").split("\n")) {
    const head = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (head) {
      file = head[2].trim();
      files.add(file);
      inHunk = false;
      continue;
    }
    // File headers: `--- a/x` / `+++ b/x` (or /dev/null) end the previous file's hunks even in a diff
    // without `diff --git` lines.
    const plus = raw.match(/^\+\+\+ (?:(?:b\/)(.+)|(\/dev\/null))\s*$/) ?? (!inHunk ? raw.match(/^\+\+\+ (.+)$/) : null);
    if (plus) {
      const name = (plus[1] ?? "").trim();
      if (name && name !== "/dev/null") {
        file = name;
        files.add(file);
      }
      inHunk = false;
      continue;
    }
    if (/^--- (?:a\/|\/dev\/null)/.test(raw) || (raw.startsWith("--- ") && !inHunk)) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    const marker = raw[0];
    if (marker !== "+" && marker !== "-" && marker !== " ") continue;
    const content = loose(raw.slice(1));
    if (content) changedAll.push(content);
  }
  return { changedAll, files };
}

/** Build the lookup structures once per gate call (head content + diff). */
export function buildGateIndex(ctx: Pick<GateContext, "headFiles" | "diff" | "changedPaths">): GateIndex {
  const files: FileIndex[] = [];
  for (const [path, content] of ctx.headFiles) {
    if (!content) continue;
    const lines = String(content).split("\n").map(loose).filter(Boolean);
    files.push({ path, lines, joined: loose(String(content).split("\n").join(" ")) });
  }
  return { files, diff: parseDiff(ctx.diff), changedPaths: new Set(ctx.changedPaths) };
}

function quoteCheckable(q: string): boolean {
  return (q.length >= MIN_QUOTE && (CODE_SHAPE.test(q) || q.length >= 24)) || (q.length >= 6 && CODE_SHAPE.test(q) && /[A-Za-z_]/.test(q));
}

/** Where a quote occurs: in head content (any file) or the diff, and whether on a changed hunk line. */
function locateQuote(quote: string, idx: GateIndex): { verified: boolean; path?: string; changed: boolean } {
  if (!quoteCheckable(quote)) return { verified: false, changed: false };
  const q = loose(quote);
  const long = quote.length >= MIN_QUOTE && q.length >= MIN_QUOTE - 2;
  const lineHit = (line: string) => (long && line.includes(q)) || line === q;
  const coversLine = (line: string) => long && line.length >= MIN_QUOTE && q.includes(line);
  let path: string | undefined;
  for (const f of idx.files) {
    if (f.lines.some(lineHit) || (long && f.joined.includes(q))) {
      path = f.path;
      break;
    }
  }
  const inDiff = idx.diff.changedAll.some((l) => lineHit(l) || coversLine(l));
  if (!path && !inDiff) return { verified: false, changed: false };
  return { verified: true, path, changed: inDiff };
}

export interface EvidenceCheck {
  quotes: string[];
  verified: { quote: string; path?: string; changed: boolean }[];
  /** At least one verified quote sits on a changed hunk line (+, -, or context of a changed hunk). */
  onChanged: boolean;
  /** A cited path (or the finding's own file) has content in the head snapshot or the diff. */
  citedAvailable: boolean;
  /** Nothing to verify against at all (no head content, no diff). */
  noContent: boolean;
}

/** R3: verify a finding's quoted code against the head snapshot and the diff. `inline code` in the root
 * cause / failure scenario counts too: a model sometimes puts its quote there instead of in evidence. */
export function verifyEvidence(f: Finding, idx: GateIndex): EvidenceCheck {
  const quotes = [
    ...extractEvidenceQuotes(f.evidence),
    ...[f.rootCause, f.failureScenario].flatMap((t) => [...String(t ?? "").matchAll(/`([^`\n]+)`/g)].map((m) => cleanQuote(m[1]))),
  ].filter((q, i, a) => q.length >= 6 && a.indexOf(q) === i);
  const verified = quotes.map((quote) => ({ quote, ...locateQuote(quote, idx) })).filter((v) => v.verified).map(({ quote, path, changed }) => ({ quote, path, changed }));
  const cited = [...citedPaths(f.evidence), f.file].filter(Boolean);
  const available = [...idx.files.map((x) => x.path), ...idx.diff.files];
  const citedAvailable = cited.some((c) => resolvePath(c, available).length > 0);
  return {
    quotes,
    verified,
    onChanged: verified.some((v) => v.changed),
    citedAvailable,
    noContent: idx.files.length === 0 && idx.diff.changedAll.length === 0,
  };
}

// ── R1 speculation ────────────────────────────────────────────────────────────────────────────────

/** Nouns whose "unverified"/"not verified" describes the CODE (a real security claim), not the reviewer. */
const SECURITY_NOUN = "(?:signatures?|tokens?|jwts?|e-?mails?|addresses|address|users?|accounts?|inputs?|payloads?|requests?|certificates?|certs?|claims?|webhooks?|origins?|identit(?:y|ies)|sessions?|phones?|domains?|senders?|hmacs?|data|redirects?|urls?|uploads?|files?|callers?|otps?|codes?)";
const CODE_ACTOR = "(?:client|server|browser|caller|user|code|function|handler|service|app|application|system|library|verifier|middleware|module|endpoint|api|it)";
const KO_SECURITY = "(?:토큰|서명|이메일|사용자|입력|요청|인증서|출처|세션|파일|코드)";

// "an unverified read", "the unverified value": the adjective describes data the CODE handles without
// checking (a claim about the code), unlike the reviewer's own admission ("the wiring is unverified",
// "depends on the unverified helper"), which names what the reviewer did not read.
const REVIEW_OBJECT = "(?:helpers?|dependenc(?:y|ies)|functions?|methods?|modules?|services?|implementations?|callers?|callees?|wiring|code|files?|paths?|behaviou?rs?|contracts?|assumptions?|premises?|claims?|parts?|logic|controllers?|handlers?|definitions?|imports?)";
function attributiveOnCode(text: string, at: number, m: string): boolean {
  if (!/\b(?:an?|the|this|that|these|those|any|each|every|its|their)\s+$/i.test(text.slice(Math.max(0, at - 12), at))) return false;
  const next = /^\s+([A-Za-z][\w-]*)/.exec(text.slice(at + m.length, at + m.length + 40));
  return Boolean(next) && !new RegExp(`^${REVIEW_OBJECT}$`, "i").test(next![1]);
}

/** A security noun at most two words (none of them a review object) before `at`, optionally followed by
 * a copula: "payload accepted unverified", "email still unverified" — the code's data, not the reviewer. */
const securityNounBefore = (text: string, at: number) =>
  new RegExp(`${SECURITY_NOUN}\\s+(?:(?!${REVIEW_OBJECT}\\b)[\\w-]+\\s+){0,2}(?:is\\s+|are\\s+|remains?\\s+|stays?\\s+|was\\s+|were\\s+)?$`, "i").test(text.slice(Math.max(0, at - 50), at));

/** The headline itself admits the reviewer did not verify the subject: "the controller wiring is
 * unverified", "relies on the unverified helper". Such a finding is speculation whatever its quotes. */
function titleAdmitsUnverified(title: string): boolean {
  const t = stripQuoted(title);
  return new RegExp(`\\b${REVIEW_OBJECT}(?:\\s+[\\w-]+)?\\s+(?:is|are|remains?|stays?|was|were)\\s+(?:still\\s+|currently\\s+)?unverified\\b|\\bunverified\\s+${REVIEW_OBJECT}\\b`, "i").test(t) &&
    ![...t.matchAll(/\bunverified\b/gi)].every((m) => securityNounBefore(t, m.index ?? 0));
}

/** A security failure stated as a capability ("Attackers could bypass the role check"): "could" there
 * says what the defect allows, not that the defect is only possible. */
const SECURITY_CUE = /\b(?:attackers?|malicious|bypass\w*|unauthori[sz]ed|forg(?:e|es|ed|ing|ery)|spoof\w*|inject\w*|escalat\w*|impersonat\w*|exfiltrat\w*|hijack\w*|takeover|steal\w*|another (?:user|tenant|account)'?s?)\b|공격자|우회|권한\s*상승|위조|탈취/i;
const securityCapability = (text: string) => SECURITY_CUE.test(text);

const STRONG_HEDGES: { re: RegExp; label: string; guard?: (text: string, at: number, match: string) => boolean }[] = [
  // Reviewer voice only: "the validator didn't check the length" describes the code and is a real claim.
  {
    re: /\b(?:i|we)\s+(?:could not|couldn't|cannot|can't|can not|was unable to|were unable to|am unable to|are unable to|did not|didn't|do not|don't)\s+(?:verify|confirm|check|see|inspect|find|locate|determine|tell)\b/gi,
    label: "cannot verify",
  },
  {
    re: /\b(?:could not|couldn't|cannot|can't|can not|unable to)\s+(?:be\s+)?(?:verif(?:y|ied)|confirm(?:ed)?)\b/gi,
    label: "cannot verify",
    guard: (text, at) => new RegExp(`\\b${CODE_ACTOR}\\s+(?:\\w+\\s+){0,1}$`, "i").test(text.slice(Math.max(0, at - 30), at)),
  },
  { re: /\bnot\s+(?:shown|visible)\s+(?:here|in\s+(?:this|the)\s+(?:diff|snapshot|review|excerpt|context))\b/gi, label: "not visible here" },
  {
    re: /\bunverified\b/gi,
    label: "unverified",
    guard: (text, at, m) =>
      securityNounBefore(text, at) ||
      new RegExp(`^[\\s-]+${SECURITY_NOUN}\\b`, "i").test(text.slice(at + m.length, at + m.length + 30)) ||
      attributiveOnCode(text, at, m),
  },
  {
    re: /\bnot\s+(?:yet\s+)?(?:verified|confirmed)\b/gi,
    label: "not verified",
    guard: (text, at) => new RegExp(`${SECURITY_NOUN}\\s+(?:\\w+\\s+){0,2}(?:is|are|was|were)?\\s*$`, "i").test(text.slice(Math.max(0, at - 40), at)),
  },
  {
    re: /\bnot\s+(?:present|shown|included|visible|available|provided|attached|contained)\s+in\s+(?:the\s+|this\s+)?(?:snapshot|provided|reviewed|review group|attached|attachments?|context|excerpt|given)/gi,
    label: "not in the snapshot",
  },
  { re: /\bnot\s+in\s+(?:the\s+|this\s+)?(?:snapshot|reviewed group|review group|provided (?:files|code|context|snapshot))/gi, label: "not in the snapshot" },
  { re: /\b(?:outside|beyond)\s+(?:the\s+|this\s+)?(?:reviewed group|review group|snapshot|provided (?:files|code|context))/gi, label: "outside the reviewed group" },
  { re: /\bpresumably\b/gi, label: "presumably" },
  { re: /\b(?:i|we)\s+(?:assume|cannot tell|can't tell|don't see|do not see|couldn't find|could not find)\b/gi, label: "reviewer assumption" },
  { re: /\bwithout (?:seeing|access to|the source of)\b/gi, label: "without seeing" },
  { re: /미확인/g, label: "미확인" },
  {
    re: /확인되지\s*않/g,
    label: "확인되지 않",
    guard: (text, at) => new RegExp(`${KO_SECURITY}\\s*(?:이|가|은|는)?\\s*$`).test(text.slice(Math.max(0, at - 8), at)),
  },
  { re: /확인할\s*수\s*없/g, label: "확인할 수 없" },
  { re: /확인\s*불가/g, label: "확인 불가" },
  { re: /확인하지\s*못/g, label: "확인하지 못" },
  { re: /(?:스냅샷|리뷰\s*그룹|검토\s*그룹|제공된\s*(?:파일|코드))(?:에|에는)\s*(?:없|포함되지)/g, label: "스냅샷에 없음" },
];

const WEAK_HEDGES: { re: RegExp; label: string }[] = [
  { re: /\bmay\b/gi, label: "may" },
  { re: /\bmight\b/gi, label: "might" },
  { re: /\bcould\b(?!\s+not\b|n't)/gi, label: "could" },
  { re: /\b(?:possibly|potentially|perhaps|maybe|likely)\b/gi, label: "possibly" },
  { re: /\b(?:appears?|seems?)\s+to\b/gi, label: "appears to" },
  { re: /\bassum(?:es|ed|ing)\b/gi, label: "assumes" },
  {
    re: /\bif\s+(?:it|this|that|the\s+[\w.`'"()-]+|[\w.`'"()-]+)(?:\s+[\w.`'"()-]+){0,3}?\s+(?:does not|doesn't|did not|didn't|fails? to|never|is not|isn't|are not|aren't)\b/gi,
    label: "if X does not",
  },
  { re: /일\s*수\s*있/g, label: "일 수 있" },
  { re: /가능성이\s*있/g, label: "가능성이 있" },
  { re: /(?:할|될)\s*수도\s*있/g, label: "수도 있" },
  { re: /것으로\s*(?:보입|보임|보인다|추정)/g, label: "것으로 보임" },
  // Hedging forms only: "추정치" (an estimate) or "배송 추정 시간" names a value, not a guess.
  { re: /추정(?:됩니다|된다|되며|되어|됨)|(?:으)?로\s*추정(?:되|합니다|한다)/g, label: "추정" },
  // A whole word: "아마존" (Amazon) is not "아마" (probably).
  { re: /(?<!\p{L})아마(?:도)?(?!\p{L})/gu, label: "아마" },
];

/** A modal hedge (may / might / could / possibly / appears to, and the Korean equivalents). "assumes" and
 * "if X does not" are left out: in a headline they usually describe the code ("parser assumes UTF-8") or
 * the trigger of a real failure ("refund crashes if the invoice does not exist"). */
function modalHedge(text: string): string | undefined {
  for (const h of WEAK_HEDGES) {
    if (h.label === "assumes" || h.label === "if X does not") continue;
    if (h.label === "could" && securityCapability(text)) continue;
    h.re.lastIndex = 0;
    if (h.re.test(text)) return h.label;
  }
  return undefined;
}

/** `provenOnChanged`: the claim has a verified quote on a changed line. Then "unverified" (without the
 * reviewer saying they could not verify) is only a weak hedge: the quote already ties the claim to code
 * this PR changed (a concrete finding is never dropped for one word). */
function strongHedge(text: string, provenOnChanged = false): string | undefined {
  for (const h of STRONG_HEDGES) {
    if (provenOnChanged && h.label === "unverified") continue;
    for (const m of text.matchAll(h.re)) {
      if (h.guard?.(text, m.index ?? 0, m[0])) continue;
      return h.label;
    }
  }
  return undefined;
}

function weakHedge(text: string): string | undefined {
  for (const h of WEAK_HEDGES) {
    h.re.lastIndex = 0;
    if (h.re.test(text)) return h.label;
  }
  return undefined;
}

// ── R2 self-retraction ────────────────────────────────────────────────────────────────────────────

/** The finding's own conclusion that there is no defect. Each phrase is the reviewer's verdict, never a
 * description of the code ("the loop keeps re-reading the config", "the fraud check's false positives").
 * Only the claim (title, failure scenario, root cause) is read: "no code changes needed in callers" in
 * a fix or "정상 금액은 문제 없음" in a test plan describes the remedy, not the finding. */
const SAFE_WORD = "(?:safe|fine|correct|ok(?:ay)?|handled|guarded|covered|not an? (?:real )?(?:bug|issue|problem|defect)|no (?:bug|issue|problem|defect))";
/** A Korean subject that is the finding's own code path ("이 경로는", "해당 코드는"). */
const KO_THIS = "(?:이|해당|그)\\s*(?:경로|코드|부분|케이스|흐름|분기|호출|로직|구현|변경|동작)(?:는|은|도|에는)?\\s*";
/** A Korean conclusion marker: "…므로 / …때문에 / 따라서 / 결국" before the verdict. */
const KO_SO = "(?:므로|때문에|으니|니까|따라서|그러므로|결국|즉|결론적으로)";
const RETRACTION: { re: RegExp; contrastable: boolean }[] = [
  ...[
    /\bno (?:code )?changes? (?:is |are )?(?:needed|required|necessary)\b/i,
    /\bno (?:fix|action|change) (?:is )?(?:needed|required|necessary)\b/i,
    /\b(?:this|that) (?:path|code|case|flow|branch|usage|call|code path) is (?:actually |therefore |thus |already )?(?:safe|fine|correct|ok(?:ay)?)(?=\s*(?:[.;!)—–]|$|,?\s*(?:so|and so|therefore|thus|no)\b))/im,
    /\bso the (?:path|code|case|flow) is (?:actually )?(?:safe|fine|correct)\b/i,
    /\b(?:so|therefore|thus|hence)\b[^.\n]{0,40}\bnot (?:actually )?an? (?:real )?(?:bug|issue|problem|defect)\b/i,
    /(?:^|[.!?:]\s*)(?:this|it) is not (?:actually )?an? (?:real )?(?:bug|issue|problem|defect)\b/im,
    /\bno (?:bug|issue|problem|defect) here\b/i,
    /\b(?:this|it) (?:is|was|looks like) (?:a |likely a )?false positive\b/i,
    /\b(?:test|tests)\s*:\s*(?:n\/a|none(?: needed)?|not needed)\b/i,
    /\bfix\s*:\s*(?:n\/a|none|no change(?:s)?(?: needed)?)\b/i,
    // Korean verdicts, anchored to a conclusion about the finding itself: its own path as the subject
    // ("이 경로는 안전합니다"), a "…므로 / 따라서" conclusion, or the verdict as a whole sentence — never
    // "부분 환불은 안전하다" (another path, contrasted with the broken one).
    new RegExp(`${KO_THIS}(?:실제로\\s*|이미\\s*|충분히\\s*)?(?:안전(?:합니다|하다|함)|문제\\s*(?:가\\s*|는\\s*)?없(?:음|습니다|다|어요|네요))`),
    new RegExp(`${KO_SO}[^.。!?\\n]{0,30}?(?:안전(?:합니다|하다|함)|문제\\s*(?:가\\s*|는\\s*)?없(?:음|습니다|다|어요|네요))`),
    /(?:^|[.。!?]\s*|\n)\s*(?:실제로는?\s*)?문제\s*(?:가\s*|는\s*)?없(?:음|습니다|다|어요|네요)\s*(?:[.。!]|$)/m,
    /(?:수정|변경|조치)\s*(?:이\s*|은\s*)?불필요/,
    /(?:수정|변경|조치)할\s*필요(?:가|는)?\s*없/,
    /버그가\s*아(?:니다|닙니다|니며|니므로|님)/,
    /오탐(?:입니다|임|이다|으로\s*(?:보|판단))/,
  ].map((re) => ({ re, contrastable: true })),
  // A reversal mid-reasoning retracts whatever follows it.
  ...[
    /\bfalse alarm\b/i,
    /\bon second thought\b/i,
    new RegExp(`\\b(?:on |after |upon )?re-?reading (?:this|it|the (?:code|diff|guard|function|logic|line|lines|snippet|file|check|condition))\\b[^\\n]{0,120}?\\b${SAFE_WORD}`, "i"),
    /(?:^|[.!?]\s+)wait\s*[,—–-]/im,
  ].map((re) => ({ re, contrastable: false })),
];
/** The verdict is followed by a contrast ("X is safe. But Y …", "안전하다. 그러나 …"): it clears another
 * path, not the finding. */
const CONTRAST_AFTER = /^[^.!?。\n]*[.!?。]?\s*(?:however|but|yet|although|그러나|하지만|다만|반면|그런데)(?![A-Za-z])/i;
/** The verdict is about the rest of the code, not the finding ("the rest of this code is fine"). */
const OTHER_SUBJECT_BEFORE = /\b(?:rest of|remainder of|other (?:parts? of|code in)|everything else in)\s*$/i;

const NOOP_FIELD = /^(?:n\/?a|none|nothing|no changes?(?: needed| required)?|no fix(?: needed)?|not needed|none needed|-+|없음|불필요|해당 없음|(?:수정|변경|조치)\s*(?:이\s*|은\s*)?불필요(?:합니다|함)?|(?:수정|변경|조치)할\s*필요(?:가|는)?\s*없(?:음|습니다|다))\.?$/i;

function selfRetraction(f: Finding): string | undefined {
  const text = claimText(f);
  for (const { re, contrastable } of RETRACTION) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
      const at = m.index ?? 0;
      if (contrastable && (CONTRAST_AFTER.test(text.slice(at + m[0].length)) || OTHER_SUBJECT_BEFORE.test(text.slice(Math.max(0, at - 24), at)))) continue;
      return m[0].replace(/^[\s.!?:。]+/, "").trim();
    }
  }
  if (NOOP_FIELD.test(norm(f.recommendedFix))) return `fix: ${norm(f.recommendedFix)}`;
  return undefined;
}

// ── R4 diff-contradicted claims ───────────────────────────────────────────────────────────────────

/** "X was not updated / is not in this PR" — for any path. */
const NOT_CHANGED_ANY = [
  /\b(?:is|are|was|were|has|have)\s*(?:not|n't)\s+(?:been\s+)?(?:updated|modified|changed|touched|edited|included|part of (?:the|this) (?:pr|diff|change))\b/i,
  /\b(?:isn't|aren't|wasn't|weren't|hasn't|haven't)\s+(?:been\s+)?(?:updated|modified|changed|touched|edited|included)\b/i,
  /\bmissing from (?:the|this) (?:diff|pr|pull request|change(?:set)?)\b/i,
  /\bnot (?:in|part of) (?:the|this) (?:diff|pr|pull request|change(?:set)?)\b/i,
  /\b(?:pr|diff|pull request|change)\s+(?:does not|doesn't|did not|didn't)\s+(?:update|modify|change|touch|include|edit)\b/i,
  /\bno (?:corresponding )?(?:changes?|updates?|edits?|modifications?) (?:to|in|for) /i,
  /\bwithout (?:updating|modifying|changing)\b/i,
  /(?:\bpr\b|\bdiff\b|이\s*PR)[^。\n]{0,60}?(?:수정|변경|갱신|업데이트)(?:이|가|은|는)?\s*(?:없|되지\s*않)/i,
  /(?:수정|변경|갱신|업데이트|반영)(?:이|가)?\s*(?:되지\s*않|안\s*됨|안\s*되|누락)/,
];
/** "X needs to be updated" — only meaningful for a doc. */
const NEEDS_UPDATE_DOC = [
  /\b(?:should|must|needs? to)\s+(?:also\s+)?be\s+(?:updated|documented|mentioned)\b/i,
  /\bneeds? (?:an? )?update\b/i,
  /\bupdate (?:the )?(?:docs?|documentation|readme|claude\.md|agents\.md)\b/i,
  /(?:갱신|업데이트|수정|문서화)\s*(?:이|가)?\s*필요/,
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text says the file named `token` is not part of the PR at all (not "something in it"). */
function fileAbsentClaim(text: string, token: string): boolean {
  const p = escapeRe(token);
  return [
    new RegExp(`${p}\\W{0,3}\\s+(?:is|was|has)\\s*(?:not|n't)\\s+(?:been\\s+)?(?:in|part of|included in|modified in|changed in|touched (?:by|in)|updated (?:by|in))\\s+(?:the|this)\\s+(?:diff|pr|pull request)\\b`, "i"),
    new RegExp(`${p}\\W{0,3}\\s+(?:isn't|wasn't|hasn't been)\\s+(?:in|part of|included in|modified in|changed in|touched (?:by|in)|updated (?:by|in))\\s+(?:the|this)\\s+(?:diff|pr|pull request)\\b`, "i"),
    new RegExp(`${p}\\W{0,3}\\s+(?:is\\s+)?missing from (?:the|this) (?:diff|pr|pull request)\\b`, "i"),
    new RegExp(`\\b(?:diff|pr|pull request)\\s+(?:does not|doesn't|did not|didn't)\\s+(?:touch|include|modify|change|update)\\s+(?:the\\s+)?\`?${p}\\b`, "i"),
    new RegExp(`\\bno (?:changes?|updates?|edits?|modifications?) (?:to|in) \`?${p}\`?\\s+(?:in|from) (?:the|this) (?:diff|pr|pull request)\\b`, "i"),
    new RegExp(`(?:\\bPR|\\bdiff)(?:에|에는)\\s*\`?${p}\`?\\s*(?:의\\s*)?(?:수정|변경)(?:이|가|은|는)?\\s*없`, "i"),
    new RegExp(`${p}\`?\\s*(?:이|가|은|는)?\\s*(?:PR|diff)에\\s*(?:포함되지|없)`, "i"),
  ].some((re) => re.test(text));
}

function diffContradiction(f: Finding, idx: GateIndex): string | undefined {
  const text = stripQuoted([f.title, f.failureScenario, f.rootCause].join("\n"));
  const notChanged = NOT_CHANGED_ANY.some((re) => re.test(text));
  const needsDoc = NEEDS_UPDATE_DOC.some((re) => re.test(text));
  if (!notChanged && !needsDoc) return undefined;
  const changed = [...idx.changedPaths];
  const mentioned = pathTokens([f.title, f.failureScenario, f.rootCause].join("\n"));
  const strongDiffWording = /\b(?:diff|pr|pull request)\b|이\s*PR/i.test(text);
  for (const token of mentioned) {
    const hits = token.includes("/")
      ? resolvePath(token, changed)
      : changed.filter((p) => basename(p) === token && (isAncestorDir(dirname(p), f.file) || p === f.file));
    for (const hit of hits) {
      // A doc: any "not updated" / "needs update" wording. Code: only a claim that the FILE itself is
      // absent from the PR ("X is not in the diff", "the PR does not touch X") — a stale call site
      // inside a changed code file is a real claim this rule never judges.
      if (isDocPath(hit) ? notChanged || needsDoc : fileAbsentClaim(text, token)) return hit;
    }
  }
  // The finding sits ON a changed doc and says that doc was not updated.
  if (isDocPath(f.file) && idx.changedPaths.has(f.file) && notChanged && strongDiffWording) return f.file;
  return undefined;
}

// ── R5 own-reply contradiction ────────────────────────────────────────────────────────────────────

const INTENT = /\b(?:by design|intended|intentional(?:ly)?|deliberate(?:ly)?|expected|as designed|documented|documents|documenting|retr(?:y|ies|ied)|idempotent|safe|guarded|handled)\b|의도|정상|문서화|설계|안전|재시도|멱등/i;

function refersTo(entry: { text: string; path?: string }, f: Finding): boolean {
  if (entry.path && entry.path === f.file) return true;
  if (entry.path && isDocPath(entry.path) && isAncestorDir(dirname(entry.path), f.file)) return true;
  if (entry.text.includes(f.file)) return true;
  const base = basename(f.file);
  if (base.length >= 6 && base.includes(".") && new RegExp(`(^|[^\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(entry.text)) return true;
  for (const token of pathTokens(entry.text)) {
    if (token.includes("/") && isDocPath(token) && isAncestorDir(dirname(token), f.file)) return true;
  }
  return false;
}

function ownReplyContradiction(f: Finding, ctx: GateContext): string | undefined {
  const entries: { text: string; path?: string; label: string }[] = [
    ...(ctx.coverage ?? []).filter((c) => c.status !== "not_cleared").map((c) => ({ text: String(c.reason ?? ""), path: c.path, label: `coverage ${c.path}` })),
    ...(ctx.investigatedSafe ?? []).map((s) => ({ text: String(s ?? ""), label: "investigated_safe" })),
  ];
  const title = tokens(f.title);
  if (title.size < 2) return undefined;
  for (const e of entries) {
    if (!e.text.trim() || !INTENT.test(e.text) || !refersTo(e, f)) continue;
    const words = tokens(e.text.replace(/(?:[\w@.-]+\/)+[\w@.-]+|[\w@-]+\.[A-Za-z]{1,6}\b/g, " "));
    let shared = 0;
    for (const t of title) if (words.has(t)) shared += 1;
    if (shared >= 2 && shared / title.size >= 0.5) return e.label;
  }
  return undefined;
}

// ── C1 notes routing ──────────────────────────────────────────────────────────────────────────────

/** A concrete runtime failure in the claim: such a finding is never routed to notes by wording alone. */
const DEFECT_CUE = /\b(?:crash(?:es)?|throws?|exception|TypeError|ReferenceError|leaks?|leaked|race|deadlock|double[- ]?(?:charge|capture|post|submit|count|send)|twice|bypass(?:es)?|unauthori[sz]ed|injection|xss|csrf|ssrf|vulnerab\w*|overflow|corrupt(?:s|ion)?|data loss|lost|collision|never (?:terminates?|resolves?|runs?|called|fires?|triggers?|sent|delivered)|hangs?|infinite|null pointer|undefined is not|wrong (?!name|naming|wording|words?|labels?|spelling|case|indentation|format)\w+|privilege|exposes?)\b|크래시|예외|누수|경쟁\s*상태|중복\s*(?:결제|처리|실행|발송)|우회|권한\s*상승|데이터\s*손실|무한/i;
const SENSITIVE = /\b(?:passwords?|passwd|secrets?|api[- ]?keys?|tokens?|credentials?|private keys?|pii|personal data|ssn|card numbers?)\b|개인정보|비밀번호|토큰|민감/i;

const CATEGORY_RULES: { category: GateNoteCategory; re: RegExp[] }[] = [
  {
    category: "docs",
    re: [
      /\b(?:claude|agents|readme|changelog|contributing)(?:\.md)?\b.{0,60}\b(?:update|document|mention|describe|missing|outdated|stale|not (?:documented|updated|mentioned))/i,
      /\b(?:update|document)\b.{0,30}\b(?:claude|agents|readme|changelog)(?:\.md)?\b/i,
      /\b(?:docs?|documentation|doc comment|jsdoc|docstring|code comment)s?\b.{0,40}\b(?:missing|outdated|stale|not updated|inaccurate|incorrect|wrong|should (?:be )?(?:updated|mention))/i,
      /\b(?:undocumented|not documented)\b/i,
      /문서(?:화)?(?:가|를|에|의)?\s*(?:누락|갱신|업데이트|반영|수정|부정확)/,
      /주석(?:이|을|과)?\s*(?:누락|갱신|부정확|틀|불일치)/,
    ],
  },
  {
    category: "i18n",
    re: [
      /\bhard-?coded\b.{0,30}\b(?:korean|english|japanese|chinese|strings?|text|messages?|copy|labels?|wording|language|e-?mail (?:subject|body|text|template|copy))\b/i,
      /\b(?:i18n|l10n|internationali[sz]|locali[sz]ation|locali[sz]ed)\b/i,
      /\buser-facing (?:text|strings?|copy|messages?|wording)\b/i,
      /\b(?:untranslated|not translated|translation (?:keys?|strings?|files?|missing))\b/i,
      /하드\s*코딩된?\s*(?:한국어|한글|영어|문구|텍스트|문자열|메시지|이메일)/,
      /다국어|국제화|번역/,
    ],
  },
  {
    category: "style",
    re: [
      /\b(?:naming|renam(?:e|ing)|variable name|misleading name|typo|spelling|code style|style nit|nit(?:pick)?|lint(?:er|ing)?|eslint|prettier|formatting|indentation|readability|magic number|prefer (?:const|let)|unused (?:imports?|variables?|parameters?)|redundant (?:guards?|checks?|conditions?|null checks?|casts?|awaits?|returns?)|duplicated? code)\b/i,
      /\bref\b.{0,40}\b(?:during|in) (?:the )?render\b/i,
      /\brender(?:-time| phase| time)\b.{0,30}\bref\b/i,
      /\bref\b.{0,10}\b(?:assigned|mutated|written|updated)\b.{0,20}\brender/i,
      /네이밍|변수명|가독성|코드\s*스타일|린트|중복된?\s*(?:가드|체크|검사|조건)|불필요한\s*(?:가드|체크|검사|조건)|렌더\s*(?:중|단계|시점)(?:에)?\s*ref/,
    ],
  },
  {
    category: "log",
    re: [
      /\blog(?:ging)? (?:messages?|wording|text|lines?|levels?|statements?|output)\b/i,
      /\b(?:logs?|logged|logging) (?:at|as) (?:the )?(?:info|debug|warn(?:ing)?|error|trace)\b/i,
      /\bmisleading (?:logs?|error messages?|messages?)\b/i,
      /\blog(?:s|ged)?\s+(?:reports?|says|shows|prints|emits|records|reads)\b/i,
      /\bconsole\.(?:log|warn|error|info|debug)\b.{0,40}\b(?:left|leftover|remove|debug)\b/i,
      /로그\s*(?:문구|메시지|레벨|수준|내용|표현)/,
    ],
  },
  {
    category: "test",
    re: [
      /\b(?:specs?|tests?|test suite|unit tests?)\b.{0,40}\b(?:does not|doesn't|do not|don't|never|fails? to)\s+(?:verify|cover|assert|check|exercise|test)\b/i,
      /\b(?:missing|no|lacks?|add(?:ing)?|insufficient|needs?)\s+(?:an?\s+)?(?:regression |unit |integration |e2e )?(?:tests?|test cases?|test coverage|assertions?)\b/i,
      /\btest coverage\b/i,
      /\bmock(?:s|ed|ing)?\b.{0,30}\b(?:depth|shallow|too deep|too broad)\b/i,
      /\buntested\b|\bnot (?:covered|tested) by (?:a |any )?tests?\b/i,
      /테스트(?:가|를|는|에서)?\s*(?:없|누락|부족|추가|보강|커버하지|검증하지)/,
      /커버리지/,
    ],
  },
];

// Same test-path shape as review-budget.ts (kept local: this module has type-only imports).
const isTestPath = (p: string) => /\.spec\.|\.test\.|__tests__|\/tests?\//.test(p);
const ADD_TEST_FIX = /\b(?:add|write|extend|cover)\b.{0,60}\b(?:tests?|test cases?|specs?|assertions?)\b|테스트(?:를|케이스를)?\s*(?:추가|작성|보강)/i;

function noteCategory(f: Finding): GateNoteCategory | undefined {
  const head = stripQuoted([f.title, f.rootCause].join("\n"));
  const defect = DEFECT_CUE.test(stripQuoted([f.title, f.failureScenario].join("\n")));
  if (isDocPath(f.file) && !/\.txt$/i.test(f.file)) return "docs";
  // A finding on a test file whose fix is more tests is coverage advice: a failure cue in its text
  // ("throws") describes the production path the test exercises, not a defect in the change.
  if (isTestPath(f.file) && ADD_TEST_FIX.test(f.recommendedFix) && !SENSITIVE.test(head)) return "test";
  for (const rule of CATEGORY_RULES) {
    if (!rule.re.some((re) => re.test(head))) continue;
    if (defect) continue;
    if ((rule.category === "log" || rule.category === "i18n") && SENSITIVE.test(head)) continue;
    return rule.category;
  }
  return undefined;
}

// ── D dedupe against the bot's earlier findings ───────────────────────────────────────────────────

/** The prior finding this one repeats: same file and a near-identical title (token Jaccard ≥ 0.6), the
 * same verified evidence quote (a substantial one), or — at the same posted line — any verified quote
 * shared with a title on the same subject (two or more shared title words). Every prior counts: one on an older head (re-posting a finding on
 * every push is noise) and one already posted on this head (a second review of the same head). */
function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

export function findPriorDuplicate(f: Finding, ctx: Pick<GateContext, "priorFindings">, verifiedQuotes: string[] = []): PriorFinding | undefined {
  const title = tokens(f.title);
  // The same quoted code (loose-normalized): equal or one containing the other, and the shorter a
  // substantial line — a short common line such as `return { ok: true };` never ties two findings.
  const same = (a: string, b: string) => Math.min(a.length, b.length) >= 24 && (a === b || a.includes(b) || b.includes(a));
  const mine = verifiedQuotes.filter((q) => q.length >= MIN_QUOTE).map(loose);
  for (const p of ctx.priorFindings ?? []) {
    if (!p || p.file !== f.file) continue;
    if (jaccard(title, tokens(p.title)) >= 0.6) return p;
    if (mine.length && p.evidence) {
      const theirs = extractEvidenceQuotes(p.evidence).filter((q) => q.length >= MIN_QUOTE).map(loose);
      if (mine.some((q) => theirs.some((t) => same(q, t)))) return p;
      // The same anchor and subject: posted on the same line of the same file, quoting the same code,
      // and the titles share at least two content words. A short line (`id: string;`) ties two
      // findings only together with the line it was posted on; a different claim about the same line
      // (few shared title words) is new.
      const contains = (a: string, b: string) => a === b || a.includes(b) || b.includes(a);
      if (p.line && p.line === f.line && sharedCount(title, tokens(p.title)) >= 2 && mine.some((q) => theirs.some((t) => contains(q, t)))) return p;
    }
  }
  return undefined;
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

export function gateFindings(findings: Finding[], ctx: GateContext, opts: GateOptions): GateResult {
  const decisions: GateDecision[] = [];
  if (opts.mode === "off") {
    for (const finding of findings) decisions.push({ finding, action: "keep", reasons: [], severityBefore: finding.severity });
    return { kept: [...findings], notes: [], dropped: [], decisions };
  }
  const idx = buildGateIndex(ctx);
  for (const finding of findings) decisions.push(decide(finding, ctx, opts, idx));
  return {
    kept: decisions.filter((d) => d.action === "keep" || d.action === "demote").map((d) => d.finding),
    notes: decisions.filter((d) => d.action === "note").map((d) => d.finding),
    dropped: decisions.filter((d) => d.action === "drop").map((d) => ({ finding: d.finding, reasons: d.reasons })),
    decisions,
  };
}

function decide(f: Finding, ctx: GateContext, opts: GateOptions, idx: GateIndex): GateDecision {
  const before = f.severity;
  const drop = (reason: GateDropReason, detail?: string): GateDecision => ({
    finding: f,
    action: "drop",
    reasons: detail ? [reason, `${reason}: ${detail}`] : [reason],
    severityBefore: before,
  });
  const ev = verifyEvidence(f, idx);

  if (opts.dedupePrior) {
    const prior = findPriorDuplicate(f, ctx, ev.verified.map((v) => v.quote));
    if (prior) {
      const where = prior.commitId ? (ctx.headSha && prior.commitId.slice(0, 7) === ctx.headSha.slice(0, 7) ? "this head" : prior.commitId.slice(0, 7)) : "an earlier review";
      return drop("already_reported", `${where}: ${prior.title.slice(0, 80)}`);
    }
  }
  const retraction = selfRetraction(f);
  if (retraction) return drop("self_retracted", retraction.slice(0, 80));
  const contradicted = diffContradiction(f, idx);
  if (contradicted) return drop("contradicted_by_diff", `${contradicted} is changed in this PR`);
  const ownReply = ownReplyContradiction(f, ctx);
  if (ownReply) return drop("contradicted_by_own_reply", ownReply);

  const claim = claimText(f);
  if (titleAdmitsUnverified(f.title)) return drop("speculative", "title: unverified");
  const strong = strongHedge(claim, ev.onChanged);
  if (strong) return drop("speculative", strong);
  // The headline itself is a possibility ("X may allow Y"): no quote can prove a claim that does not
  // assert a defect, so it is speculation whatever the evidence (precision control B).
  const titleHedge = modalHedge(stripQuoted(f.title));
  if (titleHedge) return drop("speculative", `title: ${titleHedge}`);
  const weak = weakHedge(claim);
  // A weak hedge ("may", "could", "if X does not") is speculation unless the claim is otherwise proven:
  // a verified quote on a changed line ties it to code this PR actually changed.
  if (weak && !ev.onChanged && !ev.noContent) return drop("speculative", weak);

  if (!ev.noContent && ev.verified.length === 0) {
    // A note-category remark (docs / i18n / style / log wording / test advice) needs no proof: it is
    // never counted, never inline, never REQUEST_CHANGES. R3 exists to stop an unproven DEFECT claim,
    // so such a remark becomes a note instead of a drop; noteCategory never matches a defect claim.
    const category = opts.notes ? noteCategory(f) : undefined;
    if (category) {
      const why = ev.quotes.length ? `${ev.quotes.length} quote(s), none found at head` : "no code quote";
      return { finding: f, action: "note", reasons: [`note:${category}`, `note_evidence_unverified: ${why}`], severityBefore: before };
    }
    return ev.citedAvailable
      ? drop("evidence_unverified", ev.quotes.length ? `${ev.quotes.length} quote(s), none found at head` : "no code quote")
      : drop("evidence_unavailable", "neither the cited file nor a quote can be checked");
  }
  const reasons: string[] = [];
  if (ev.noContent) reasons.push("evidence_unchecked: no head content or diff to verify against");

  if (opts.notes) {
    const category = noteCategory(f);
    if (category) return { finding: f, action: "note", reasons: [`note:${category}`, ...reasons], severityBefore: before };
  }

  if (opts.p1ClosedPath && RANK[f.severity] <= RANK.P1) {
    const head = stripQuoted([f.title, f.rootCause].join("\n"));
    // "could" in a security capability ("attackers could bypass …") is the defect, not a hedge.
    const headHedge = weakHedge(securityCapability(head) ? head.replace(/\bcould\b(?!\s+not\b|n't)/gi, "can") : head);
    const missing = [
      ev.onChanged ? "" : "no verified quote on a changed line",
      norm(f.failureScenario) ? "" : "no failure scenario",
      headHedge ? `hedged claim (${headHedge})` : "",
    ].filter(Boolean);
    if (missing.length) {
      return {
        finding: { ...f, severity: "P2" },
        action: "demote",
        reasons: [P1_PATH_NOT_CLOSED, `${P1_PATH_NOT_CLOSED}: ${missing.join("; ")}`, ...reasons],
        severityBefore: before,
        severityAfter: "P2",
      };
    }
  }
  return { finding: f, action: "keep", reasons, severityBefore: before };
}

// ── reporting ─────────────────────────────────────────────────────────────────────────────────────

/** Gate counts for the ops comment. `reasons` counts primary drop reasons and note categories. */
export interface GateStats {
  kept: number;
  notes: number;
  dropped: number;
  demoted: number;
  reasons: Record<string, number>;
}

export function summarizeGate(result: Pick<GateResult, "decisions">): GateStats {
  const stats: GateStats = { kept: 0, notes: 0, dropped: 0, demoted: 0, reasons: {} };
  for (const d of result.decisions) {
    if (d.action === "keep" || d.action === "demote") stats.kept += 1;
    if (d.action === "demote") stats.demoted += 1;
    if (d.action === "note") stats.notes += 1;
    if (d.action === "drop") stats.dropped += 1;
    const primary = d.reasons[0];
    if (primary && (d.action === "drop" || d.action === "note")) stats.reasons[primary] = (stats.reasons[primary] ?? 0) + 1;
  }
  return stats;
}

export function mergeGateStats(rows: (GateStats | undefined)[]): GateStats | undefined {
  const present = rows.filter((r): r is GateStats => Boolean(r));
  if (!present.length) return undefined;
  const out: GateStats = { kept: 0, notes: 0, dropped: 0, demoted: 0, reasons: {} };
  for (const r of present) {
    out.kept += r.kept;
    out.notes += r.notes;
    out.dropped += r.dropped;
    out.demoted += r.demoted;
    for (const [k, v] of Object.entries(r.reasons)) out.reasons[k] = (out.reasons[k] ?? 0) + v;
  }
  return out;
}

const REASON_LABEL: Record<string, string> = {
  already_reported: "already reported",
  self_retracted: "self-retracted",
  contradicted_by_diff: "contradicted by diff",
  contradicted_by_own_reply: "contradicted by own reply",
  speculative: "speculative",
  evidence_unverified: "unverified",
  evidence_unavailable: "evidence unavailable",
};

/** "Gate: kept N, notes M, dropped K (speculative a, unverified b, …); P1→P2 d" */
export function gateStatsLine(stats: GateStats): string {
  const drops = GATE_DROP_REASONS.filter((r) => stats.reasons[r]).map((r) => `${REASON_LABEL[r]} ${stats.reasons[r]}`);
  const demoted = stats.demoted ? `; ${stats.demoted} demoted to P2 (no closed path)` : "";
  return `Gate: kept ${stats.kept}, notes ${stats.notes}, dropped ${stats.dropped}${drops.length ? ` (${drops.join(", ")})` : ""}${demoted}`;
}
