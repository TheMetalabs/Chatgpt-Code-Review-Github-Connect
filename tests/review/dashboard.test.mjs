import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
// Exercise production store initialization and merging; unrelated demo/model functions are inert fixtures.
async function store(){let state;const code=readFileSync(new URL('../../src/lib/store.ts',import.meta.url),'utf8');
 const names=[...code.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g)].flatMap(m=>m[1].split(',').map(n=>n.trim()).filter(n=>n&&!n.startsWith('type ')));
 const context=vm.createContext({console,Date,Set,Map,fetch:()=>{throw Error('no production writes from demo reset');},performance,create:()=>fn=>{const set=p=>{state={...state,...(typeof p==='function'?p(state):p)};};state=fn(set,()=>state);return {getState:()=>state};},DEFAULT_SETTINGS:{},LIVE_INFLIGHT_STATUSES:[],SAMPLE_PRS:{'pay-412':{files:[],changedPaths:[]}},buildReview:()=>({id:'seed',at:1}),filterPublishable:()=>[],tracesFor412:()=>[],CANDIDATE_412_DROPPED:{},FINDING_412:{},FINDING_421:{}});
 const clean=stripTypeScriptTypes(code.replace(/import[\s\S]*?from\s*["'][^"']+["'];/g,'')).replace('export const useAshlar','const useAshlar');vm.runInContext(clean+'\nglobalThis.store=useAshlar;',context);return context.store;
}
test('dashboard: production initializes empty, never with a posted demo review',async()=>{const s=await store();assert.equal(s.getState().jobs.length,0);assert.equal(s.getState().reviews.length,0);});
test('dashboard: reset demo preserves real jobs/reviews and never resets the server',async()=>{const s=await store();s.getState().mergeRemote({jobs:[{id:'real',origin:'github',createdAt:1}],events:[],reviews:[{id:'review',jobId:'real',at:1}]});s.getState().resetDemo();assert.equal(s.getState().jobs[0].id,'real');assert.equal(s.getState().reviews[0].id,'review');});
test('dashboard: server snapshots replace stale production rows and report sync health',async()=>{
 const s=await store();s.getState().mergeRemote({jobs:[{id:'A',origin:'github',createdAt:1}],events:[{id:'e',jobId:'A',at:1}],reviews:[{id:'r',jobId:'A',at:1}]});
 const success=s.getState().sync.lastSuccessAt;s.getState().markSyncError('HTTP 503');assert.equal(s.getState().jobs[0].id,'A');assert.equal(s.getState().sync.status,'error');assert.equal(s.getState().sync.lastSuccessAt,success);
 s.getState().mergeRemote({jobs:[],events:[],reviews:[]});assert.equal(s.getState().jobs.length,0);assert.equal(s.getState().reviews.length,0);assert.equal(s.getState().sync.status,'live');
});
