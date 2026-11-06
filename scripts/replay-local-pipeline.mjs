#!/usr/bin/env node
// Replay the local reviewer on a pull request with the REAL local model, and score what it would post.
// Run it from the live Ashlar checkout (it reads the same .data/ashlar-settings.json and .env, so the
// same model, URL and limits), never against GitHub: it only reads.
//
//   npm run replay:local -- --pr owner/repo#123 [--head <sha> --base <sha>] [--mode pipeline|loop|single|all]
//                           [--labels index.json] [--save-snapshot snap.json] [--out report.json]
//   npm run replay:local -- --snapshot snap.json [...]
//
// GITHUB_TOKEN (a token that can read the repository) is needed only with --pr. --labels takes the
// judged-finding list of the 2026-11 false-positive eval ([{pr, file, title, ourLabel|peerLabel}]): each
// posted finding is matched to a judged one by file and title, and the report counts valid and false.
// Modes: pipeline = the staged review (Settings local_review.pipeline on), loop = the grouped tool loop it
// replaced, single = one single-turn request then the refute/select stages, all = every mode in turn.
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
const { runLocalReviewPipeline, verifySingleTurn } = await import("../src/lib/local-pipeline.server.ts");
const { runLocalReviewLoop } = await import("../src/lib/local-review-loop.server.ts");
const { runLocalLlm } = await import("../src/lib/local-llm.server.ts");
const { buildLocalChatPrompt, LOCAL_CHARS_PER_TOKEN } = await import("../src/lib/chat-prompt.ts");

const settings = loadBotSettings();
if (!settings.localLlmBaseUrl?.trim() || !settings.localLlmModel?.trim()) fail("no local model configured (Settings local_llm, or ASHLAR_LOCAL_LLM_BASE_URL / ASHLAR_LOCAL_LLM_MODEL)");

let sample;
if (opt("snapshot")) {
  sample = JSON.parse(readFileSync(opt("snapshot"), "utf8"));
} else if (opt("pr")) {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(opt("pr"));
  if (!m) fail("--pr must look like owner/repo#123");
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("--pr needs GITHUB_TOKEN (read access to the repository)");
  const { fetchPullHead, fetchPullSnapshot } = await import("../src/lib/github.server.ts");
  const [, owner, repo, num] = m;
  const pull = await fetchPullHead(token, owner, repo, Number(num));
  sample = await fetchPullSnapshot(token, {
    owner, repo, pr: Number(num), title: pull.title, headSha: opt("head") ?? pull.headSha, baseSha: opt("base") ?? pull.baseSha,
    sender: "replay", isFork: pull.fork, isDraft: pull.draft,
  }, { diffMaxChars: settings.promptDiffMaxChars, skipVendored: settings.skipVendoredPaths !== false });
  if (opt("save-snapshot")) writeFileSync(opt("save-snapshot"), JSON.stringify(sample));
} else {
  fail("give --pr owner/repo#123 or --snapshot file.json");
}

const labels = opt("labels") ? JSON.parse(readFileSync(opt("labels"), "utf8")) : [];
const words = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const jaccard = (a, b) => {
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.max(1, new Set([...x, ...y]).size);
};
function label(f) {
  const rows = labels.filter((l) => Number(l.pr) === Number(sample.pr) && l.file === f.file);
  const best = rows.map((l) => ({ l, s: jaccard(l.title, f.title) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.4 ? (best.l.peerLabel ?? best.l.ourLabel ?? "unclear") : "unjudged";
}

const log = [];
const deps = { log: (line) => log.push(line) };
async function runMode(mode) {
  const t0 = performance.now();
  let out;
  if (mode === "pipeline") out = await runLocalReviewPipeline(sample, { ...settings, localReviewPipeline: true }, deps);
  else if (mode === "loop") out = await runLocalReviewLoop(sample, settings, deps);
  else {
    const prompt = buildLocalChatPrompt({
      sample, extra: "", untrustedBody: "", priorThreads: [], contextMaxChars: settings.promptContextMaxChars,
      contextPadLines: settings.contextPadLines, policyMaxChars: settings.promptPolicyMaxChars,
      localBudget: { maxChars: Math.floor(settings.localReviewSingleTurnMaxTokens * LOCAL_CHARS_PER_TOKEN), shrinkContext: true },
    });
    out = await runLocalLlm(prompt, settings);
    if (out.ok) {
      const verified = await verifySingleTurn(out.raw, sample, settings, deps);
      out = { ...out, raw: verified.raw, pipelineSummary: verified.summary };
    }
  }
  const seconds = Math.round((performance.now() - t0) / 1000);
  if (!out.ok) return { mode, ok: false, error: out.error, seconds };
  const review = JSON.parse(out.raw);
  const posted = (review.findings ?? []).map((f) => ({ severity: f.severity, file: f.file, line: f.line, title: f.title, label: label(f) }));
  const count = (k) => posted.filter((p) => p.label === k).length;
  return {
    mode, ok: true, seconds, summary: out.pipelineSummary ?? null, posted,
    score: { posted: posted.length, valid: count("valid"), false_positive: count("false_positive"), unclear: count("unclear"), unjudged: count("unjudged") },
    unreviewed: review.unreviewed_paths ?? [],
  };
}

const mode = opt("mode") ?? "pipeline";
const modes = mode === "all" ? ["pipeline", "loop", "single"] : [mode];
if (!modes.every((m) => ["pipeline", "loop", "single"].includes(m))) fail(`unknown --mode ${mode}`);
const results = [];
for (const m of modes) results.push(await runMode(m));
const report = { pr: `${sample.owner}/${sample.repo}#${sample.pr}`, head: sample.headSha, changedPaths: sample.changedPaths.length, model: settings.localLlmModel, results, log };
const text = JSON.stringify(report, null, 2);
if (opt("out")) writeFileSync(opt("out"), text);
console.log(text);
