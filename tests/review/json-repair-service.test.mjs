import test from 'node:test';
import assert from 'node:assert/strict';
import {JsonRepairService} from '../../src/lib/json-repair.server.ts';
import {ReviewHistoryStore} from '../../src/lib/review-history.server.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {requestLocalChat} from '../../src/lib/local-chat-request.server.ts';
import {overlayEnv, sanitizeBotSettings, botSettingsToEnv} from '../../src/lib/settings.server.ts';
const value={findings:[],investigated_safe:['a.ts: checked "condition"']};
const raw=JSON.stringify(value),original=raw.replace(/\\"/g,'"');
const hash=text=>createHash('sha256').update(text).digest('hex');
const input={jobId:'A',provider:'chatgpt',runId:'run-A',responseId:'response-A',original,sourceHash:hash(original),schema:'review',headSha:'abc'};
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(t,{response=raw}={}) {
 const history=new ReviewHistoryStore(null);history.recordJob({id:'A',owner:'fixture',repo:'repo',pr:1,status:'awaiting_chat',createdAt:1,updatedAt:1,findings:[]});
 const settings={...DEFAULT_SETTINGS,localLlmBaseUrl:'http://local/v1',localLlmModel:'formatter'};
 const calls=[],accepted=[];let current=true;
 const deps={history:()=>history,settings:()=>settings,isCurrent:()=>current,isAccepted:record=>accepted.some(r=>r.id===record.id),
  request:async(...args)=>{calls.push(args);return typeof response==='function'?response(...args):response;},
  accept:async record=>{if(!accepted.some(r=>r.id===record.id))accepted.push(record);return {ok:true};}};
 const service=new JsonRepairService(deps);t.after(()=>service.dispose());
 return {service,history,settings,calls,accepted,deps,setCurrent:value=>{current=value;}};
}
test('single attempt stores exact original and candidate separately; commit retains original provider',async t=>{
 const f=fixture(t);const first=f.service.start(input);assert.equal(first.status,'running');
 assert.equal(f.history.getRepair('A',first.id).original,original);
 for(let n=0;n<10;n++)f.service.start(input);
 await flush();assert.equal(f.calls.length,1);const ready=f.service.status('A',first.id);assert.equal(ready.status,'ready');assert.equal(f.accepted.length,0);
 assert.equal(JSON.parse(f.calls[0][2].messages[1].content).original,original);
 assert.match(f.calls[0][2].messages[0].content,/format|formatting/i);
 const out=await f.service.commit('A',first.id);assert.equal(out.status,'accepted');await f.service.commit('A',first.id);
 assert.equal(f.accepted.length,1);assert.equal(f.accepted[0].provider,'chatgpt');
});
test('OFF is a kill switch, not a change to normal reviewer selection',async t=>{
 const f=fixture(t);f.settings.localJsonRepairEnabled=false;
 assert.equal(f.service.start(input).status,'disabled');await flush();assert.equal(f.calls.length,0);
 f.settings.localJsonRepairEnabled=true;assert.equal(f.settings.reviewLocal,false);f.service.start(input);await flush();assert.equal(f.calls.length,1);
});
test('turning OFF while inference is pending prevents application even after OFF->ON',async t=>{
 let resolve;const gate=new Promise(r=>resolve=r);const f=fixture(t,{response:()=>gate});const first=f.service.start(input);await flush();
 f.settings.localJsonRepairEnabled=false;f.service.cancel('disabled');assert.equal(f.calls[0][3].aborted,true);
 f.settings.localJsonRepairEnabled=true;resolve(raw);await flush();
 assert.equal(f.service.status('A',first.id).status,'disabled');assert.equal((await f.service.commit('A',first.id)).status,'disabled');assert.equal(f.accepted.length,0);
});
test('source and attempted record must persist before Local is invoked',async t=>{
 const f=fixture(t);f.history.putRepair=()=>{throw Error('disk failed');};
 assert.throws(()=>f.service.start(input),/disk/);await flush();assert.equal(f.calls.length,0);
});
test('server restart never repeats an uncertain inference request',async t=>{
 let resolve;const gate=new Promise(r=>resolve=r);const f=fixture(t,{response:()=>gate});const r=f.service.start(input);await flush();
 const restored=new JsonRepairService(f.deps);t.after(()=>restored.dispose());
 assert.equal(restored.status('A',r.id).status,'interrupted');assert.equal(restored.start(input).status,'interrupted');
 resolve(raw);await flush();assert.equal(f.calls.length,1);
});
test('new native result or cancellation invalidates a pending repair',async t=>{
 let resolve;const gate=new Promise(r=>resolve=r);const f=fixture(t,{response:()=>gate});const r=f.service.start(input);await flush();f.setCurrent(false);resolve(raw);await flush();
 assert.equal(f.service.status('A',r.id).status,'superseded');assert.equal(f.accepted.length,0);
});
test('malformed or content-changing candidate is inspectable and not auto retried',async t=>{
 const f=fixture(t,{response:JSON.stringify({findings:[],investigated_safe:['invented safe result']})});const r=f.service.start(input);await flush();
 assert.equal(f.service.status('A',r.id).status,'needs_attention');f.service.start(input);await flush();assert.equal(f.calls.length,1);assert.equal(f.accepted.length,0);
 const metadata=f.history.getJob('A');assert.ok(metadata.repairs.length);assert.equal(JSON.stringify(metadata).includes(original),false);
 const privateRecord=f.history.getJob('A',true).repairs[0];assert.equal(privateRecord.original,original);assert.ok(privateRecord.candidate.includes('invented'));
});
test('original digest and size are checked, never truncated into repair input',async t=>{
 const f=fixture(t);assert.throws(()=>f.service.start({...input,sourceHash:'wrong'}),/source/);
 assert.throws(()=>f.service.start({...input,original:'x'.repeat(500001)}),/source/);assert.equal(f.calls.length,0);
});
test('a normal schema-valid response never creates an extra model request',async t=>{
 const f=fixture(t);assert.equal(f.service.start({...input,original:raw,sourceHash:hash(raw)}).status,'not_needed');await flush();assert.equal(f.calls.length,0);
});
test('ambiguous HTTP failure does not repeat inference or discard the original',async t=>{
 const f=fixture(t,{response:()=>{throw Error('socket closed');}});const r=f.service.start(input);await flush();
 assert.equal(f.service.status('A',r.id).status,'needs_attention');f.service.start(input);await flush();assert.equal(f.calls.length,1);
 assert.equal(f.history.getRepair('A',r.id).original,original);
});

for (const reviewLocal of [false, true]) for (const localJsonRepairEnabled of [false, true]) {
 test(`fallback flag alone controls formatting (reviewLocal=${reviewLocal}, fallback=${localJsonRepairEnabled})`,async t=>{
  const f=fixture(t);Object.assign(f.settings,{reviewLocal,localJsonRepairEnabled});
  const result=f.service.start(input);await flush();
  assert.equal(f.calls.length,localJsonRepairEnabled?1:0);
  assert.equal(result.status,localJsonRepairEnabled?'running':'disabled');
  assert.equal(f.settings.reviewLocal,reviewLocal,'repair changed reviewer selection');
  if(localJsonRepairEnabled){
   assert.match(f.calls[0][2].messages[0].content,/NOT a code reviewer/);
   assert.equal(JSON.parse(f.calls[0][2].messages[1].content).original,original);
   const accepted=await f.service.commit('A',result.id);assert.equal(accepted.status,'accepted');
   assert.deepEqual(f.accepted.map(r=>r.provider),['chatgpt']);
  }
 });
}
test('changing independent Local reviewer participation does not cancel or re-run a pending repair',async t=>{
 let resolve;const gate=new Promise(r=>resolve=r);const f=fixture(t,{response:()=>gate});
 f.settings.reviewLocal=true;const first=f.service.start(input);await flush();
 f.settings.reviewLocal=false;assert.equal(f.service.status('A',first.id).status,'running');
 assert.equal(f.calls[0][3].aborted,false);resolve(raw);await flush();
 assert.equal((await f.service.commit('A',first.id)).status,'accepted');assert.equal(f.calls.length,1);
});

test('a temporary result archive failure retries commit, never Local generation',async t=>{
 const f=fixture(t);let fail=true,commits=0;
 f.deps.accept=async record=>{commits++;if(fail)return {ok:false,code:'history_unavailable'};f.accepted.push(record);return {ok:true};};
 const started=f.service.start(input);await flush();assert.equal(f.service.status('A',started.id).status,'ready');
 assert.equal((await f.service.commit('A',started.id)).status,'ready');assert.equal(f.calls.length,1);
 fail=false;assert.equal((await f.service.commit('A',started.id)).status,'accepted');assert.equal(f.calls.length,1);assert.equal(commits,2);
});

test('a stray-quote slip is repaired without a Local call and its commit is accepted',async t=>{
 const text=readFileSync(new URL('./fixtures/chatgpt-1043-labelled-stray-quote.txt',import.meta.url),'utf8');
 const f=fixture(t);const started=f.service.start({...input,original:text,sourceHash:hash(text)});await flush();
 assert.equal(f.service.status('A',started.id).status,'ready');assert.equal(f.calls.length,0,'the Local model was called');
 assert.equal((await f.service.commit('A',started.id)).status,'accepted');
 assert.deepEqual(JSON.parse(f.accepted[0].raw).findings.map(finding=>finding.severity),['P1','P1','P2']);
});

// #87 failure A2(i): with no max_tokens the server's 8192-token default (thinking included) ended
// every repair before it could re-emit the original, and the record said only "failed".
test('the Local request carries a token budget for re-emitting the original, and thinking stays on by default',async t=>{
 const f=fixture(t);f.service.start(input);await flush();
 assert.equal(f.calls[0][2].max_tokens,Math.ceil(original.length/2)+4096);
 assert.equal('chat_template_kwargs' in f.calls[0][2],false);
});
test('ASHLAR_LOCAL_REPAIR_NO_THINKING turns thinking off for the Local repair request only when set',async t=>{
 assert.equal(DEFAULT_SETTINGS.localRepairNoThinking,false);
 const saved=process.env.ASHLAR_LOCAL_REPAIR_NO_THINKING;t.after(()=>{if(saved===undefined)delete process.env.ASHLAR_LOCAL_REPAIR_NO_THINKING;else process.env.ASHLAR_LOCAL_REPAIR_NO_THINKING=saved;});
 process.env.ASHLAR_LOCAL_REPAIR_NO_THINKING='true';
 const flagged=sanitizeBotSettings(overlayEnv({}));assert.equal(flagged.localRepairNoThinking,true);
 assert.equal(botSettingsToEnv(flagged).ASHLAR_LOCAL_REPAIR_NO_THINKING,'true');
 delete process.env.ASHLAR_LOCAL_REPAIR_NO_THINKING;assert.equal(sanitizeBotSettings(overlayEnv({})).localRepairNoThinking,false);
 const f=fixture(t);f.settings.localRepairNoThinking=true;f.service.start(input);await flush();
 assert.deepEqual(f.calls[0][2].chat_template_kwargs,{enable_thinking:false});
 assert.equal(f.calls[0][2].max_tokens,Math.ceil(original.length/2)+4096);
});
test('a Local reply cut off at the token limit is recorded as finish_reason_length',async t=>{
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"findings":['}}]}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}/v1`;
 const f=fixture(t,{response:(_base,key,body,signal)=>requestLocalChat(base,key,body,signal,{stream:false})});
 const started=f.service.start(input);
 for(let n=0;n<500 && f.history.getRepair('A',started.id).status==='running';n++)await new Promise(r=>setTimeout(r,10));
 const done=f.service.status('A',started.id);
 assert.equal(done.status,'needs_attention');assert.deepEqual(done.errors,['finish_reason_length']);assert.equal(f.calls.length,1);
});
