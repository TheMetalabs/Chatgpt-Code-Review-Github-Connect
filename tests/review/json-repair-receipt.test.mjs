import test from 'node:test';
import assert from 'node:assert/strict';
import {background,storage} from './helpers.mjs';

test('repair receipt persistence is retried before notifying the page after a failed outbox write',async()=>{
 const local=storage({origin:'http://bridge',token:'token'});
 let reject=true;const set=local.set;
 local.set=async data=>{if(reject && data.pendingReviewJobs)throw Error('receipt persistence unavailable');return set(data);};
 const b=background({local,tabs:new Map([[10,{id:10,url:'https://chatgpt.com/c/A'}]]),handler:()=>({ok:true,accepted:true})});
 const job={jobId:'A',origin:'http://bridge',providers:['chatgpt'],states:{chatgpt:{runId:'run-A',tabId:10,started:true,repairAttempt:{id:'repair-A',sourceHash:'hash-A',responseId:'response-A',text:'original source'}}}};
 const jobs={A:job}, receipt={id:'repair-A',sourceHash:'hash-A',responseId:'response-A',runId:'run-A',status:'accepted',raw:'{"findings":[]}'};
 await assert.rejects(b.context.acceptRepairReceipt(job,'chatgpt',jobs,receipt),/persistence/);
 await assert.rejects(b.context.repairProvider(job,'chatgpt',jobs),/persistence/);
 assert.equal(b.messages.some(m=>m.type==='ashlar-repair-accepted'),false,'unsaved in-memory receipt was sent on the next cycle');
 assert.equal(b.closedTabs.length,0);
 reject=false;await b.context.repairProvider(job,'chatgpt',jobs);
 assert.equal(b.messages.filter(m=>m.type==='ashlar-repair-accepted').length,1);
 assert.equal(local.state.pendingReviewJobs.A.states.chatgpt.delivered,true);
});
