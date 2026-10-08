import test from 'node:test';
import assert from 'node:assert/strict';
import {background,storage} from './helpers.mjs';

// Live P0 2026-09-27: 85 ChatGPT tabs left open. User decision (via the coordinator): the user never
// uses temporary chats in this Chrome, so a temporary-chat tab Ashlar opened is closed 10 min after its
// job finished, and the oldest finished ones first while more than 8 are open. Grok review tabs are
// the same leftover class (Ashlar opens private grok.com chats; they are preserved as "navigated"
// after Grok assigns /c/<id>, and unlike ChatGPT they were never swept). A job in progress, a tab
// with no Ashlar binding, and any non-temporary ChatGPT conversation or personal Grok tab are never
// touched.
const TEMP='https://chatgpt.com/c/6ab8?temporary-chat=true',BARE='https://chatgpt.com/?temporary-chat=true',CONV='https://chatgpt.com/c/users-own';
const GROK='https://grok.com/c/review-A',GROK_HOME='https://grok.com/',GROK_PERSONAL='https://grok.com/c/personal';
const MIN=60_000;
function providerOf(url){return String(url||'').includes('grok.com')?'grok':'chatgpt';}
function worker({tabs,bindings={},registry={},records={},seen,silent=new Set()}){
 const session=storage({...records,...(seen?{'ashlar:tempTabFinishedSeen':seen}:{})});
 const b=background({local:storage({origin:'http://bridge',token:'token',pendingReviewJobs:registry}),session,
  tabs:new Map(tabs.map(t=>[t.id,{status:'complete',...t}])),api:async()=>({ok:true})});
 b.chrome.tabs.query=async()=>[...b.tabs.values()];
 b.chrome.tabs.sendMessage=(id,msg,callback)=>{
  if(silent.has(id)){callback();return;}
  const url=b.tabs.get(id)?.url||'';
  callback(msg.type==='ashlar-tab-status'
   ?{ok:true,ownershipProtocol:1,provider:providerOf(url),jobId:bindings[id]||'',runId:bindings[id]?'run-A':'',released:true,url}:undefined);
 };
 return {b,session};
}

test('a finished Ashlar temporary-chat tab is closed 10 min after it was first seen finished, not before',async()=>{
 const {b,session}=worker({tabs:[{id:10,url:TEMP}],bindings:{10:'job-A'}});
 const first=await b.context.reclaimPreservedTabs();
 assert.deepEqual([b.closedTabs,first.kept],[[],1],'first seen now: kept');
 const seen=session.state['ashlar:tempTabFinishedSeen'];
 assert.ok(Number.isFinite(seen[10]));
 seen[10]-=11*MIN;await session.set({'ashlar:tempTabFinishedSeen':seen});
 const later=await b.context.reclaimPreservedTabs();
 assert.deepEqual([b.closedTabs,later.closed],[[10],1]);
});

test('a preserved record dates the finish; force closes at once',async()=>{
 const old=worker({tabs:[{id:10,url:TEMP}],records:{'ashlar:preserved:job-A:chatgpt:run-A':{tabId:10,at:Date.now()-20*MIN}}});
 await old.b.context.reclaimPreservedTabs();
 assert.deepEqual(old.b.closedTabs,[10],'a preserved record alone names the tab Ashlar\'s');
 assert.equal(old.session.state['ashlar:preserved:job-A:chatgpt:run-A'],undefined,'its record goes with it');
 const young=worker({tabs:[{id:11,url:BARE}],bindings:{11:'job-B'}});
 await young.b.context.reclaimPreservedTabs({force:true});
 assert.deepEqual(young.b.closedTabs,[11]);
});

test('never touched: a job in progress, a tab the worker tracks, a tab with no Ashlar binding, a non-temporary conversation',async()=>{
 const registry={'job-A':{jobId:'job-A',origin:'http://bridge',providers:['chatgpt'],states:{chatgpt:{tabId:12}}}};
 const {b}=worker({tabs:[{id:10,url:TEMP},{id:11,url:TEMP},{id:12,url:TEMP},{id:13,url:CONV}],
  bindings:{10:'job-A',13:'job-C'},registry,seen:{10:0,11:0,12:0,13:0}});
 await b.context.reclaimPreservedTabs({force:true});
 assert.deepEqual(b.closedTabs,[]);
});

test('over the cap of 8 temporary tabs, the oldest finished ones are closed first, even when young',async()=>{
 const tabs=Array.from({length:11},(_,i)=>({id:20+i,url:`https://chatgpt.com/c/t${i}?temporary-chat=true`}));
 const now=Date.now();
 const seen=Object.fromEntries(tabs.map((t,i)=>[t.id,now-(11-i)*1000])); // all younger than 10 min; tab 20 oldest
 const {b}=worker({tabs,bindings:Object.fromEntries(tabs.map(t=>[t.id,`job-${t.id}`])),seen});
 const out=await b.context.reclaimPreservedTabs();
 assert.deepEqual(b.closedTabs,[20,21,22],JSON.stringify(out));
 assert.equal(out.open,8);
});

test('a finished Ashlar Grok tab is closed 10 min after it was first seen finished, not before',async()=>{
 const {b,session}=worker({tabs:[{id:10,url:GROK}],bindings:{10:'job-A'}});
 const first=await b.context.reclaimPreservedTabs();
 assert.deepEqual([b.closedTabs,first.kept],[[],1],'first seen now: kept');
 const seen=session.state['ashlar:tempTabFinishedSeen'];
 assert.ok(Number.isFinite(seen[10]));
 seen[10]-=11*MIN;await session.set({'ashlar:tempTabFinishedSeen':seen});
 const later=await b.context.reclaimPreservedTabs();
 assert.deepEqual([b.closedTabs,later.closed],[[10],1]);
});

test('a Grok preserved record dates the finish; force closes at once, including grok.com home',async()=>{
 const old=worker({tabs:[{id:10,url:GROK}],records:{'ashlar:preserved:job-A:grok:run-A':{tabId:10,at:Date.now()-20*MIN}}});
 await old.b.context.reclaimPreservedTabs();
 assert.deepEqual(old.b.closedTabs,[10],'a preserved record alone names the Grok tab Ashlar\'s');
 assert.equal(old.session.state['ashlar:preserved:job-A:grok:run-A'],undefined,'its record goes with it');
 const young=worker({tabs:[{id:11,url:GROK_HOME}],bindings:{11:'job-B'}});
 await young.b.context.reclaimPreservedTabs({force:true});
 assert.deepEqual(young.b.closedTabs,[11]);
});

test('never touched: an in-flight Grok job, a tracked Grok tab, a personal Grok tab, a silent in-flight owned tab',async()=>{
 const registry={'job-A':{jobId:'job-A',origin:'http://bridge',providers:['grok'],states:{grok:{tabId:12}}},
  'job-B':{jobId:'job-B',origin:'http://bridge',providers:['grok'],states:{grok:{tabId:14}}}};
 const {b}=worker({tabs:[{id:10,url:GROK},{id:12,url:GROK},{id:13,url:GROK_PERSONAL},{id:14,url:GROK}],
  bindings:{10:'job-A'},registry,seen:{10:0,12:0,13:0,14:0},silent:new Set([14]),
  records:{'ashlar:tab:14':{jobId:'job-B',provider:'grok',runId:'run-A'}}});
 await b.context.reclaimPreservedTabs({force:true});
 assert.deepEqual(b.closedTabs,[],'in-flight, tracked, personal, and owned-but-live Grok tabs stay open');
});

test('after a worker restart, an owned Grok tab whose job is gone is closed; a personal tab is not',async()=>{
 const {b}=worker({tabs:[{id:10,url:GROK},{id:99,url:GROK_PERSONAL}],
  records:{'ashlar:tab:10':{jobId:'job-A',provider:'grok',runId:'run-A'}},silent:new Set([10,99])});
 await b.context.reclaimPreservedTabs({force:true});
 assert.deepEqual(b.closedTabs,[10],'the owned leftover closes once its job is gone');
 assert.equal(b.tabs.has(99),true,'a grok.com tab with no Ashlar record stays open');
});
