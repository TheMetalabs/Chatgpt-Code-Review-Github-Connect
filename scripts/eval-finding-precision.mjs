#!/usr/bin/env node
// Finding-precision eval (offline, deterministic): runs the production finding gate
// (src/lib/finding-gate.ts gateFindings, with the GateContext poster.findingGateContext builds) over a
// fixed set of labelled reviewer findings and reports what the gate keeps, demotes, notes and drops.
//
//   node --experimental-strip-types scripts/eval-finding-precision.mjs [fixture ...] [--json] [--quiet]
//   npm run eval:precision -- [fixture ...]
//
// Fixtures: a path argument, else ASHLAR_EVAL_FIXTURES (paths separated by the OS path delimiter), else
// the committed SYNTHETIC fixture tests/review/fixtures/finding-precision/synthetic.json. A fixture is
//   - a shared-snapshot file {pr, cases:[{id, label, pattern?, finding, reply?, priorFindings?}]} (the
//     synthetic shape, see tests/review/finding-precision-harness.mjs), or
//   - a case file / array of case files {id, ourLabel?, peerLabel?, peer18?, pattern?, finding,
//     context:{changedPaths, diff, headFiles:{path: text}, prBody?, assumptions?, investigatedSafe?,
//     coverage?, priorFindings?, sameReviewFindings?}}, or
//   - a directory holding index.json (an array of {id, file, ...labels}) or such case files.
// Labels are "valid", "false_positive" (synthetic "fp") or anything else (counted as unclear).
//
// Two runs per case: findingGate "off" (the baseline: what was posted before the gate) and the default
// Settings (types.ts DEFAULT_SETTINGS). A false positive is "removed" when the gate drops it or moves it
// to notes; a valid finding is "lost" the same way (a demotion to P2 keeps it posted).
//
// Diff shape (--diff-shape=live|git|both, default both): a fixture's diff is usually `git diff` output,
// but a live review sees the compact `--- path` + patch blocks github.server fetchPullSnapshot builds.
// "live" converts every case's diff to that shape (review-diff toSnapshotDiff) so the eval measures
// what production does; "git" keeps the fixture's diff as written; "both" reports each.
//
// Out-of-repo fixtures may hold private code: this script only reads them and prints to stdout. Never
// commit such a fixture or its output.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gateFindings} from '../src/lib/finding-gate.ts';
import {asFinding, findingGateContext} from '../src/lib/poster.ts';
import {toSnapshotDiff} from '../src/lib/review-diff.ts';
import {DEFAULT_SETTINGS} from '../src/lib/types.ts';
import {fixtureSnapshot} from '../tests/review/finding-precision-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE = path.join(ROOT, 'tests/review/fixtures/finding-precision/synthetic.json');
const TEXT_FIELDS = ['title', 'failureScenario', 'rootCause', 'evidence', 'recommendedFix', 'recommendedTest'];

const normLabel = (l) => (l === 'fp' || l === 'false_positive' ? 'false_positive' : l === 'valid' ? 'valid' : l == null ? null : 'unclear');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** A reviewer finding (snake_case or camelCase) as the poster's Finding. A text field the source could
 * not recover is filled with a marker (and listed in `filled`) so the case still reaches the gate. */
function toFinding(row) {
  const filled = [];
  const r = {...row};
  for (const k of TEXT_FIELDS) {
    const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!String(r[k] ?? r[snake] ?? '').trim()) {
      r[k] = '(not recovered)';
      delete r[snake];
      filled.push(k);
    }
  }
  return {finding: asFinding(r, 0), filled};
}

/** The snapshot a case-file fixture's review saw: changed files at head as `files`, every other head
 * file it carries as reference files (the gate verifies quotes against both). */
function caseSnapshot(c) {
  const ctx = c.context ?? {};
  const head = ctx.headFiles ?? {};
  const changed = new Set(ctx.changedPaths ?? []);
  const entries = Object.entries(head).filter(([, v]) => typeof v === 'string');
  return {
    key: `eval-${c.id}`, owner: 'eval', repo: 'eval', pr: Number(c.pr) || 1, title: String(c.prTitle ?? ''),
    body: String(ctx.prBody ?? ''), sender: 'author', headSha: String(c.reviewedCommit ?? ''), baseSha: String(c.baseCommit ?? ''),
    isFork: false, isDraft: false, labels: [],
    files: entries.filter(([p]) => changed.has(p)).map(([p, content]) => ({path: p, content, language: ''})),
    referenceFiles: entries.filter(([p]) => !changed.has(p)).map(([p, content]) => ({path: p, content, language: ''})),
    changedPaths: [...changed],
    diff: String(ctx.diff ?? ''),
  };
}

/** Prior findings the review could have seen: posted before it, never the review's own findings
 * (a builder that lists every comment up to the review's timestamp also lists its siblings). */
function priorBefore(c) {
  const ctx = c.context ?? {};
  const own = new Set([c.id, ...(ctx.sameReviewFindings ?? []).map((s) => s?.id)].filter(Boolean).map(String));
  const at = Date.parse(c.createdAt ?? '');
  return (ctx.priorFindings ?? [])
    .filter((p) => p && !own.has(String(p.id ?? '')) && !(Number.isFinite(at) && Date.parse(p.createdAt ?? '') >= at))
    .map((p) => ({file: String(p.file ?? ''), title: String(p.title ?? ''), evidence: p.evidence ? String(p.evidence) : undefined, commitId: p.commitId ? String(p.commitId) : undefined, line: Number(p.line) || undefined}));
}

function fromCaseFile(c, meta = {}) {
  const ctx = c.context ?? {};
  const {finding, filled} = toFinding(c.finding ?? {});
  return {
    id: String(c.id ?? meta.id),
    pr: c.pr ?? meta.pr ?? null,
    pattern: c.pattern ?? meta.pattern ?? '',
    ourLabel: normLabel(c.ourLabel ?? meta.ourLabel ?? c.label),
    peerLabel: normLabel(c.peerLabel ?? meta.peerLabel),
    peer18: Boolean(c.peer18 ?? meta.peer18),
    finding,
    filled,
    snapshot: caseSnapshot(c),
    submitted: {assumptions: ctx.assumptions ?? [], investigated_safe: ctx.investigatedSafe ?? [], coverage: ctx.coverage ?? []},
    priorFindings: priorBefore(c),
  };
}

function fromSynthetic(fx) {
  const snapshot = fixtureSnapshot(fx.pr, {diffShape: 'git'}); // as written; evaluate() applies the diff shape
  return fx.cases.map((c) => {
    const {finding, filled} = toFinding(c.finding ?? {});
    const reply = c.reply ?? {};
    return {
      id: c.id, pr: null, pattern: c.pattern ?? '', ourLabel: normLabel(c.label), peerLabel: normLabel(c.peerLabel), peer18: Boolean(c.peer18),
      finding, filled, snapshot,
      submitted: {assumptions: reply.assumptions ?? [], investigated_safe: reply.investigated_safe ?? [], coverage: reply.coverage ?? []},
      priorFindings: c.priorFindings ?? [],
      expect: c.expect, gap: c.gap,
    };
  });
}

/** Load one fixture path (file or directory) into eval cases. */
export function loadFixture(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const index = path.join(p, 'index.json');
    if (fs.existsSync(index)) {
      return readJson(index).map((row) => fromCaseFile(readJson(path.resolve(p, row.file ?? `cases/${row.id}.json`)), row));
    }
    const dirs = [p, path.join(p, 'cases')].filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
    return dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().flatMap((f) => loadFixture(path.join(d, f))));
  }
  const data = readJson(p);
  if (data && data.pr && Array.isArray(data.cases)) return fromSynthetic(data);
  if (Array.isArray(data)) return data.flatMap((row) => (row.finding ? [fromCaseFile(row)] : row.file ? [fromCaseFile(readJson(path.resolve(path.dirname(p), row.file)), row)] : []));
  if (data && data.finding) return [fromCaseFile(data)];
  throw new Error(`${p}: not a finding-precision fixture`);
}

const removed = (a) => a === 'drop' || a === 'note';

export const DIFF_SHAPES = ['live', 'git'];

/** A case's snapshot with its diff in `shape`: "live" = the compact blocks a live snapshot carries
 * (fetchPullSnapshot), "git" = the fixture's diff as written. */
export function withDiffShape(snapshot, shape = 'live') {
  if (shape === 'git') return snapshot;
  if (shape !== 'live') throw new Error(`unknown diff shape: ${shape}`);
  return {...snapshot, diff: toSnapshotDiff(snapshot.diff)};
}

/** Run every case through the gate twice (off = baseline, then `settings`), with its diff in `diffShape`. */
export function evaluate(cases, settings = DEFAULT_SETTINGS, {diffShape = 'live'} = {}) {
  const opts = (s) => ({mode: s.findingGate ?? 'off', p1ClosedPath: s.findingP1ClosedPath !== false, notes: s.findingNotes !== false, dedupePrior: s.findingDedupePrior !== false});
  const shaped = new Map();
  return cases.map((c) => {
    if (!c.finding) return {...c, before: {action: 'invalid', reasons: ['finding has no file/line']}, after: {action: 'invalid', reasons: ['finding has no file/line']}};
    if (!shaped.has(c.snapshot)) shaped.set(c.snapshot, withDiffShape(c.snapshot, diffShape));
    const ctx = findingGateContext(shaped.get(c.snapshot), c.submitted, {priorFindings: c.priorFindings});
    const run = (s) => {
      const d = gateFindings([c.finding], ctx, opts(s)).decisions[0];
      return {action: d.action, reasons: d.reasons, severityBefore: d.severityBefore, severityAfter: d.severityAfter ?? d.finding.severity};
    };
    return {...c, diffShape, before: run({...settings, findingGate: 'off'}), after: run(settings)};
  });
}

/** Counts for one label set over one subset of results. */
export function tally(rows, label) {
  const t = {cases: rows.length, valid: 0, validKept: 0, validLost: 0, validDemoted: 0, fp: 0, fpKept: 0, fpRemoved: 0, fpDemoted: 0, fpKeptBefore: 0, unclear: 0, unlabelled: 0};
  for (const r of rows) {
    const l = r[label];
    if (l === 'valid') {
      t.valid += 1;
      if (removed(r.after.action)) t.validLost += 1;
      else t.validKept += 1;
      if (r.after.action === 'demote') t.validDemoted += 1;
    } else if (l === 'false_positive') {
      t.fp += 1;
      if (!removed(r.before.action)) t.fpKeptBefore += 1;
      if (removed(r.after.action)) t.fpRemoved += 1;
      else t.fpKept += 1;
      if (r.after.action === 'demote') t.fpDemoted += 1;
    } else if (l == null) t.unlabelled += 1;
    else t.unclear += 1;
  }
  t.fpRemovalRate = t.fp ? t.fpRemoved / t.fp : null;
  return t;
}

/** The report's summary rows: each label set over all cases and the peer18 subset (when present). */
export function summarize(results) {
  const subsets = [['all', results]];
  if (results.some((r) => r.peer18)) subsets.push(['peer18', results.filter((r) => r.peer18)]);
  const rows = [];
  for (const label of ['ourLabel', 'peerLabel']) {
    for (const [name, rs] of subsets) {
      const labelled = rs.filter((r) => r[label] != null);
      if (!labelled.length) continue;
      rows.push({label, subset: name, ...tally(labelled, label)});
    }
  }
  return rows;
}

const pct = (x) => (x == null ? '-' : `${(100 * x).toFixed(1)}%`);
const pad = (s, n) => String(s).padEnd(n);

const SHAPE_TEXT = {live: 'live (compact `--- path` blocks, as fetchPullSnapshot builds them)', git: 'git (the fixture diff as written)'};

export function formatReport(results, {cases = true} = {}) {
  const out = [];
  const sum = summarize(results);
  const shape = results[0]?.diffShape;
  out.push(`Finding-precision eval: finding gate off (baseline = what was posted) vs default Settings${shape ? ` — diff shape ${SHAPE_TEXT[shape] ?? shape}` : ''}`);
  out.push(`cases ${results.length}${results.some((r) => r.peer18) ? `, peer18 ${results.filter((r) => r.peer18).length}` : ''}`);
  out.push('');
  const head = ['label', 'subset', 'n', 'valid kept', 'valid lost', 'FP kept (before)', 'FP kept (after)', 'FP removed', 'FP removal', 'demoted P2 (valid/FP)', 'unclear'];
  const w = [10, 7, 4, 11, 11, 17, 16, 11, 11, 22, 7];
  out.push(head.map((h, i) => pad(h, w[i])).join(' '));
  for (const r of sum) {
    out.push([r.label, r.subset, r.cases, `${r.validKept}/${r.valid}`, `${r.validLost}/${r.valid}`, `${r.fpKeptBefore}/${r.fp}`, `${r.fpKept}/${r.fp}`, `${r.fpRemoved}/${r.fp}`, pct(r.fpRemovalRate), `${r.validDemoted}/${r.fpDemoted}`, r.unclear].map((v, i) => pad(v, w[i])).join(' '));
  }
  if (cases) {
    out.push('');
    out.push('per case: id | ourLabel/peerLabel | peer18 | before → after | reasons');
    for (const r of results) {
      const sev = r.after.severityAfter && r.after.severityAfter !== r.after.severityBefore ? ` ${r.after.severityBefore}→${r.after.severityAfter}` : r.after.severityBefore ? ` ${r.after.severityBefore}` : '';
      const reasons = r.after.reasons?.length ? r.after.reasons.join(' | ') : '-';
      const filled = r.filled?.length ? ` [filled: ${r.filled.join(',')}]` : '';
      out.push(`${r.id} | ${r.ourLabel ?? '-'}/${r.peerLabel ?? '-'} | ${r.peer18 ? 'peer18' : '-'} | ${r.before.action} → ${r.after.action}${sev} | ${reasons}${filled}`);
    }
  }
  return out.join('\n');
}

export function fixturePaths(argv = [], env = process.env) {
  const args = argv.filter((a) => !a.startsWith('--'));
  if (args.length) return args;
  if (env.ASHLAR_EVAL_FIXTURES) return env.ASHLAR_EVAL_FIXTURES.split(path.delimiter).filter(Boolean);
  return [DEFAULT_FIXTURE];
}

export function runEval(paths = [DEFAULT_FIXTURE], settings = DEFAULT_SETTINGS, {diffShape = 'live'} = {}) {
  const results = evaluate(paths.flatMap(loadFixture), settings, {diffShape});
  return {results, summary: summarize(results)};
}

/** The diff shapes a CLI run reports: --diff-shape=live|git|both (default both, live first). */
export function diffShapes(argv = []) {
  const arg = argv.find((a) => a.startsWith('--diff-shape='))?.slice('--diff-shape='.length) ?? 'both';
  if (arg === 'both') return [...DIFF_SHAPES];
  if (!DIFF_SHAPES.includes(arg)) throw new Error(`--diff-shape must be live, git or both (got ${arg})`);
  return [arg];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const runs = diffShapes(argv).map((diffShape) => ({diffShape, ...runEval(fixturePaths(argv), DEFAULT_SETTINGS, {diffShape})}));
  if (argv.includes('--json')) {
    const slim = (results) => results.map((r) => ({id: r.id, pr: r.pr, ourLabel: r.ourLabel, peerLabel: r.peerLabel, peer18: r.peer18, before: r.before, after: r.after, filled: r.filled}));
    console.log(JSON.stringify(runs.map(({diffShape, summary, results}) => ({diffShape, summary, results: slim(results)})), null, 2));
  } else {
    console.log(runs.map(({results}) => formatReport(results, {cases: !argv.includes('--quiet')})).join('\n\n'));
  }
}
