import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const modulePath=new URL('../../src/lib/review-history.server.ts',import.meta.url);
async function store(t,opts={}) {
 assert.ok(existsSync(modulePath),'operational history must have a restart-safe store');
 const {ReviewHistoryStore}=await import(modulePath);
 const dir=mkdtempSync(join(tmpdir(),'ashlar-history-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,Store:ReviewHistoryStore,h:new ReviewHistoryStore(dir,opts)};
}
const job=(id,status='awaiting_chat',at=100)=>({id,owner:'owner',repo:'repo',pr:219,headSha:'abc',deliveryId:'delivery-'+id,trigger:'issue_comment.mention',sender:'operator',thread:{commentId:42,userText:'secret prompt'},origin:'github',status,createdAt:at,updatedAt:at,reviewProviders:['chatgpt'],traces:[],findings:[],assumptions:[],investigatedSafe:[],candidates:[],plan:'secret plan',chatPrompt:'secret prompt',bridgeLeaseId:'secret lease'});
test('history: metadata and timeline survive a store restart without exposing secrets',async t=>{
 const {h,Store,dir}=await store(t);h.recordJob(job('A'));h.recordJob(job('A','posting',200));h.recordJob(job('A','posted',300));
 const r=new Store(dir).getJob('A');assert.equal(r.job.status,'posted');assert.deepEqual(r.steps.map(x=>x.stage),['job.awaiting_chat','job.posting','job.posted']);
 const all=JSON.stringify(r);assert.equal(all.includes('secret'),false);assert.equal(r.job.commentId,42);
});
test('history: heartbeat-only updates do not spam the stage log',async t=>{
 const {h}=await store(t);for(let i=0;i<30;i++)h.recordJob({...job('A'),updatedAt:100+i,bridgeClaimedAt:100+i});assert.equal(h.getJob('A').steps.length,1);
});
test('history: telemetry validates stage, bounds metadata and deduplicates by run/source/sequence',async t=>{
 const {h}=await store(t);h.recordJob(job('A'));const e={source:'page',stage:'send_unconfirmed',sequence:1,at:123,token:'never-log'};
 h.recordProgress('A','chatgpt','run-A',[e,{...e,stage:'secret prompt'}]);h.recordProgress('A','chatgpt','run-A',[e]);
 const r=h.getJob('A');assert.equal(r.steps.filter(x=>x.stage==='send_unconfirmed').length,1);assert.equal(JSON.stringify(r).includes('never-log'),false);assert.equal(JSON.stringify(r).includes('secret prompt'),false);
});
test('history: private responses are separate from lists/default detail and survive restart',async t=>{
 const {h,Store,dir}=await store(t);h.recordJob(job('A'));h.recordResponse('A','chatgpt','{"findings":[]}', 'PRIVATE ORIGINAL');
 assert.equal(JSON.stringify(h.listJobs({})).includes('PRIVATE'),false);assert.equal(JSON.stringify(h.getJob('A')).includes('PRIVATE'),false);
 assert.equal(new Store(dir).getJob('A',true).responses.chatgpt.original,'PRIVATE ORIGINAL');
});
test('history: response truncation is explicit and per-provider',async t=>{
 const {h}=await store(t,{maxResponseChars:20});h.recordJob(job('A'));h.recordResponse('A','chatgpt','{}'.repeat(20),'x'.repeat(50));
 const r=h.getJob('A',true).responses.chatgpt;assert.equal(r.original.length,20);assert.equal(r.originalChars,50);assert.equal(r.truncated,true);
});
test('history: terminal retention never deletes an indefinitely pending job',async t=>{
 const {h}=await store(t,{maxTerminalJobs:1,retentionDays:100000});h.recordJob(job('active'));h.recordJob(job('old','posted',200));h.recordJob(job('new','posted',300));h.prune(400);
 assert.ok(h.getJob('active'));assert.equal(h.getJob('old'),null);assert.ok(h.getJob('new'));
});
test('history: cursor pagination and search cover PR, comment and job IDs',async t=>{
 const {h}=await store(t);for(let i=1;i<=4;i++)h.recordJob(job('J'+i,'posted',i));const one=h.listJobs({limit:2,q:'219'});const two=h.listJobs({limit:2,q:'219',cursor:one.nextCursor});
 assert.deepEqual([...one.items,...two.items].map(x=>x.id),['J4','J3','J2','J1']);assert.equal(h.listJobs({q:'J3'}).items.length,1);assert.equal(h.listJobs({q:'42'}).items.length,4);
});
test('history: ignored delivery records link the comment without creating review jobs',async t=>{
 const {h}=await store(t);h.recordDelivery({id:'event',deliveryId:'delivery',at:123,event:'issue_comment',action:'ignored',hmac:'ok',httpStatus:202,skipReason:'not a mention',summary:'repo#219 ignored'}, {owner:'owner',repo:'repo',pr:219,commentId:99});
 assert.equal(h.listJobs({}).items.length,0);assert.equal(h.listDeliveries({q:'99'}).items[0].commentId,99);
});
test('history: untrusted identifiers cannot escape the private directory',async t=>{
 const {h,dir}=await store(t);h.recordJob(job('../../outside'));assert.equal(h.getJob('../../outside').job.id,'../../outside');assert.ok(readdirSync(join(dir,'jobs')).every(x=>/^[a-f0-9]{64}$/.test(x)));
});
test('history: disk failure is visible and response storage does not acknowledge success',async t=>{
 const {h,dir}=await store(t);h.recordJob(job('A'));rmSync(join(dir,'jobs'),{recursive:true});writeFileSync(join(dir,'jobs'),'blocked');assert.throws(()=>h.recordResponse('A','chatgpt','{}','reply'));assert.equal(h.health().ok,false);
});
