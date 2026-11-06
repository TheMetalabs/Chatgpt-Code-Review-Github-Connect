#!/usr/bin/env node
// Replay the local reviewer on pull requests with the REAL local model, and score what it would post.
// Run it from the live Ashlar checkout (it reads the same .data/ashlar-settings.json and .env, so the
// same model, URL and limits), never against GitHub: it only reads.
//
//   npm run replay:local -- --pr owner/repo#123 [--head <sha> --base <sha>] [--mode pipeline|loop|all]
//                           [--labels index.json] [--expect expect.json] [--save-snapshot snap.json] [--out report.json]
//   npm run replay:local -- --snapshot snap.json [...]
//   npm run replay:local -- --cases cases.json [--mode ...] [--out report.json]
//
// GITHUB_TOKEN (a token that can read the repository) is needed for --pr and --cases.
// Precision: --labels takes the judged-finding list of the 2026-11 false-positive eval
//   ([{pr, file, title, ourLabel|peerLabel}]); each posted finding is matched to a judged one by file and title.
// Recall: --expect takes the defects a review of that head must catch ([{pr, file, keywords:[...]}]); one is
//   caught when a posted finding is on its file and names any of its keywords (title, scenario or cause).
// --cases runs several heads in one go: [{pr:"owner/repo#123", head:"<sha>", base?:"<sha>", expect?:[{file, keywords}]}],
//   with --labels applied to every case, and prints per-case results and totals.
// Modes: pipeline = the staged review (Settings local_review.pipeline on), loop = the grouped tool loop it
// replaced, all = both in turn.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`replay-local-pipeline: ${message}`);
  process.exit(2);
};

const { loadBotSettings } = await import("../src/lib/settings.server.ts");
const { runLocalReviewPipeline } = await import("../src/lib/local-pipeline.server.ts");
const { runLocalReviewLoop } = await import("../src/lib/local-review-loop.server.ts");

const settings = loadBotSettings();
if (!settings.localLlmBaseUrl?.trim() || !settings.localLlmModel?.trim()) fail("no local model configured (Settings local_llm, or ASHLAR_LOCAL_LLM_BASE_URL / ASHLAR_LOCAL_LLM_MODEL)");

async function snapshotOf(prRef, head, base) {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(prRef ?? "");
  if (!m) fail(`a PR must look like owner/repo#123 (got ${prRef})`);
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("--pr / --cases need GITHUB_TOKEN (read access to the repository)");
  const { fetchPullHead, fetchPullSnapshot } = await import("../src/lib/github.server.ts");
  const [, owner, repo, num] = m;
  const pull = await fetchPullHead(token, owner, repo, Number(num));
  return fetchPullSnapshot(token, {
    owner, repo, pr: Number(num), title: pull.title, headSha: head ?? pull.headSha, baseSha: base ?? pull.baseSha,
    sender: "replay", isFork: pull.fork, isDraft: pull.draft,
  }, { diffMaxChars: settings.promptDiffMaxChars, skipVendored: settings.skipVendoredPaths !== false });
}

const labels = opt("labels") ? JSON.parse(readFileSync(opt("labels"), "utf8")) : [];
const words = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const jaccard = (a, b) => {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.max(1, new Set([...x, ...y]).size);
};
function label(sample, f) {
  const rows = labels.filter((l) => Number(l.pr) === Number(sample.pr) && l.file === f.file);
  const best = rows.map((l) => ({ l, s: jaccard(l.title, f.title) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.4 ? (best.l.peerLabel ?? best.l.ourLabel ?? "unclear") : "unjudged";
}
/** Which expected defects a review caught: a posted finding on the same file naming one of its keywords. */
function caught(expect, findings) {
  return expect.map((e) => {
    const keys = (e.keywords ?? []).map((k) => String(k).toLowerCase());
    const hit = findings.find((f) => f.file === e.file && keys.some((k) => `${f.title} ${f.failure_scenario ?? ""} ${f.root_cause ?? ""}`.toLowerCase().includes(k)));
    return { file: e.file, keywords: e.keywords, caught: Boolean(hit), by: hit?.title ?? null };
  });
}

async function runMode(sample, mode, expect) {
  const log = [];
  const deps = { log: (line) => log.push(line) };
  const t0 = performance.now();
  const out = mode === "pipeline"
    ? await runLocalReviewPipeline(sample, { ...settings, localReviewPipeline: true }, deps)
    : await runLocalReviewLoop(sample, settings, deps);
  const seconds = Math.round((performance.now() - t0) / 1000);
  if (!out.ok) return { mode, ok: false, error: out.error, seconds, log };
  const review = JSON.parse(out.raw);
  const findings = review.findings ?? [];
  const posted = findings.map((f) => ({ severity: f.severity, file: f.file, line: f.line, title: f.title, label: label(sample, f) }));
  const count = (k) => posted.filter((p) => p.label === k).length;
  const recall = expect?.length ? caught(expect, findings) : undefined;
  return {
    mode, ok: true, seconds, summary: out.pipelineSummary ?? null, posted,
    score: {
      posted: posted.length, valid: count("valid"), false_positive: count("false_positive"), unclear: count("unclear"), unjudged: count("unjudged"),
      ...(recall ? { expected: recall.length, caught: recall.filter((r) => r.caught).length } : {}),
    },
    ...(recall ? { recall } : {}),
    unreviewed: review.unreviewed_paths ?? [],
    log,
  };
}

const mode = opt("mode") ?? "pipeline";
const modes = mode === "all" ? ["pipeline", "loop"] : [mode];
if (!modes.every((m) => ["pipeline", "loop"].includes(m))) fail(`unknown --mode ${mode}`);

let cases;
if (opt("cases")) {
  cases = JSON.parse(readFileSync(opt("cases"), "utf8"));
} else if (opt("snapshot")) {
  cases = [{ snapshot: opt("snapshot"), expect: opt("expect") ? JSON.parse(readFileSync(opt("expect"), "utf8")) : undefined }];
} else if (opt("pr")) {
  cases = [{ pr: opt("pr"), head: opt("head"), base: opt("base"), expect: opt("expect") ? JSON.parse(readFileSync(opt("expect"), "utf8")) : undefined }];
} else {
  fail("give --pr owner/repo#123, --snapshot file.json or --cases cases.json");
}

const report = { model: settings.localLlmModel, cases: [], totals: {} };
for (const c of cases) {
  const sample = c.snapshot ? JSON.parse(readFileSync(c.snapshot, "utf8")) : await snapshotOf(c.pr, c.head, c.base);
  if (opt("save-snapshot") && cases.length === 1) writeFileSync(opt("save-snapshot"), JSON.stringify(sample));
  const expect = (c.expect ?? []).filter((e) => !e.pr || Number(String(e.pr).replace(/.*#/, "")) === Number(sample.pr));
  const results = [];
  for (const m of modes) results.push(await runMode(sample, m, expect));
  report.cases.push({ pr: `${sample.owner}/${sample.repo}#${sample.pr}`, head: sample.headSha, changedPaths: sample.changedPaths.length, expected: expect.length, results });
}
for (const m of modes) {
  const rows = report.cases.map((c) => c.results.find((r) => r.mode === m)).filter((r) => r?.ok);
  const sum = (k) => rows.reduce((n, r) => n + (r.score[k] ?? 0), 0);
  report.totals[m] = {
    reviews: rows.length, failed: report.cases.length - rows.length, posted: sum("posted"), valid: sum("valid"), false_positive: sum("false_positive"),
    // Recall's denominator is every case's expected defects: a case whose review failed caught none of its own.
    expected: report.cases.reduce((n, c) => n + c.expected, 0), caught: sum("caught"),
    seconds: report.cases.reduce((n, c) => n + (c.results.find((r) => r.mode === m)?.seconds ?? 0), 0),
  };
}
const text = JSON.stringify(report, null, 2);
if (opt("out")) writeFileSync(opt("out"), text);
console.log(text);
