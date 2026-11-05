// Settings skipVendoredPaths through the real webhook → harbor snapshot path (live WalkieBoard #523: a
// vendored upstream drop held the local model for an hour per round). The snapshot is the fixture's;
// what fetchPullSnapshot leaves out for .gitattributes is snapshot-docs.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,eventually} from './app-fixture.mjs';

const settle=()=>new Promise(resolve=>setTimeout(resolve,150));

test('a PR that changes only vendored paths starts no reviewer and says why',async t=>{
  const vendoredPaths=[{path:'Packages/Kit/A.swift',kind:'vendored'},{path:'Packages/Kit/B.swift',kind:'vendored'}];
  const app=await appFixture({},{snapshot:{changedPaths:[],files:[],diff:'',vendoredPaths}});t.after(()=>app.close());
  const out=await app.mention('vendored-only');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>job()?.status==='skipped','not skipped');
  await settle();
  assert.match(job().skipReason,/only vendored \/ generated paths changed \(2, per \.gitattributes\)/);
  assert.equal(job().noReviewAttempt,undefined,'nothing to review is not a failed attempt');
  assert.equal(app.localRequests.length,0,'no local reviewer started');
  assert.equal(app.reviews.length,0);
  const ops=app.ops.at(-1)??'';
  assert.match(ops,/\*\*Status:\*\* skipped/);
  assert.match(ops,/Not reviewed \(\.gitattributes linguist-vendored\/generated\): 2 path\(s\) — Packages\/Kit\/A\.swift, Packages\/Kit\/B\.swift/);
});

test('a PR with vendored and own code reviews its own code and lists what it left out',async t=>{
  const vendoredPaths=[{path:'Packages/Kit/A.swift',kind:'vendored'}];
  const app=await appFixture({reviewChatgpt:false,localJsonRepairEnabled:false},{snapshot:{vendoredPaths}});t.after(()=>app.close());
  app.env.ASHLAR_LOCAL_LLM_STREAM='false';
  const out=await app.mention('vendored-mixed');
  const job=()=>app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId);
  await eventually(()=>app.localRequests.length===1,'local did not start');
  assert.deepEqual({...job().vendoredSkipped,paths:[...job().vendoredSkipped.paths]},{count:1,paths:['Packages/Kit/A.swift']});
  app.localResponses[0].end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['a.ts: constant change only']})}}]}));
  await eventually(()=>app.reviews.length===1,'not posted');
  await eventually(()=>/Not reviewed \(\.gitattributes/.test(app.ops.at(-1)??''),'the posted ops comment does not list the vendored path');
});
