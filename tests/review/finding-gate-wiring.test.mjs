// The finding gate end to end through the production module graph (appFixture): a reviewer reply with a
// concrete finding, a speculative one and a style remark posts ONE finding (inline, counted, P1 →
// REQUEST_CHANGES), the style remark under "Notes (not findings)" (not counted, not inline), drops the
// speculative one, and the ops comment reports the gate's counts. With findingGate=off the same reply
// posts all three as findings (the pre-gate contract).
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, eventually} from './app-fixture.mjs';

const base = {side: 'RIGHT', file: 'a.ts', line: 1, evidence: 'a.ts:1 `export const answer = 42;`', recommended_fix: 'Keep 41 or update the table.', recommended_test: 'Checksum round-trip.'};
const reply = JSON.stringify({
  merge_recommendation: 'REQUEST_CHANGES',
  investigated_safe: ['a.ts: one constant changed'],
  findings: [
    {...base, severity: 'P1', title: 'Answer changed to 42 breaks the checksum table', failure_scenario: 'Clients that verify responses against the 41 checksum reject every response.', root_cause: 'The checksum table still expects 41.'},
    {...base, severity: 'P1', title: 'Importers of answer are not checked', failure_scenario: 'An importer that hard-codes 41 breaks.', root_cause: 'The importers are not in the snapshot, so whether they handle 42 is unverified.'},
    {...base, severity: 'P2', title: 'Rename answer to a descriptive name', failure_scenario: 'Readers cannot tell what answer is for.', root_cause: 'Naming: answer says nothing about its use.'},
  ],
});

async function review(options) {
  const app = await appFixture({reviewLocal: false, ...options});
  const out = await app.mention(`finding-gate-${options.findingGate}`);
  await eventually(() => app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  await app.harbor.submitHarborChat(out.jobId, reply, [{provider: 'chatgpt', raw: reply}], {force: true});
  await eventually(() => app.reviews.length === 1, 'review was not posted');
  await eventually(() => app.ops.some((o) => /Reviewed abc123/.test(o)), 'ops comment was not updated');
  return {app, review: app.reviews[0], job: app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId)};
}

test('findingGate=rules: one finding posts, the style remark is a note, the speculation is dropped, the ops comment counts them', async (t) => {
  const {app, review: r, job} = await review({findingGate: 'rules'});
  t.after(() => app.close());
  assert.equal(r.event, 'REQUEST_CHANGES');
  assert.equal(r.comments.length, 1);
  assert.match(r.comments[0].body, /Answer changed to 42 breaks the checksum table/);
  assert.match(r.body, /<!-- ashlar-findings total=1 inline=1 body=0 p0=0 p1=1 p2=0 -->/);
  assert.match(r.body, /<summary>Notes \(not findings\) — 1<\/summary>/);
  assert.match(r.body, /style · `a\.ts:1` — Rename answer to a descriptive name/);
  assert.doesNotMatch(r.body, /Importers of answer are not checked/);
  assert.equal(job.findings.length, 1);
  assert.equal(job.notes.length, 1);
  assert.ok(app.ops.some((o) => o.includes('Gate: kept 1, notes 1, dropped 1 (speculative 1)')), app.ops.at(-1));
});

test('findingGate=off: the same reply posts all three findings (pre-gate contract)', async (t) => {
  const {app, review: r} = await review({findingGate: 'off'});
  t.after(() => app.close());
  assert.match(r.body, /<!-- ashlar-findings total=3 /);
  assert.doesNotMatch(r.body, /Notes \(not findings\)/);
  assert.equal(app.ops.some((o) => o.includes('Gate: ')), false);
});
