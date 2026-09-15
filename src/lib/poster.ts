import type { BotSettings, Finding, Job, MergeRec, PostedComment, PostedReview, ReviewProvider, SamplePr, Severity } from "./types.ts";
import { SAMPLE_PRS } from "./samples.ts";
import { inlineFindingComment, reviewSummaryBody } from "./review-format.ts";

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

export function publishableFindings(
  findings: Finding[],
  settings: BotSettings,
  sample?: SamplePr,
): Finding[] {
  const accepted = findings.filter((f) => f.status === "accepted");
  const ranked = [...accepted].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const cap = Math.max(0, settings.maxInlineComments);
  const out: Finding[] = [];
  for (const f of ranked) {
    if (out.length >= cap) break;
    if (settings.precisionOverRecall && isHedge(f)) continue;
    if (!fileExistsOnHead(sample, f.file, f.line)) continue;
    if (!inChangedPaths(sample, f.file)) continue;
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[settings.publishMinSeverity]) continue;
    out.push(f);
  }
  return out;
}

export function filterPublishable(job: Job, settings: BotSettings, sample?: SamplePr): Finding[] {
  return publishableFindings(job.findings, settings, sample ?? SAMPLE_PRS[job.sampleKey ?? ""]);
}

export function buildReview(job: Job, findings: Finding[], settings: BotSettings): PostedReview | null {
  const mentioned = isBotMention(job.thread?.userText, settings);
  if (findings.length === 0 && !mentioned) return null;

  const event = mergeEvent(findings, settings);

  const comments: PostedComment[] = findings.map((f) => ({
    id: `c-${f.id}`,
    findingId: f.id,
    file: f.file,
    line: f.line,
    side: f.side,
    body: inlineFindingComment(f, { owner: job.owner, repo: job.repo, headSha: job.headSha }),
  }));

  const body = reviewSummaryBody(job, findings, settings.username);

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

export type LiveGateResult = {
  ok: true;
  findings: Finding[];
  mergeRecommendation: MergeRec;
  highestRisk: string;
  investigatedSafe: string[];
  assumptions: string[];
  dropped: string[];
};

export function gateLiveSubmission(
  submitted: Record<string, unknown> | null,
  snapshot: SamplePr,
  settings: BotSettings,
): LiveGateResult | { ok: false; reason: string } {
  if (!submitted) return { ok: false, reason: "submit_findings missing or invalid JSON" };
  const raw = Array.isArray(submitted.findings) ? submitted.findings : [];
  const parsed: Finding[] = [];
  const dropped: string[] = [];
  raw.slice(0, 8).forEach((row, i) => {
    const f = asFinding(row, i);
    if (!f) {
      dropped.push(`finding ${i}: missing required fields`);
      return;
    }
    parsed.push(f);
  });
  const findings = publishableFindings(parsed, settings, snapshot);
  for (const f of parsed) {
    if (!findings.includes(f)) dropped.push(`dropped ${f.file}:${f.line} (${f.title})`);
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
      ? (submitted.investigated_safe as unknown[]).map((x) => String(x).slice(0, 160)).slice(0, 8)
      : [],
    assumptions: Array.isArray(submitted.assumptions)
      ? (submitted.assumptions as unknown[]).map((x) => String(x).slice(0, 160)).slice(0, 8)
      : [],
    dropped,
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
  const kept = [...pending.agreed, ...pending.disputed.map((d) => d.finding)];
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
  const keep = publishableFindings(keepParsed, settings, snapshot);
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
