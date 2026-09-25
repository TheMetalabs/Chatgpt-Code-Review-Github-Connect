// harbor.server.ts has exactly one writer of an existing job record, transitionJob, so terminal
// cleanup (snapshot release, local abort on cancellation) cannot be skipped by a path that writes
// the job array on its own (docs/local-verify-clean.md §3). The only other job-array writes are
// insertJob (a new job) and removeJobs, the only way a job leaves state, which runs the same release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';

const harbor=source('src/lib/harbor.server.ts');
/** The body of a top-level function, from its signature to the closing brace at column 0. */
function fnBody(name){
  const start=harbor.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,`${name} not found`);
  return harbor.slice(start,harbor.indexOf('\n}\n',start)+2);
}

test('state.jobs.map( appears once, inside transitionJob',()=>{
  const all=[...harbor.matchAll(/state\.jobs\.map\(/g)];
  assert.equal(all.length,1,'a second job-array map is a second job writer');
  assert.match(fnBody('transitionJob'),/state\.jobs\.map\(/);
});

test('every other job-array write is a new-job insert, a removal or the emptied state after a reset',()=>{
  // object-literal `jobs:` properties (a parameter such as `(jobs: Job[])` is not a write)
  const writes=[...harbor.matchAll(/(?:^\s*|[{,]\s*)jobs:\s*(.+)$/gm)].map(m=>m[1].trim());
  const allowed=[/^Job\[\];$/,/^\[\],/,/^state\.jobs,$/,/^state\.jobs\.map\(/,/^\[job, \.\.\.state\.jobs\]\.sort\(/,/^state\.jobs\.filter\(\(j\) => !ids\.has\(j\.id\)\) };$/];
  assert.ok(writes.length>=6,'the write scan found the known sites');
  for(const w of writes)assert.ok(allowed.some(re=>re.test(w)),`unexpected job-array write: jobs: ${w}`);
  assert.match(fnBody('insertJob'),/\[job, \.\.\.state\.jobs\]\.sort\(/,'the insert is insertJob');
  assert.match(fnBody('removeJobs'),/state\.jobs\.filter\(/,'the removal is removeJobs');
  // a reset empties state only after every job left through removeJobs
  const reset=fnBody('resetHarbor');
  assert.ok(reset.indexOf('removeJobs(state.jobs)')>=0&&reset.indexOf('removeJobs(state.jobs)')<reset.indexOf('jobs: []'),'reset removes before emptying');
});

test('a job leaves state only through removeJobs: the capacity drop and the reset',()=>{
  const calls=[...harbor.matchAll(/removeJobs\(/g)].map(m=>m.index);
  assert.equal(calls.length,3,'one definition, the capacity drop and the reset');
  assert.match(fnBody('insertJob'),/removeJobs\(overCapacity\(state\.jobs\)\)/);
  assert.equal([...harbor.matchAll(/trimJobs\(/g)].length,0,'no second path drops jobs');
});

test('one release runs on the live → terminal edge and on removal',()=>{
  const calls=[...harbor.matchAll(/releaseJob\(/g)].length;
  assert.equal(calls,3,'one definition, the edge and the removal');
  assert.match(fnBody('transitionJob'),/isLive\(before\.status\) && !isLive\(after\.status\)\) releaseJob\(after, "terminal"\)/);
  assert.match(fnBody('removeJobs'),/for \(const job of drop\) releaseJob\(job, "removed"\)/);
});
