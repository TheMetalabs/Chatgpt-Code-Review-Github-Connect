import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {loadTs,parser,types,json,source} from './load-source.mjs';
function loadLocal(){return loadTs('src/lib/local-llm.server.ts',{...parser,httpRequest,httpsRequest,AbortSignal});}
async function endpoint(t,handler){
 const server=createServer(handler);server.requestTimeout=0;server.timeout=0;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 return {...types.DEFAULT_SETTINGS,localLlmBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,localLlmModel:'fixture'};
}
const envelope=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
test('no SDK/default or 10-minute timeout on local generation',()=>{
 assert.doesNotMatch(source('src/lib/local-llm.server.ts'),/600_000|new OpenAI/);
});
test('local waits for complete HTTP body, not headers/partial content, without a timer',async t=>{
 let response,received;
 const ready=new Promise(r=>received=r);
 const settings=await endpoint(t,(_req,res)=>{response=res;res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":');received();});
 let settled=false;const call=loadLocal().runLocalLlm('review',settings).then(out=>{settled=true;return out;});
 // Test harness bound only: a broken implementation must not hang the test runner.
 await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture was not contacted')),1000);timer.unref();})]);
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);
 response.end(envelope(json).slice('{"choices":'.length));
 assert.equal((await call).raw,json);
});
test('local correction retry occurs once only after a completed invalid reply',async t=>{
 let requests=0;
 const settings=await endpoint(t,(_req,res)=>{requests++;res.end(envelope(requests===1?'prose':json));});
 const out=await loadLocal().runLocalLlm('review',settings);assert.equal(out.raw,json);assert.equal(requests,2);
});
test('two completed invalid replies are a parse error, never answered raw',async t=>{
 let requests=0;
 const settings=await endpoint(t,(_req,res)=>{requests++;res.end(envelope('not review JSON'));});
 const out=await loadLocal().runLocalLlm('review',settings);assert.equal(out.ok,false);assert.match(out.error,/JSON/i);assert.equal(requests,2);
});
test('real transport failure is not silently retried as another generation',async t=>{
 let requests=0;const settings=await endpoint(t,(req)=>{requests++;req.socket.destroy();});
 const out=await loadLocal().runLocalLlm('review',settings);assert.equal(out.ok,false);assert.equal(requests,1);
});
test('explicit cancellation aborts a pending local call',async t=>{
 let received;const ready=new Promise(r=>received=r);
 const settings=await endpoint(t,()=>received());const controller=new AbortController();
 const call=loadLocal().runLocalLlm('review',settings,controller.signal);
 await Promise.race([ready,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture was not contacted')),1000);timer.unref();})]);
 controller.abort();assert.equal((await call).ok,false);
});
