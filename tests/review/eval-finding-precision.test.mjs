// scripts/eval-finding-precision.mjs (npm run eval:precision): the fixed finding-precision regression eval.
// Runs on the committed SYNTHETIC fixture and asserts the thresholds the gate must hold; also pins the
// case-file fixture shape used for out-of-repo (private) datasets, with synthetic content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DEFAULT_FIXTURE, evaluate, fixturePaths, formatReport, loadFixture, runEval, summarize} from '../../scripts/eval-finding-precision.mjs';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('synthetic fixture: baseline posts every finding; default Settings remove >= 80% of false positives and lose no valid finding', () => {
  const {results, summary} = runEval([DEFAULT_FIXTURE]);
  const row = summary.find((r) => r.label === 'ourLabel' && r.subset === 'all');
  assert.ok(row, 'ourLabel/all row');
  assert.ok(row.fp >= 14 && row.valid >= 3, `fixture size: ${row.fp} FP, ${row.valid} valid`);
  assert.equal(row.fpKeptBefore, row.fp, 'findingGate=off (the baseline) posts every false positive');
  assert.ok(results.every((r) => r.before.action === 'keep'), 'off is the identity');
  assert.equal(row.validLost, 0, 'no valid finding is dropped or moved to notes');
  assert.equal(row.validDemoted, 0, 'no valid finding is demoted');
  assert.ok(row.fpRemovalRate >= 0.8, `FP removal ${row.fpRemoved}/${row.fp}`);
  console.log(formatReport(results, {cases: false}));
});

test('gate off in the evaluated settings: nothing is removed (the harness measures the gate, not itself)', () => {
  const {summary} = runEval([DEFAULT_FIXTURE], {...DEFAULT_SETTINGS, findingGate: 'off'});
  const row = summary.find((r) => r.label === 'ourLabel' && r.subset === 'all');
  assert.equal(row.fpRemoved, 0);
  assert.equal(row.validLost, 0);
});

function caseFile(id, extra = {}) {
  const code = 'export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n';
  return {
    id, pr: 7, reviewedCommit: 'feedface00', createdAt: '2026-01-02T00:00:00Z', ourLabel: 'false_positive', peerLabel: 'false_positive', peer18: true,
    finding: {
      severity: 'P1', file: 'src/total.ts', line: 2, title: 'Total ignores quantity',
      failureScenario: 'Two units of one item are charged once.', rootCause: 'The reducer adds price, never price * qty.',
      evidence: 'src/total.ts:2 `return items.reduce((s, i) => s + i.price, 0);`', recommendedFix: 'Multiply by qty.', recommendedTest: '',
    },
    context: {
      changedPaths: ['src/total.ts'],
      diff: 'diff --git a/src/total.ts b/src/total.ts\n--- a/src/total.ts\n+++ b/src/total.ts\n@@ -1,3 +1,3 @@\n export function total(items) {\n-  return 0;\n+  return items.reduce((s, i) => s + i.price, 0);\n }\n',
      headFiles: {'src/total.ts': code},
      prBody: '', assumptions: [], investigatedSafe: [], coverage: [],
      priorFindings: [], sameReviewFindings: [],
    },
    ...extra,
  };
}

test('case-file directory fixtures (index.json): labels, peer18 subset, unrecovered fields, and priors posted before the review only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-eval-'));
  try {
    fs.mkdirSync(path.join(dir, 'cases'));
    const sibling = {source: 'inline', id: 's1', commitId: 'feedface00', createdAt: '2026-01-02T00:00:00Z', file: 'src/total.ts', title: 'Total ignores quantity'};
    const a = caseFile('a', {context: {...caseFile('a').context, priorFindings: [sibling], sameReviewFindings: [{id: 's1'}]}});
    const older = {source: 'inline', id: 'o1', commitId: 'aaaaaaa000', createdAt: '2026-01-01T00:00:00Z', file: 'src/total.ts', title: 'Total ignores the quantity'};
    const b = caseFile('b', {ourLabel: 'valid', peerLabel: null, peer18: false, context: {...caseFile('b').context, priorFindings: [older]}});
    fs.writeFileSync(path.join(dir, 'cases/a.json'), JSON.stringify(a));
    fs.writeFileSync(path.join(dir, 'cases/b.json'), JSON.stringify(b));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([{id: 'a', file: 'cases/a.json'}, {id: 'b', file: 'cases/b.json'}]));
    const results = evaluate(loadFixture(dir));
    const [ra, rb] = results;
    assert.deepEqual(ra.filled, ['recommendedTest'], 'an unrecovered text field is filled and reported');
    assert.equal(ra.priorFindings.length, 0, "the review's own sibling finding is never a prior");
    assert.equal(ra.after.action, 'keep');
    assert.equal(rb.after.action, 'drop', 'a finding posted on an earlier head is a repeat');
    assert.equal(rb.after.reasons[0], 'already_reported');
    const summary = summarize(results);
    assert.deepEqual(summary.map((r) => `${r.label}/${r.subset}`), ['ourLabel/all', 'ourLabel/peer18', 'peerLabel/all', 'peerLabel/peer18']);
    const our = summary[0];
    assert.equal(our.validLost, 1);
    assert.equal(our.fpKept, 1);
    assert.match(formatReport(results), /^a \| false_positive\/false_positive \| peer18 \| keep → keep P1 \| - \[filled: recommendedTest\]$/m);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('fixture selection: path argument, then ASHLAR_EVAL_FIXTURES, then the synthetic default', () => {
  assert.deepEqual(fixturePaths(['x.json', '--quiet'], {ASHLAR_EVAL_FIXTURES: 'y'}), ['x.json']);
  assert.deepEqual(fixturePaths([], {ASHLAR_EVAL_FIXTURES: `y${path.delimiter}z`}), ['y', 'z']);
  assert.deepEqual(fixturePaths([], {}), [DEFAULT_FIXTURE]);
});

test('CLI prints the summary table and per-case lines', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts/eval-finding-precision.mjs')], {cwd: ROOT, encoding: 'utf8', env: {...process.env, ASHLAR_EVAL_FIXTURES: ''}});
  assert.match(out, /^label\s+subset\s+n\s+valid kept\s+valid lost/m);
  assert.match(out, /^ourLabel\s+all\s+\d+\s+\d+\/\d+/m);
  assert.match(out, /^valid-two-locations-one-unchanged \| valid\/- \| - \| keep → keep P1 \| -$/m);
});
