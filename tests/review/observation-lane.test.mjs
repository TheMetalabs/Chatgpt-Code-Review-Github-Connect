import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {background,storage,flush,raw} from './helpers.mjs';
test('a stalled diagnostic upload never occupies the response collection lane',async t=>{
 let release;const pending=new Promise(r=>release=r);t.after(()=>release({ok:true}));let final=false;
 const task={jobId:'A',origin:'http://bridge',leaseId:'lease-A',prompt:'fixture',providers:['chatgpt'],states:{chatgpt:{tabId:10,started:true,runId:'run-A'}}};
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:{A:task}}),tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/fixture'}]]),
  handler:()=>final?{ok:true,raw}:{ok:false,code:'busy',progress:{runId:'run-A',events:[{source:'page',sequence:1,stage:'response_completed_json_invalid',at:1}]},observation:{state:'response_completed_json_invalid',text:'invalid visible response',totalChars:24}},
  api:(_path,body)=>body.action==='observe'?pending:Promise.resolve({ok:true,active:true,accepted:true})});
 b.context.crypto=webcrypto;b.context.TextEncoder=TextEncoder;
 const jobs=await b.context.workerJobs('http://bridge');
 let returned=false;b.context.progressJob(jobs.A,jobs).then(()=>returned=true);for(let i=0;i<8;i++)await flush();
 assert.equal(b.calls.filter(c=>c.action==='observe').length,1);
 assert.equal(returned,true,'diagnostic RPC blocked the next content/complete poll');
 final=true;await b.context.progressJob(jobs.A,jobs);
 assert.equal(b.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(b.calls.filter(c=>c.action==='observe').length,1,'one pending diagnostic per run, not an unbounded promise fan-out');
});
