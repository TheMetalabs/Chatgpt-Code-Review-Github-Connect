// Production module graph; only GitHub, persistent settings, UI router construction and
// watcher cadence are replaced. Harbor, ingress, parsing, bridge handlers and Local HTTP run unchanged.
import vm from 'node:vm';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {createServer} from 'node:http';
import {root,types} from './load-source.mjs';
export async function appFixture(options={}) {
 const ops=[],reviews=[],localResponses=[],localRequests=[];
 let route;
 const server=createServer(async(req,res)=>{
   if(req.url==='/v1/chat/completions'){
     let text='';for await(const chunk of req)text+=chunk;
     localRequests.push(JSON.parse(text));localResponses.push(res);return;
   }
   if(req.url.split('?')[0]==='/api/bridge'&&route){
     try{
       let body='';for await(const chunk of req)body+=chunk;
       const request=new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(body?{body}:{})});
       const response=await route.server.handlers[req.method]({request});
       res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
     }catch(error){res.writeHead(500);res.end(JSON.stringify({ok:false,error:error.message}));}
     return;
   }
   res.writeHead(404);res.end();
 });
 server.requestTimeout=0;server.timeout=0;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const settings={...types.DEFAULT_SETTINGS,reviewChatgpt:true,reviewGrok:false,reviewLocal:true,localLlmBaseUrl:origin+'/v1',localLlmModel:'fixture',...options};
 const sample={key:'fixture',owner:'fixture',repo:'fixture',pr:1,title:'Fixture review',headSha:'abc123',baseSha:'def456',sender:'author',isFork:false,isDraft:false,
  changedPaths:['a.ts'],files:[{path:'a.ts',content:'export const answer = 42;\n',language:'ts'}],diff:'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;\n'};
 const clock={now:Date.now()};class Clock extends Date{static now(){return clock.now;}}
 const context=vm.createContext({console,Buffer,URL,Request,Response,Headers,AbortController,AbortSignal,performance,setTimeout,clearTimeout,Date:Clock,
   process:{env:{NODE_TEST_CONTEXT:'review-fixture',ASHLAR_BRIDGE_TOKEN:'fixture-token'}}});
 const mocks=new Map([
  [resolve(root,'src/lib/dotenv-file.server.ts'),{loadDotenvFile(){},writeEnvPatch(){}}],
  [resolve(root,'src/lib/settings.server.ts'),{loadBotSettings:()=>settings,saveBotSettings:s=>s,sanitizeBotSettings:s=>s}],
  [resolve(root,'src/lib/utils.ts'),{sleep:()=>new Promise(resolve=>setTimeout(resolve,25))}],
  [resolve(root,'src/lib/github.server.ts'),{
    githubReady:()=>({appId:'fixture',privateKey:'fixture'}),installationToken:async()=> 'fixture-not-a-real-token',
    fetchPullHead:async()=>({...sample,draft:false,fork:false}),fetchPullSnapshot:async()=>sample,
    reactOnDelivery:async()=>{},formatGithubError:error=>String(error),
    createIssueComment:async(_token,input)=>{ops.push(input.body);return {id:1};},
    updateIssueComment:async(_token,input)=>{ops.push(input.body);},
    createPullReview:async(_token,input)=>{reviews.push(input);return {id:2};},
  }],
  ['@tanstack/react-router',{createFileRoute:()=>config=>config}],
 ]);
 const cache=new Map();
 function resolveModule(spec,parent){
   if(spec.startsWith('node:')||mocks.has(spec))return spec;
   let path=spec.startsWith('@/')?resolve(root,'src',spec.slice(2)):resolve(dirname(parent),spec);
   if(!existsSync(path)&&existsSync(path+'.ts'))path+='.ts';return path;
 }
 async function instantiate(id){
   if(cache.has(id))return cache.get(id);
   const promise=(async()=>{
     const values=mocks.get(id)||(id.startsWith('node:')?await import(id):null);
     if(values)return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context,identifier:id});
     return new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(id,'utf8')),{context,identifier:id,importModuleDynamically:async(spec,module)=>{
       const child=await instantiate(resolveModule(spec,module.identifier));if(child.status==='unlinked')await child.link(linker);if(child.status==='linked')await child.evaluate();return child;
     }});
   })();cache.set(id,promise);return promise;
 }
 const linker=(spec,parent)=>instantiate(resolveModule(spec,parent.identifier));
 async function load(path){const module=await instantiate(resolve(root,path));if(module.status==='unlinked')await module.link(linker);if(module.status==='linked')await module.evaluate();return module.namespace;}
 const harbor=await load('src/lib/harbor.server.ts');
 const bridge=await load('src/lib/bridge.server.ts');
 route=(await load('src/routes/api/bridge.ts')).Route;
 function mention(deliveryId='fixture-mention'){
  return harbor.ingestGitHubWebhook({hmacOk:true,deliveryId,event:'issue_comment',payload:{action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:1,pull_request:{},title:'fixture'},comment:{id:42,body:'@ashlar-bot review'}}});
 }
 return {harbor,bridge,origin,clock,ops,reviews,localResponses,localRequests,mention,
   async close(){harbor.resetHarbor();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
 };
}
export async function eventually(check,message,limit=8000){
 const deadline=Date.now()+limit;
 while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}
 throw new Error(message);
}
