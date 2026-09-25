// harbor.server.ts has exactly one writer of an existing job record, transitionJob, so terminal
// cleanup (snapshot release, local abort on cancellation) cannot be skipped by a path that writes
// the job array on its own (docs/local-verify-clean.md §3). The only other job-array writes are
// resetHarbor (drops every job) and inserting a new job with trimJobs.
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

test('every other job-array write is a reset or a new-job insert',()=>{
  // object-literal `jobs:` properties (a parameter such as `(jobs: Job[])` is not a write)
  const writes=[...harbor.matchAll(/(?:^\s*|[{,]\s*)jobs:\s*(.+)$/gm)].map(m=>m[1].trim());
  const allowed=[/^Job\[\];$/,/^\[\],/,/^state\.jobs,$/,/^state\.jobs\.map\(/,/^trimJobs\(\[(?:skipJob|job), \.\.\.state\.jobs\]\),/];
  assert.ok(writes.length>=5,'the write scan found the known sites');
  for(const w of writes)assert.ok(allowed.some(re=>re.test(w)),`unexpected job-array write: jobs: ${w}`);
});

test('terminal cleanup runs only from transitionJob, on the live → terminal edge',()=>{
  const calls=[...harbor.matchAll(/releaseTerminalJob\(/g)].length;
  assert.equal(calls,2,'one definition and one call');
  assert.match(fnBody('transitionJob'),/isLive\(before\.status\) && !isLive\(after\.status\)\) releaseTerminalJob\(after\)/);
});
