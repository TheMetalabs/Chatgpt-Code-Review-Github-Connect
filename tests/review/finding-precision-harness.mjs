// Finding-precision eval harness: turns a fixture PR + one reviewer finding into the outcome the
// production gate path gives it (poster.gateLiveSubmission → finding-gate.ts). Shared by the synthetic
// eval (finding-precision-eval.test.mjs) and any out-of-repo eval with the same fixture shape:
//   pr:   {headSha, baseSha, body, files: {path: [lines]}, referencePaths: [], newFiles: [], modifiedDiffs: [diff lines]}
//   case: {id, finding: <review JSON finding>, reply?: {investigated_safe, assumptions, coverage}, priorFindings?: [...]}
import {gateLiveSubmission} from '../../src/lib/poster.ts';
import {toSnapshotDiff} from '../../src/lib/review-diff.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';

/** Both shapes a snapshot's diff can have: "live" = the compact `--- path` + patch blocks github.server
 * fetchPullSnapshot builds (what production reviews see), "git" = `git diff` output. */
export const DIFF_SHAPES = ['live', 'git'];

/** The fixture's PR as the snapshot the gate sees: changed files + reference files at head, the diff
 * (in `diffShape`; the fixture writes it as git output). */
export function fixtureSnapshot(pr, {diffShape = 'live'} = {}) {
  const text = (path) => pr.files[path].join('\n') + '\n';
  const refs = new Set(pr.referencePaths ?? []);
  const modifiedDiffs = pr.modifiedDiffs ?? [];
  const modified = [...new Set(modifiedDiffs.filter((l) => l.startsWith('diff --git ')).map((l) => l.split(' b/')[1]))];
  const newFiles = pr.newFiles ?? [];
  const newDiffs = newFiles.flatMap((path) => [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${pr.files[path].length} @@`,
    ...pr.files[path].map((l) => `+${l}`),
  ]);
  return {
    key: 'precision-fixture', owner: 'fixture', repo: 'fixture', pr: 1, title: 'Precision fixture',
    body: pr.body ?? '', sender: 'author', headSha: pr.headSha, baseSha: pr.baseSha, isFork: false, isDraft: false, labels: [],
    files: Object.keys(pr.files).filter((p) => !refs.has(p)).map((path) => ({path, content: text(path), language: path.endsWith('.md') ? 'md' : 'ts'})),
    referenceFiles: [...refs].map((path) => ({path, content: text(path), language: 'ts'})),
    changedPaths: [...newFiles, ...modified],
    diff: diffShape === 'git' ? [...newDiffs, ...modifiedDiffs].join('\n') + '\n' : toSnapshotDiff([...newDiffs, ...modifiedDiffs].join('\n')),
  };
}

/** One case through the production gate: {action: keep|demote|note|drop|excluded|rejected, reason?, severity?}. */
export function gateOutcome(c, snapshot, settings = DEFAULT_SETTINGS) {
  const reply = c.reply ?? {};
  const gate = gateLiveSubmission(
    {
      merge_recommendation: 'REQUEST_CHANGES',
      findings: [c.finding],
      investigated_safe: reply.investigated_safe ?? [],
      assumptions: reply.assumptions ?? [],
      coverage: reply.coverage ?? [],
    },
    snapshot,
    settings,
    {priorFindings: c.priorFindings},
  );
  if (!gate.ok) return {action: 'rejected', reason: gate.reason};
  const kept = gate.findings[0];
  if (kept) return {action: kept.severity === c.finding.severity ? 'keep' : 'demote', severity: kept.severity, mergeRecommendation: gate.mergeRecommendation};
  const note = gate.notes?.[0];
  if (note) return {action: 'note', reason: note.dropReason, mergeRecommendation: gate.mergeRecommendation};
  const dropped = gate.dropped.find((d) => d.startsWith('gate:'));
  if (dropped) return {action: 'drop', reason: dropped.slice('gate:'.length).split(' ')[0], mergeRecommendation: gate.mergeRecommendation};
  return {action: 'excluded', reason: gate.dropped.join('; ')};
}

export const posted = (o) => o.action === 'keep' || o.action === 'demote';
