// Finding-precision regression eval (SYNTHETIC, public-safe): tests/review/fixtures/finding-precision/
// synthetic.json models the six false-positive classes seen in live reviews (speculation beyond the
// diff, intended design reported as a defect, claims the diff itself contradicts, imagined concurrency,
// style / policy nits posted as defects, re-posts across heads) plus valid findings that must survive,
// one of which quotes an unchanged file. Each case runs through the production gate path
// (poster.gateLiveSubmission → finding-gate.ts) on one shared synthetic PR snapshot
// (finding-precision-harness.mjs).
//
// "before" is findingGate=off (the pre-gate contract: every finding on changed code posts); "after" is
// the default Settings. A case marked `gap` is a false positive the deterministic rules cannot judge
// (it needs the model refute pass); its expected outcome is asserted as-is so a later improvement shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';
import {fixtureSnapshot, gateOutcome, posted} from './finding-precision-harness.mjs';

const raw = fs.readFileSync(fileURLToPath(new URL('./fixtures/finding-precision/synthetic.json', import.meta.url)), 'utf8');
const fixture = JSON.parse(raw);
const snapshot = fixtureSnapshot(fixture.pr);
const OFF = {...DEFAULT_SETTINGS, findingGate: 'off'};

test('the fixture is synthetic: no case names a private repository', () => {
  assert.doesNotMatch(raw, /aicc/i);
  assert.ok(fixture.cases.length >= 14);
  const patterns = new Set(fixture.cases.map((c) => c.pattern));
  for (const p of ['speculation', 'design-intent', 'factual', 'concurrency', 'style-policy', 'stale-head', 'valid']) assert.ok(patterns.has(p), `covers ${p}`);
});

test('before (findingGate=off): every synthetic finding posts, false positives included', () => {
  for (const c of fixture.cases) assert.equal(gateOutcome(c, snapshot, OFF).action, 'keep', `${c.id}: posted as reported without the gate`);
});

for (const c of fixture.cases) {
  test(`after (default Settings): ${c.id} → ${c.expect.action}${c.expect.reason ? ` ${c.expect.reason}` : ''}${c.gap ? ' (known gap)' : ''}`, () => {
    const out = gateOutcome(c, snapshot);
    assert.equal(out.action, c.expect.action, `${c.id}: ${JSON.stringify(out)}`);
    if (c.expect.reason) assert.equal(out.reason, c.expect.reason, c.id);
    if (c.expect.severity) assert.equal(out.severity, c.expect.severity, c.id);
    if (out.action === 'note') assert.equal(out.mergeRecommendation, 'COMMENT', `${c.id}: a note never requests changes`);
  });
}

test('precision summary: valid findings all survive at their severity; only known gaps still post', () => {
  const rows = fixture.cases.map((c) => ({c, before: gateOutcome(c, snapshot, OFF), after: gateOutcome(c, snapshot)}));
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
