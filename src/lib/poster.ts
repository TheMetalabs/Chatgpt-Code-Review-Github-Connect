import type { BotSettings, Finding, Job, MergeRec, PostedComment, PostedReview, ReviewProvider, SamplePr, Severity } from "./types.ts";
import { SAMPLE_PRS } from "./samples.ts";
import { inlineFindingComment, reviewSummaryBody } from "./review-format.ts";
import { commentableRightLines, resolveLineFromSnippet, rightSideLines, snapToCommentableLine, type RightLine } from "./review-diff.ts";

export const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

const HEDGE = /\b(might|could|consider|perhaps|maybe)\b/i;

export function isBotMention(text: string | undefined, settings: BotSettings): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  const tokens = [...settings.mention, `@${settings.username}`].filter(Boolean);
  return tokens.some((t) => mentionTokenHit(hay, t.toLowerCase()));
}

function mentionTokenHit(hay: string, token: string): boolean {
  if (!token) return false;
  let from = 0;
  while (from <= hay.length - token.length) {
    const i = hay.indexOf(token, from);
    if (i < 0) return false;
    const afterIdx = i + token.length;
    const after = afterIdx >= hay.length ? "" : hay[afterIdx];
    if (token.startsWith("/")) {
      const beforeOk = i === 0 || /\s/.test(hay[i - 1]);
      const afterOk = after === "" || /[\s.,:;!?]/.test(after);
      if (beforeOk && afterOk) return true;
    } else {
      const beforeOk = i === 0 || !/[a-z0-9_]/i.test(hay[i - 1]);
      const afterOk = after === "" || !/[a-z0-9_-]/i.test(after);
      if (beforeOk && afterOk) return true;
    }
    from = i + 1;
  }
  return false;
}

export function fileExistsOnHead(sample: SamplePr | undefined, file: string, line: number) {
  if (!sample) return false;
  const snap = sample.files.find((f) => f.path === file);
  if (!snap) return false;
  const lines = snap.content.split("\n");
  return Number.isFinite(line) && line >= 1 && line <= lines.length;
}

export function inChangedPaths(sample: SamplePr | undefined, file: string) {
  if (!sample) return false;
  return sample.changedPaths.includes(file);
}

function findingText(f: Finding) {
  return [f.title, f.failureScenario, f.rootCause, f.evidence, f.recommendedFix, f.recommendedTest].join(" ");
}

export function isHedge(f: Finding) {
  return HEDGE.test(findingText(f));
}

export function highestSeverity(findings: Finding[]): Severity | undefined {
  if (!findings.length) return undefined;
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0].severity;
}

export function mergeEvent(findings: Finding[], settings: BotSettings): MergeRec {
  const highest = highestSeverity(findings);
  if (!highest) return "COMMENT";
  return SEVERITY_RANK[highest] <= SEVERITY_RANK[settings.requestChangesMin] ? "REQUEST_CHANGES" : "COMMENT";
}

/**
 * Split findings into inline comments vs `unanchored` (surfaced in the review body).
 *
 * A finding on the PR's changed code is NEVER dropped — the model reviewed that code, so a found
 * issue must reach the review and let the fixing agent judge it (recall over precision, owner
 * policy 2026-09-18). It is shown inline only when high-confidence AND anchorable (not a hedge
 * under `precisionOverRecall`, its line maps to a commentable diff line, under the inline cap); a
 * hedge, an un-anchorable line (e.g. a line past the end of the file), or cap overflow is surfaced
 * in the review body (`unanchored`) instead of being discarded.
 *
 * Excluded (not surfaced): a finding whose file is NOT one the PR changed — a PR review only speaks
 * to the PR's own changed code, and surfacing an off-scope / hallucinated file would let noise block
 * convergence. Below-`publishMinSeverity` findings are excluded likewise.
 */
export function partitionFindings(
  findings: Finding[],
  settings: BotSettings,
  sample?: SamplePr,
): { inline: Finding[]; unanchored: Finding[] } {
  const accepted = findings.filter((f) => f.status === "accepted");
  const ranked = [...accepted].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const cap = Math.max(0, settings.maxInlineComments);
  const rightLines = sample?.diff ? rightSideLines(sample.diff) : new Map<string, RightLine[]>();
  const commentable = sample?.diff ? commentableRightLines(sample.diff) : new Map<string, Set<number>>();
  const inline: Finding[] = [];
  const unanchored: Finding[] = [];
  for (const f of ranked) {
    if (!inChangedPaths(sample, f.file)) continue;
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[settings.publishMinSeverity]) continue;
    // A hedge stays out of the inline comments but is still surfaced in the body — never dropped.
    const inlineWorthy = !(settings.precisionOverRecall && isHedge(f));
    const anchored = inlineWorthy && inline.length < cap ? anchorInline(f, sample, commentable, rightLines) : null;
    if (anchored) inline.push(anchored);
    else unanchored.push(f);
  }
  return { inline, unanchored };
}

/** The finding re-lined to a commentable diff line, or null if it cannot anchor an inline comment. */
// The verbatim code the model cites for a finding, stripped of a leading "file:line" locator and
// any surrounding quote/backtick pair, so it can be matched against the diff. The model's line
// number drifts (it counts against the assembled snapshot, not the file); its quoted code does not.
export function evidenceSnippet(evidence: string): string {
  let s = String(evidence || "").trim();
  if (!s) return "";
  s = s.replace(/^[\w./\\@-]+:\d+(?:-\d+)?\s*/, ""); // drop a leading "path:line" / "path:line-line"
  const q = s[0];
  if ((q === '"' || q === "'" || q === "`") && s.length > 1 && s[s.length - 1] === q) {
    s = s.slice(1, -1); // unwrap a surrounding quote pair
  }
  return s.trim();
}

function anchorInline(
  f: Finding,
  sample: SamplePr | undefined,
  commentable: Map<string, Set<number>>,
  rightLines: Map<string, RightLine[]>,
): Finding | null {
  if (!commentable.size) {
    // No diff available (sample/test path) — keep inline as-is when the line is in file bounds.
    return fileExistsOnHead(sample, f.file, f.line) ? f : null;
  }
  // Prefer the model's verbatim evidence over its line number: compute the line from the quoted
  // code. Only a single, specific, unambiguous match wins — otherwise fall back to the line number.
  const snippet = evidenceSnippet(f.evidence);
  if (snippet) {
    const resolved = resolveLineFromSnippet(f.file, snippet, rightLines);
    if (resolved != null) return resolved === f.line ? f : { ...f, line: resolved, side: "RIGHT" };
  }
  if (!fileExistsOnHead(sample, f.file, f.line)) return null;
  const snapped = snapToCommentableLine(f.file, f.line, commentable);
  if (snapped == null) return null;
  return snapped === f.line ? f : { ...f, line: snapped };
}

export function publishableFindings(findings: Finding[], settings: BotSettings, sample?: SamplePr): Finding[] {
  return partitionFindings(findings, settings, sample).inline;
}

export function partitionPublishable(
  job: Job,
  settings: BotSettings,
  sample?: SamplePr,
): { inline: Finding[]; unanchored: Finding[] } {
  return partitionFindings(job.findings, settings, sample ?? SAMPLE_PRS[job.sampleKey ?? ""]);
}

export function filterPublishable(job: Job, settings: BotSettings, sample?: SamplePr): Finding[] {
  return partitionPublishable(job, settings, sample).inline;
}

export function buildReview(job: Job, inline: Finding[], unanchored: Finding[], settings: BotSettings): PostedReview | null {
  const all = [...inline, ...unanchored];
  // An explicit request (an @-mention, or a `/review-loop` start — slash form or the driver's
  // continuation marker, neither of which is an @-mention) always gets a verdict: for the loop,
  // the clean review's `ashlar-findings total=0` IS the CONVERGED signal (design §3).
  const requested = isBotMention(job.thread?.userText, settings) || job.thread?.loop?.kind === "start";
  // A salvaged verbatim reply must always post, even with zero structured findings and no mention,
  // so an unparseable review is surfaced for the fixing agent instead of silently skipped.
  if (all.length === 0 && !requested && !job.rawReview) return null;

  // Verdict reflects every real finding, not just the ones that got an inline anchor —
  // an unanchored P1 must still make the review REQUEST_CHANGES, never "clean".
  const event = mergeEvent(all, settings);

  const comments: PostedComment[] = inline.map((f) => ({
    id: `c-${f.id}`,
    findingId: f.id,
    file: f.file,
    line: f.line,
    side: f.side,
    body: inlineFindingComment(f, { owner: job.owner, repo: job.repo, headSha: job.headSha }),
  }));

  const body = reviewSummaryBody(job, all, settings.username, unanchored);

  return {
    id: `rev-${job.id}`,
    jobId: job.id,
    owner: job.owner,
    repo: job.repo,
    pr: job.pr,
    headSha: job.headSha,
    event,
    body,
    comments,
    at: Date.now(),
  };
}

function asFinding(row: unknown, i: number): Finding | null {
  if (!row || typeof row !== "object") return null;
  const f = row as Record<string, unknown>;
  const title = String(f.title ?? "").trim();
  const failureScenario = String(f.failure_scenario ?? f.failureScenario ?? "").trim();
  const rootCause = String(f.root_cause ?? f.rootCause ?? "").trim();
  const evidence = String(f.evidence ?? "").trim();
  const recommendedFix = String(f.recommended_fix ?? f.recommendedFix ?? "").trim();
  const recommendedTest = String(f.recommended_test ?? f.recommendedTest ?? "").trim();
  const file = String(f.file ?? "").trim();
  const line = Number(f.line);
  if (!title || !failureScenario || !rootCause || !evidence || !recommendedFix || !recommendedTest || !file) {
    return null;
  }
  if (!Number.isFinite(line) || line < 1) return null;
  const severity: Severity = f.severity === "P0" || f.severity === "P1" || f.severity === "P2" ? f.severity : "P2";
  return {
    id: `live-${i}`,
    status: "accepted",
    severity,
    file: file.slice(0, 200),
    line,
    side: f.side === "LEFT" ? "LEFT" : "RIGHT",
    title: title.slice(0, 160),
    failureScenario: failureScenario.slice(0, 800),
    rootCause: rootCause.slice(0, 800),
    evidence: evidence.slice(0, 800),
    recommendedFix: recommendedFix.slice(0, 800),
    recommendedTest: recommendedTest.slice(0, 400),
  };
}

export type ModelCoverage = { file: string; status: "cleared" | "not_cleared"; reason: string };

export type LiveGateResult = {
  ok: true;
  findings: Finding[];
  mergeRecommendation: MergeRec;
  highestRisk: string;
  investigatedSafe: string[];
  assumptions: string[];
  coverage?: ModelCoverage[];
  dropped: string[];
  /** How many findings were dropped for their shape (a required field missing, no valid line):
   * the reviewer reported them, so a result that lost one is not the reviewer's full verdict. */
  malformed?: number;
  /** How many reported findings lie past the gate's row cap (GATED_FINDINGS_CAP) and were never
   * inspected: a result that set one aside unread is not the reviewer's full verdict either. */
  overflow?: number;
  // Verbatim reply preserved when it was not parseable review JSON and local repair was off.
  // Surfaced in the review body so the fixing agent can interpret it (never dropped).
  rawReview?: string;
};

/** Lenient parse of the optional `coverage` array. Never fails the review. */
function parseCoverage(raw: unknown): ModelCoverage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelCoverage[] = [];
  for (const row of raw.slice(0, 200)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const file = String(r.file ?? "").trim().slice(0, 200);
    if (!file) continue;
    out.push({ file, status: r.status === "cleared" ? "cleared" : "not_cleared", reason: String(r.reason ?? "").slice(0, 400) });
  }
  return out;
}

/** The most reported findings one reviewer leg's gate inspects; any past it are counted as overflow. */
export const GATED_FINDINGS_CAP = 8;

export function gateLiveSubmission(
  submitted: Record<string, unknown> | null,
  snapshot: SamplePr,
  settings: BotSettings,
): LiveGateResult | { ok: false; reason: string } {
  if (!submitted) return { ok: false, reason: "submit_findings missing or invalid JSON" };
  const raw = Array.isArray(submitted.findings) ? submitted.findings : [];
  const parsed: Finding[] = [];
  const dropped: string[] = [];
  let malformed = 0;
  const overflow = Math.max(0, raw.length - GATED_FINDINGS_CAP);
  raw.slice(0, GATED_FINDINGS_CAP).forEach((row, i) => {
    const f = asFinding(row, i);
    if (!f) {
      dropped.push(`finding ${i}: missing required fields`);
      malformed += 1;
      return;
    }
    parsed.push(f);
  });
  const { inline, unanchored } = partitionFindings(parsed, settings, snapshot);
  const findings = [...inline, ...unanchored];
  // A salvaged reply carries its verbatim text here (parse failed + local repair off). It is a
  // real review to surface, not an Instant-tier skip, so it bypasses the empty-findings guard.
  const rawReview = typeof submitted.raw_review === "string" ? submitted.raw_review.trim().slice(0, 60_000) : "";
  const rawEmpty = !Array.isArray(submitted.findings) || submitted.findings.length === 0;
  if (rawEmpty && !rawReview && snapshot.changedPaths.length) {
    const safe = Array.isArray(submitted.investigated_safe)
      ? (submitted.investigated_safe as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!safe.length) {
      return { ok: false, reason: "empty findings without investigated_safe — Instant-tier skip, not a review" };
    }
  }
  const keptIds = new Set(findings.map((f) => f.id));
  for (const f of parsed) {
    if (!keptIds.has(f.id)) dropped.push(`dropped ${f.file}:${f.line} (${f.title})`);
  }
  const claimed = submitted.merge_recommendation;
  if (claimed === "APPROVE" && findings.length > 0) {
    dropped.push("APPROVE coerced — remaining findings cannot approve");
  }
  return {
    ok: true,
    findings,
    mergeRecommendation: mergeEvent(findings, settings),
    highestRisk: String(submitted.highest_risk ?? "").slice(0, 240),
    investigatedSafe: Array.isArray(submitted.investigated_safe)
      ? (submitted.investigated_safe as unknown[]).map((x) => String(x).slice(0, 400)).slice(0, 12)
      : [],
    assumptions: Array.isArray(submitted.assumptions)
      ? (submitted.assumptions as unknown[]).map((x) => String(x).slice(0, 400)).slice(0, 12)
      : [],
    coverage: parseCoverage(submitted.coverage),
    dropped,
    malformed,
    overflow,
    rawReview: rawReview || undefined,
  };
}

function titleKey(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findingsAgree(a: Finding, b: Finding) {
  if (a.file !== b.file) return false;
  if (a.line === b.line) return true;
  const ta = titleKey(a.title);
  const tb = titleKey(b.title);
  return ta.length >= 8 && ta === tb;
}

export function partitionConsensus(left: LiveGateResult, right: LiveGateResult) {
  const part = partitionMany([
    { provider: "chatgpt", gate: left },
    { provider: "grok", gate: right },
  ]);
  return {
    agreed: part.agreed,
    chatgptOnly: part.unique.chatgpt ?? [],
    grokOnly: part.unique.grok ?? [],
  };
}

export type ProviderGate = { provider: ReviewProvider; gate: LiveGateResult };

export function partitionMany(rows: ProviderGate[]) {
  type Tagged = { provider: ReviewProvider; finding: Finding };
  const items: Tagged[] = rows.flatMap((r) => r.gate.findings.map((finding) => ({ provider: r.provider, finding })));
  const clusters: Tagged[][] = [];
  for (const item of items) {
    const cluster = clusters.find((c) => c.some((m) => findingsAgree(m.finding, item.finding)));
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  const agreed: Finding[] = [];
  const unique: Partial<Record<ReviewProvider, Finding[]>> = {};
  for (const c of clusters) {
    const providers = new Set(c.map((m) => m.provider));
    if (providers.size >= 2) {
      const best = c.reduce((a, b) =>
        SEVERITY_RANK[a.finding.severity] <= SEVERITY_RANK[b.finding.severity] ? a : b,
      );
      const evidence = [...new Set(c.map((m) => m.finding.evidence))].join("\n");
      agreed.push({ ...best.finding, id: `dual-${agreed.length}`, evidence });
    } else {
      const p = c[0].provider;
      unique[p] = [...(unique[p] ?? []), c[0].finding];
    }
  }
  return { agreed, unique };
}

export function disputedFromUnique(unique: Partial<Record<ReviewProvider, Finding[]>>) {
  const out: { source: ReviewProvider; finding: Finding }[] = [];
  for (const p of ["local", "chatgpt", "grok"] as ReviewProvider[]) {
    for (const finding of unique[p] ?? []) out.push({ source: p, finding });
  }
  return out;
}

export type PeerCheck = {
  keep: Finding[];
  drop: { file: string; line: number; title: string; reason: string }[];
};

function peerDropped(f: Finding, drop: PeerCheck["drop"]) {
  return drop.some(
    (d) => d.file === f.file && (d.line === f.line || (titleKey(d.title) && titleKey(d.title) === titleKey(f.title))),
  );
}

function peerKept(f: Finding, keep: Finding[]) {
  return keep.some((k) => findingsAgree(f, k));
}

export function applyFpStep(
  pending: { agreed: Finding[]; disputed: { source: ReviewProvider; finding: Finding }[] },
  checker: ReviewProvider,
  check: PeerCheck | null,
): { agreed: Finding[]; disputed: { source: ReviewProvider; finding: Finding }[]; dropped: string[] } {
  if (!check) {
    return { agreed: pending.agreed, disputed: pending.disputed, dropped: [`${checker} skipped false-positive check`] };
  }
  const agreed = [...pending.agreed];
  const disputed: { source: ReviewProvider; finding: Finding }[] = [];
  const dropped: string[] = [];
  for (const row of pending.disputed) {
    if (row.source === checker) {
      disputed.push(row);
      continue;
    }
    const keep = peerKept(row.finding, check.keep);
    const drop = peerDropped(row.finding, check.drop);
    if (drop && !keep) {
      dropped.push(`${checker} rejected ${row.source}: ${row.finding.file}:${row.finding.line} ${row.finding.title}`);
      continue;
    }
    if (keep) {
      agreed.push({ ...row.finding, id: `fp-${agreed.length}` });
      continue;
    }
    disputed.push(row);
  }
  return { agreed, disputed, dropped };
}

/** Finding ids key the loop's thread replies and published filter; a multi-provider merge keeps
 * each provider's own `live-<i>` ids, so a later duplicate gets a suffix (the first keeps its id). */
function withUniqueIds(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.map((f) => {
    let id = f.id;
    for (let n = 2; seen.has(id); n++) id = `${f.id}~${n}`;
    seen.add(id);
    return id === f.id ? f : { ...f, id };
  });
}

export function finalizeFp(
  pending: {
    agreed: Finding[];
    disputed: { source: ReviewProvider; finding: Finding }[];
    investigatedSafe?: string[];
    assumptions?: string[];
    dropped?: string[];
  },
  settings: BotSettings,
): LiveGateResult {
  const kept = withUniqueIds([...pending.agreed, ...pending.disputed.map((d) => d.finding)]);
  const ranked = [...kept].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return {
    ok: true,
    findings: kept,
    mergeRecommendation: mergeEvent(kept, settings),
    highestRisk: ranked[0]?.title ?? "",
    investigatedSafe: pending.investigatedSafe ?? [],
    assumptions: pending.assumptions ?? [],
    dropped: pending.dropped ?? [],
  };
}

export function applyPeerReview(
  pending: {
    agreed: Finding[];
    chatgptOnly: Finding[];
    grokOnly: Finding[];
    investigatedSafe?: string[];
    assumptions?: string[];
  },
  checks: { chatgpt: PeerCheck | null; grok: PeerCheck | null },
  settings: BotSettings,
): LiveGateResult {
  let state: {
    agreed: Finding[];
    disputed: { source: ReviewProvider; finding: Finding }[];
    dropped: string[];
  } = {
    agreed: pending.agreed,
    disputed: [
      ...pending.chatgptOnly.map((finding) => ({ source: "chatgpt" as const, finding })),
      ...pending.grokOnly.map((finding) => ({ source: "grok" as const, finding })),
    ],
    dropped: [],
  };
  const chatgpt = applyFpStep(state, "chatgpt", checks.chatgpt);
  state = { agreed: chatgpt.agreed, disputed: chatgpt.disputed, dropped: chatgpt.dropped };
  const grok = applyFpStep(state, "grok", checks.grok);
  return finalizeFp(
    {
      agreed: grok.agreed,
      disputed: grok.disputed,
      investigatedSafe: pending.investigatedSafe,
      assumptions: pending.assumptions,
      dropped: [...state.dropped, ...grok.dropped],
    },
    settings,
  );
}

export function gatePeerSubmission(
  submitted: Record<string, unknown> | null,
  snapshot: SamplePr,
  settings: BotSettings,
): { ok: true; check: PeerCheck } | { ok: false; reason: string } {
  if (!submitted) return { ok: false, reason: "cross-check JSON missing or invalid" };
  const keepRaw = Array.isArray(submitted.keep)
    ? submitted.keep
    : Array.isArray(submitted.findings)
      ? submitted.findings
      : [];
  const keepParsed: Finding[] = [];
  keepRaw.slice(0, 8).forEach((row, i) => {
    const f = asFinding(row, i);
    if (f) keepParsed.push(f);
  });
  const keepSplit = partitionFindings(keepParsed, settings, snapshot);
  const keep = [...keepSplit.inline, ...keepSplit.unanchored];
  const dropRaw = Array.isArray(submitted.drop) ? submitted.drop : [];
  const drop: PeerCheck["drop"] = [];
  for (const row of dropRaw.slice(0, 8)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const file = String(r.file ?? "").trim();
    const line = Number(r.line);
    const title = String(r.title ?? "").trim();
    if (!file || !title || !Number.isFinite(line)) continue;
    drop.push({ file: file.slice(0, 200), line, title: title.slice(0, 160), reason: String(r.reason ?? "").slice(0, 400) });
  }
  return { ok: true, check: { keep, drop } };
}

export const SCHEMA_MERGE_NOTE = "Schema-merged reviewer JSON";

export function schemaMergeProviderGates(
  rows: ProviderGate[],
  settings: BotSettings,
): LiveGateResult {
  if (!rows.length) {
    return {
      ok: true,
      findings: [],
      mergeRecommendation: "COMMENT",
      highestRisk: "",
      investigatedSafe: [],
      assumptions: [SCHEMA_MERGE_NOTE],
      dropped: ["no reviewer results"],
    };
  }
  if (rows.length === 1) {
    const g = rows[0].gate;
    return { ...g, assumptions: [...g.assumptions, SCHEMA_MERGE_NOTE].slice(0, 12) };
  }
  const part = partitionMany(rows);
  const unique = Object.values(part.unique).flat();
  return finalizeFp(
    {
      agreed: [...part.agreed, ...unique],
      disputed: [],
      investigatedSafe: [...new Set(rows.flatMap((r) => r.gate.investigatedSafe))].slice(0, 8),
      assumptions: [SCHEMA_MERGE_NOTE, ...rows.flatMap((r) => r.gate.assumptions)].filter(Boolean).slice(0, 12),
      dropped: rows.flatMap((r) => r.gate.dropped).slice(0, 8),
    },
    settings,
  );
}

export function consensusFromGates(gates: LiveGateResult[], settings: BotSettings): LiveGateResult {
  if (gates.length === 0) {
    return {
      ok: true,
      findings: [],
      mergeRecommendation: "COMMENT",
      highestRisk: "",
      investigatedSafe: [],
      assumptions: [],
      dropped: ["no reviewer results"],
    };
  }
  if (gates.length === 1) return gates[0];
  const part = partitionConsensus(gates[0], gates[1]);
  return applyPeerReview(
    {
      agreed: part.agreed,
      chatgptOnly: part.chatgptOnly,
      grokOnly: part.grokOnly,
      investigatedSafe: [...new Set([...gates[0].investigatedSafe, ...gates[1].investigatedSafe])].slice(0, 8),
      assumptions: [...gates[0].assumptions, ...gates[1].assumptions].slice(0, 8),
    },
    { chatgpt: null, grok: null },
    settings,
  );
}
