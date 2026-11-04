// Finding-precision regression eval (SYNTHETIC, public-safe): tests/review/fixtures/finding-precision/
// synthetic.json models the six false-positive classes seen in live reviews (speculation beyond the
// diff, intended design reported as a defect, claims the diff itself contradicts, imagined concurrency,
// style / policy nits posted as defects, re-posts across heads) plus valid findings that must survive,
// one of which quotes an unchanged file. Each case runs through the production gate path
// (poster.gateLiveSubmission → finding-gate.ts) on one shared synthetic PR snapshot.
//
// "before" is findingGate=off (the pre-gate contract: every finding on changed code posts); "after" is
// the default Settings. A case marked `gap` is a false positive the deterministic rules cannot judge
// (it needs the model refute pass); its expected outcome is asserted as-is so a later improvement shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {gateLiveSubmission} from '../../src/lib/poster.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';

const raw = fs.readFileSync(fileURLToPath(new URL('./fixtures/finding-precision/synthetic.json', import.meta.url)), 'utf8');
const fixture = JSON.parse(raw);

/** The fixture's PR as the snapshot the gate sees: changed files + reference files at head, the diff. */
export function syntheticSnapshot(pr = fixture.pr) {
  const text = (path) => pr.files[path].join('\n') + '\n';
  const refs = new Set(pr.referencePaths);
  const modified = [...new Set(pr.modifiedDiffs.filter((l) => l.startsWith('diff --git ')).map((l) => l.split(' b/')[1]))];
  const newDiffs = pr.newFiles.flatMap((path) => [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${pr.files[path].length} @@`,
    ...pr.files[path].map((l) => `+${l}`),
  ]);
  return {
    key: 'synthetic-precision', owner: 'synthetic', repo: 'synthetic', pr: 1, title: 'Synthetic precision fixture',
    body: pr.body, sender: 'author', headSha: pr.headSha, baseSha: pr.baseSha, isFork: false, isDraft: false, labels: [],
    files: Object.keys(pr.files).filter((p) => !refs.has(p)).map((path) => ({path, content: text(path), language: path.endsWith('.md') ? 'md' : 'ts'})),
    referenceFiles: [...refs].map((path) => ({path, content: text(path), language: 'ts'})),
    changedPaths: [...pr.newFiles, ...modified],
    diff: [...newDiffs, ...pr.modifiedDiffs].join('\n') + '\n',
  };
}

/** One case through the production gate: keep / demote / note / drop, with the reason and severity. */
export function runCase(c, settings = DEFAULT_SETTINGS, snapshot = syntheticSnapshot()) {
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
  assert.equal(gate.ok, true, `${c.id}: the gate rejected the reply`);
  const kept = gate.findings[0];
  if (kept) return {action: kept.severity === c.finding.severity ? 'keep' : 'demote', severity: kept.severity, mergeRecommendation: gate.mergeRecommendation};
  const note = gate.notes?.[0];
  if (note) return {action: 'note', reason: note.dropReason, mergeRecommendation: gate.mergeRecommendation};
  const dropped = gate.dropped.find((d) => d.startsWith('gate:'));
  if (dropped) return {action: 'drop', reason: dropped.slice('gate:'.length).split(' ')[0], mergeRecommendation: gate.mergeRecommendation};
  return {action: 'excluded', reason: gate.dropped.join('; ')};
}

test('the fixture is synthetic: no case names a private repository', () => {
  assert.doesNotMatch(raw, /aicc/i);
  assert.ok(fixture.cases.length >= 14);
  const patterns = new Set(fixture.cases.map((c) => c.pattern));
  for (const p of ['speculation', 'design-intent', 'factual', 'concurrency', 'style-policy', 'stale-head', 'valid']) assert.ok(patterns.has(p), `covers ${p}`);
});

test('before (findingGate=off): every synthetic finding posts, false positives included', () => {
  const off = {...DEFAULT_SETTINGS, findingGate: 'off'};
  for (const c of fixture.cases) {
    const out = runCase(c, off);
    assert.equal(out.action, 'keep', `${c.id}: posted as reported without the gate`);
  }
});

for (const c of fixture.cases) {
  test(`after (default Settings): ${c.id} → ${c.expect.action}${c.expect.reason ? ` ${c.expect.reason}` : ''}${c.gap ? ' (known gap)' : ''}`, () => {
    const out = runCase(c);
    assert.equal(out.action, c.expect.action, `${c.id}: ${JSON.stringify(out)}`);
    if (c.expect.reason) assert.equal(out.reason, c.expect.reason, c.id);
    if (c.expect.severity) assert.equal(out.severity, c.expect.severity, c.id);
    if (out.action === 'note') assert.equal(out.mergeRecommendation, 'COMMENT', `${c.id}: a note never requests changes`);
  });
}

test('precision summary: valid findings all survive at their severity; only known gaps still post', () => {
  const rows = fixture.cases.map((c) => ({c, before: runCase(c, {...DEFAULT_SETTINGS, findingGate: 'off'}), after: runCase(c)}));
  const posted = (o) => o.action === 'keep' || o.action === 'demote';
  const fp = rows.filter((r) => r.c.label === 'fp');
  const valid = rows.filter((r) => r.c.label === 'valid');
  const fpBefore = fp.filter((r) => posted(r.before)).length;
  const fpAfter = fp.filter((r) => posted(r.after));
  const validKept = valid.filter((r) => r.after.action === 'keep' && r.after.severity === r.c.finding.severity).length;
  const by = (a) => fp.filter((r) => r.after.action === a).length;
  console.log(`finding-precision synthetic: false positives posted before ${fpBefore}/${fp.length}, after ${fpAfter.length}/${fp.length} (dropped ${by('drop')}, notes ${by('note')}, demoted-but-posted ${by('demote')}); valid kept at severity ${validKept}/${valid.length}; precision of posted findings before ${valid.length}/${valid.length + fpBefore}, after ${validKept}/${validKept + fpAfter.length}`);
  assert.equal(fpBefore, fp.length);
  assert.equal(validKept, valid.length, 'the gate never drops or demotes a valid synthetic finding');
  assert.deepEqual(fpAfter.map((r) => r.c.id).sort(), fp.filter((r) => r.c.gap).map((r) => r.c.id).sort(), 'only the documented gaps still post');
});
