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
test('history: a well-formed stage without a label survives a restart as a hash of its name; a malformed one never lands',async t=>{
 // The extension can record a stage before the server labels it (a new stage, or a recorder call the label
 // guard cannot see). The step stays in history, shown and flagged as unlabelled rather than lost. A stage
 // name passes a lexical check only, so it can spell a secret: history keeps a sentinel, never the name.
 const {h,Store,dir}=await store(t);h.recordJob(job('A'));
 const {stepLabel,unlabelledStep,PROGRESS_LABELS}=await import('../../src/lib/review-progress.ts');
 const e={source:'worker',stage:'tab_woken',sequence:1,at:123};
 h.recordProgress('A','chatgpt','run-A',[e,{...e,sequence:2,stage:'generating'},{...e,sequence:3,stage:'dom_drift:follow_up'},{...e,sequence:4,stage:'Tab_Woken'},{...e,sequence:5,stage:'secret_token_abc123'}]);
 const steps=new Store(dir).getJob('A').steps.filter(x=>x.source==='worker');
 assert.deepEqual(steps.map(x=>x.stage),['unlabelled:6fac6376','generating','unlabelled:9699b893']);
 assert.deepEqual(steps.map(stepLabel),['Unlabelled step · #6fac6376',PROGRESS_LABELS.generating,'Unlabelled step · #9699b893']);
 assert.deepEqual(steps.map(unlabelledStep),[true,false,true]);
 assert.equal(JSON.stringify(new Store(dir).getJob('A',true)).includes('secret_token'),false,'nor in the private detail');
 const files=readdirSync(dir,{recursive:true}).filter(path=>path.endsWith('.json'));
 assert.ok(files.length);
 assert.deepEqual(files.filter(path=>/secret_token|tab_woken/.test(readFileSync(join(dir,path),'utf8'))),[],'no stored file keeps the name');
 assert.equal(stepLabel({source:'server',stage:'job.awaiting_chat'}),'job.awaiting_chat','a server step is shown by its own name');
 assert.equal(unlabelledStep({source:'server',stage:'job.awaiting_chat'}),false);
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

test('history: complete source escrow survives filesystem restart, is immutable and private by default',async t=>{
 const {h,Store,dir}=await store(t);const {createHash}=await import('node:crypto');h.recordJob(job('capture-A'));
 const text='PRIVATE captured original "literal"',digest=value=>createHash('sha256').update(value).digest('hex');
 const capture={id:digest('capture-key'),jobId:'capture-A',headSha:'abc',provider:'chatgpt',runId:'run-A',responseId:'response-A',sourceHash:digest(text),text,at:100};
 h.putCapture(capture);const reopened=new Store(dir);
 assert.equal(reopened.getCapture('capture-A',capture.id).text,text);
 assert.equal(JSON.stringify(reopened.getJob('capture-A')).includes('PRIVATE'),false);
 assert.equal(reopened.getJob('capture-A',true).captures[0].totalChars,text.length);
 assert.equal(reopened.getJob('capture-A',true).captures[0].text,text);
 assert.throws(()=>reopened.putCapture({...capture,text:'changed',sourceHash:digest('changed')}),/immutable/);
 reopened.prune(365*86_400_000);assert.equal(reopened.getCapture('capture-A',capture.id).text,text,'nonterminal captured source must not expire by age');
});

test('history: capture size/count and path guards fail closed without truncating a source',async t=>{
 const {h}=await store(t,{maxResponseChars:100});const {createHash}=await import('node:crypto');h.recordJob(job('A'));
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const entry=text=>({id:digest('id-'+text),jobId:'A',headSha:'abc',provider:'chatgpt',runId:'run-A',responseId:'response-A',sourceHash:digest(text),text,at:100});
 assert.throws(()=>h.putCapture(entry('x'.repeat(101))),/limit/);assert.equal(h.listCaptures('A').length,0);
 for(let i=0;i<8;i++)h.putCapture(entry('source '+i));assert.throws(()=>h.putCapture(entry('source ninth')),/attempt_limit/);
 assert.equal(h.getCapture('A','../secret'),null);assert.equal(h.getJob('A',true).captures[7].text,'source 7');
});
