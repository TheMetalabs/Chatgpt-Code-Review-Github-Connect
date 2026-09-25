import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness,job,json,types,parser,fallback,loadTs} from './load-source.mjs';
import * as reviewProgress from '../../src/lib/review-progress.ts';
const old=()=>Date.now()-24*3600_000;
test('stale heartbeat does not hold a lease forever just because generating=true',()=>{
 const {bridge}=bridgeHarness([job({bridgeClaimedAt:old(),generating:{chatgpt:true}})]);
 assert.equal(bridge.claimBridgeJob('job1','chrome1').ok,true);
});
test('stale attempts are resumable, never automatically regenerated',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:old(),bridgeClientId:'chrome1',attemptedProviders:['chatgpt'],generating:{chatgpt:true}})]);
 const result=bridge.takeNextBridgeJob('chrome1');
 assert.equal(result?.jobId,'job1');assert.ok(result.resumeProviders.includes('chatgpt'));
 assert.equal(state.jobs[0].generating.chatgpt,true);
});
test('fresh heartbeat permits arbitrarily old generation to keep running',()=>{
 const {bridge,state}=bridgeHarness([job({createdAt:old(),bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 bridge.refreshBridgeClaim('job1',{chatgpt:true});
 assert.equal(bridge.claimBridgeJob('job1','other').ok,false);assert.equal(state.jobs[0].generating.chatgpt,true);
});
test('completed queue entry cannot starve the next pending review',()=>{
 const {bridge}=bridgeHarness([job({storedLegs:[{provider:'chatgpt',raw:json}]}),job({id:'job2'})]);
 assert.equal(bridge.takeNextBridgeJob('chrome1')?.jobId,'job2');
});
test('release does not clear execution history and replay a failed prompt',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),attemptedProviders:['chatgpt'],generating:{chatgpt:false},providerErrors:{chatgpt:{code:'empty',message:'no json'}}})]);
 bridge.releaseBridgeJob('job1');assert.deepEqual([...state.jobs[0].attemptedProviders],['chatgpt']);
 assert.equal(bridge.takeNextBridgeJob('chrome1'),null);
});
test('a late heartbeat cannot resurrect a released claim',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 bridge.releaseBridgeJob('job1');bridge.refreshBridgeClaim('job1',{chatgpt:true});
 assert.equal(state.jobs[0].bridgeClaimedAt,undefined);
});
test('raw and generating=false are stored in one atomic state transition',async()=>{
 const {bridge,snapshots}=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 await bridge.completeBridgeJob('job1',json,[{provider:'chatgpt',raw:json}]);
 for(const snapshot of snapshots)if(snapshot.generating.chatgpt===false)assert.ok(snapshot.storedLegs.some(l=>l.provider==='chatgpt'&&l.raw===json));
});
test('late positive heartbeat cannot undo a completed answer',async()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 await bridge.completeBridgeJob('job1',json,[{provider:'chatgpt',raw:json}]);bridge.refreshBridgeClaim('job1',{chatgpt:true});
 assert.equal(state.jobs[0].generating.chatgpt,false);
});
test('false without a terminal outcome is not sufficient to end generation',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 bridge.refreshBridgeClaim('job1',{chatgpt:false});assert.equal(state.jobs[0].generating.chatgpt,true);
});
test('claim endpoint enforces mention-only policy too',()=>{
 const {bridge}=bridgeHarness([job({trigger:'pull_request.opened'})]);assert.equal(bridge.claimBridgeJob('job1').ok,false);
});
// Every lane reads the provider's progress stage for its usage-limit flag, so the stage helpers come along.
const progress=()=>loadTs('src/lib/reviewer-progress.ts',{...types,...parser,...fallback,...reviewProgress});
test('quota note is never borrowed from another provider',()=>{
 const lanes=progress().buildReviewerLanes(job({reviewProviders:['chatgpt','grok'],generating:{chatgpt:false,grok:false},assumptions:['chatgpt usage limit','grok finished without JSON']}));
 assert.equal(lanes[1].detail,'finished without JSON');
});
test('Korean quota with provider name uses real word-boundary matching',()=>{
 const [lane]=progress().buildReviewerLanes(job({generating:{chatgpt:false},assumptions:['chatgpt 한도에 도달했습니다']}));
 assert.equal(lane.detail,'usage limit');
});
test('actual structured quota survives heartbeat and reaches reviewer display',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:Date.now(),generating:{chatgpt:true}})]);
 bridge.refreshBridgeClaim('job1',{chatgpt:false},{chatgpt:{code:'quota',message:'limit reached'}});
 assert.equal(progress().buildReviewerLanes(state.jobs[0])[0].detail,'usage limit');
});
test('disconnected bridge is pending rather than empty/failed',()=>{
 const [lane]=progress().buildReviewerLanes(job({bridgeClaimedAt:old(),generating:{chatgpt:true},providerErrors:{chatgpt:{code:'disconnected',message:'reconnecting'}}}));
 assert.equal(lane.state,'waiting');assert.match(lane.detail,/reconnect|unknown/i);
});
test('escaped quotes/backslashes/braces survive extraction',()=>{
 const raw=JSON.stringify({findings:[],keep:['return "}"; const p = "C:\\tmp";']});assert.equal(parser.extractChatJson('thinking {\n'+raw),raw);
});
test('final unfenced JSON beats an older fenced example',()=>{
 assert.equal(parser.extractChatJson('```json\n{"findings":[]}\n```\n'+json),json);
});

test('direct claim cannot transfer a pending generation to another Chrome profile',()=>{
 const {bridge,state}=bridgeHarness([job({bridgeClaimedAt:old(),bridgeClientId:'chrome1',attemptedProviders:['chatgpt'],generating:{chatgpt:true}})]);
 assert.equal(bridge.claimBridgeJob('job1','chrome2').ok,false);
 assert.equal(state.jobs[0].bridgeClientId,'chrome1');
});
