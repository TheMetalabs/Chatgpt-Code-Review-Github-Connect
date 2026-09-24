import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,json} from './load-source.mjs';
import {appFixture,eventually} from './app-fixture.mjs';
import {chatFixtureProxy} from './browser-proxy.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
// Fresh CDP attachment avoids a Playwright Worker retaining a destroyed context.
async function evaluateTarget(cdp,url,expression) {
 const {targetInfos}=await cdp.send('Target.getTargets');
 const target=targetInfos.find(target=>target.url===url&&['worker','service_worker'].includes(target.type));
 if(!target)throw new Error('worker target unavailable: '+url);
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
 let listener,timer;
 try {
  const result=await new Promise((resolve,reject)=>{
   listener=event=>{
    if(event.sessionId!==sessionId)return;
    const response=JSON.parse(event.message);
    if(response.id!==1)return;
    if(response.error)reject(new Error(response.error.message));else resolve(response.result);
   };
   cdp.on('Target.receivedMessageFromTarget',listener);
   timer=setTimeout(()=>reject(new Error('fixture CDP evaluation did not respond')),2000);
   cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})}).catch(reject);
  });
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
 } finally {
  clearTimeout(timer);cdp.off('Target.receivedMessageFromTarget',listener);
  await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});
 }
}

const envelope=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const html=`<!doctype html><html><body>
 <div id="turns"></div><form data-type="unified-composer" onsubmit="return false">
 <textarea id="prompt-textarea" style="width:500px;height:100px"></textarea>
 <button data-testid="send-button" aria-label="Send prompt" type="button">Send</button></form>
 <script>
 window.sends=0;
 document.querySelector('button').onclick=()=>{window.sends++;const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=document.querySelector('textarea').value;turn.append(user);document.querySelector('#turns').append(turn);document.querySelector('textarea').value='';};
 window.reply=(raw,done,code)=>{document.querySelector('#answer')?.remove();const turn=document.createElement('section');turn.id='answer';turn.dataset.testid='conversation-turn-2';const message=document.createElement('div');message.dataset.messageAuthorRole='assistant';const md=document.createElement('div');md.className='markdown';md.textContent=raw;if(code!==undefined){const pre=document.createElement('pre');const c=document.createElement('code');c.textContent=code;pre.append(c);md.append(pre);}message.append(md);turn.append(message);if(done){const button=document.createElement('button');button.dataset.testid='copy-turn-action-button';button.ariaLabel='Copy response';button.textContent='copy';turn.append(button);}document.querySelector('#turns').append(turn);};
 </script></body></html>`;

test('MV3 E2E: long queue → restart → final JSON ACK → close chat tab → one review',async t=>{
 const app=await appFixture();t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-e2e-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   // The disposable, local-fixture-only browser must allow its unpacked extension to reload.
   // This is a test launch setting; no installed browser profile or managed policy is changed.
   args:['--no-sandbox','--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(()=>context.close());
 // Set developer mode through Chrome's own UI in this newly created test profile.
 // Never alter managed policy or an existing user's browser preferences.
 const manager=await context.newPage();
 await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');
 await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 assert.equal(await developerMode.evaluate(el=>Boolean(el.checked)),true);
 await manager.close();
 const diagnostics=[];
 context.on('page',page=>{page.on('pageerror',error=>diagnostics.push(['pageerror',error.message]));page.on('console',msg=>{if(msg.type()==='error')diagnostics.push(['console',msg.text()]);});});
 context.on('requestfailed',request=>diagnostics.push(['requestfailed',request.url(),request.failure()?.errorText]));
 // The launch-level local proxy also intercepts the first extension-created tab request.
 // Explicit loopback bypass keeps bridge RPCs out of the external-destination proxy.
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true}),app.origin);
 const delivered=app.mention();assert.equal(delivered.queued,true);
 await eventually(()=>app.localRequests.length===1,'local generation not started');
 await worker.evaluate(()=>tick());
 try {
  await eventually(()=>context.pages().some(p=>p.url().startsWith('https://chatgpt.com/')),'chat tab missing');
 } catch(error) {
  console.error('tab diagnostics',JSON.stringify({events:diagnostics,requests:proxy.requests,pages:context.pages().map(p=>p.url()),storage:await worker.evaluate(()=>chrome.storage.local.get(null))}));
  throw error;
 }
 const page=context.pages().find(p=>p.url().startsWith('https://chatgpt.com/'));
 // The tab URL can be visible before its first document script has executed.
 try {
   await page.waitForFunction(()=>typeof window.sends==='number'&&typeof window.reply==='function',null,{timeout:8000});
 } catch(error) {
   console.error('fixture diagnostics',JSON.stringify({events:diagnostics,requests:proxy.requests,url:page.url(),html:(await page.content()).slice(0,3000),storage:await worker.evaluate(()=>chrome.storage.local.get(null))}));
   throw error;
 }
 await eventually(async()=>{await worker.evaluate(()=>tick());return page.evaluate(()=>window.sends===1);},'prompt was not submitted');
 let job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(job.storedLegs.length,0);
 app.clock.now+=365*24*3600_000;
 await worker.evaluate(()=>tick());
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId).status,'awaiting_chat');
 assert.equal(app.localRequests.length,1);assert.equal(await page.evaluate(()=>window.sends),1);
 // Reload the actual extension, then use a fresh DevTools attachment rather than
 // Playwright's cached Worker execution context (which can survive as a stale handle).
 const workerUrl=worker.url();
 const personalTab=await context.newPage();
 const cdp=await context.newCDPSession(personalTab);
 await worker.evaluate(()=>{globalThis.__fixtureBeforeReload=true;});
 await worker.evaluate(()=>chrome.runtime.reload()).catch(error=>diagnostics.push(['reload',error.message]));
 let lastProbe;
 try {
  await eventually(async()=>{
   try {
    lastProbe=await evaluateTarget(cdp,workerUrl,'({oldContext:Boolean(globalThis.__fixtureBeforeReload),tick:typeof tick})');
    return !lastProbe.oldContext&&lastProbe.tick==='function';
   } catch(error) {lastProbe={error:error.message};return false;}
  },'extension execution context did not restart');
 } catch(error) {
  console.error('reload diagnostics',JSON.stringify({lastProbe,events:diagnostics,targets:await cdp.send('Target.getTargets')}));
  throw error;
 }
 // Drive the real restarted worker, never a test replacement for its job state machine.
 worker={evaluate:fn=>evaluateTarget(cdp,workerUrl,`(${fn.toString()})()`)};
 await worker.evaluate(()=>tick());
 await page.evaluate(raw=>window.reply(raw,false),json);
 await new Promise(resolve=>setTimeout(resolve,1700));
 await worker.evaluate(()=>tick());
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.storedLegs.length,0);assert.equal(job.status,'awaiting_chat');
 assert.equal(await page.evaluate(()=>window.sends),1);
 // Local headers and partial JSON are not a completed response.
 app.localResponses[0].writeHead(200,{'content-type':'application/json'});app.localResponses[0].write('{"choices":');
 const promptSends=await page.evaluate(()=>window.sends);
 await page.evaluate(raw=>window.reply(raw,true),json);
 await eventually(async()=>{await worker.evaluate(()=>tick());return app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId).storedLegs.some(l=>l.provider==='chatgpt');},'final chat JSON was not stored');
 await eventually(async()=>{await worker.evaluate(()=>tick());return page.isClosed();},'acknowledged ChatGPT tab was not closed');
 assert.equal(personalTab.isClosed(),false,'unrelated user tab was closed');
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(job.storedLegs.some(l=>l.provider==='local'),false);
 assert.equal(app.reviews.length,0);
 assert.equal(app.ops.some(text=>/quota or empty reply|JSON not parsed|finished without JSON/.test(text)),false);
 app.localResponses[0].end(envelope(json).slice('{"choices":'.length));
 await eventually(()=>app.reviews.length===1,'final review not published to GitHub fixture');
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'posted');assert.equal(job.storedLegs.length,2);
 await worker.evaluate(()=>tick());assert.equal(app.localRequests.length,1);assert.equal(promptSends,1);assert.equal(page.isClosed(),true);assert.equal(app.reviews.length,1);
 if(process.env.REVIEW_EVIDENCE_DIR)await writeFile(join(process.env.REVIEW_EVIDENCE_DIR,'mv3-e2e.json'),JSON.stringify({status:job.status,localCalls:app.localRequests.length,promptSends,chatTabClosed:page.isClosed(),personalTabOpen:!personalTab.isClosed(),reviews:app.reviews.length,ops:app.ops},null,2));
});

test('production ingress E2E: PR open without mention performs no model work',async t=>{
 const app=await appFixture();t.after(()=>app.close());
 const out=app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'opened',event:'pull_request',payload:{action:'opened',installation:{id:1},repository:{full_name:'fixture/fixture'},pull_request:{number:1,head:{sha:'abc'},base:{sha:'def'}}}});
 assert.equal(out.queued,false);assert.equal(app.bridge.takeNextBridgeJob('fixture'),null);assert.equal(app.localRequests.length,0);
});

test('local-only E2E: pending until response ends, then a single final review',async t=>{
 const app=await appFixture({reviewChatgpt:false});t.after(()=>app.close());const out=app.mention();
 await eventually(()=>app.localRequests.length===1,'local-only generation missing');
 app.clock.now+=365*24*3600_000;
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId).status,'awaiting_chat');assert.equal(app.reviews.length,0);
 app.localResponses[0].end(envelope(json));await eventually(()=>app.reviews.length===1,'local-only review not published');
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===out.jobId).status,'posted');
});

test('MV3 parallel E2E: A pending → B admitted → worker restart → B posts/closes → C admitted',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-parallel-e2e-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(()=>context.close());
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 await manager.close();
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true,maxReviewTabs:2}),app.origin);
 const request=pr=>app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:'mv3-parallel-'+pr,event:'issue_comment',payload:{
   action:'created',installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'author'},
   issue:{number:pr,pull_request:{},title:'parallel '+pr},comment:{id:pr,body:'@ashlar-bot review'}}});
 const a=request(101);assert.equal(a.queued,true);
 let pageA;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageA=context.pages().find(p=>p.url().startsWith('https://chatgpt.com/'));return pageA&&pageA.evaluate(()=>window.sends===1).catch(()=>false);},'A did not start');
 const b=request(202);assert.equal(b.queued,true);
 let pageB;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageB=context.pages().find(p=>p!==pageA&&p.url().startsWith('https://chatgpt.com/'));return pageB&&pageB.evaluate(()=>window.sends===1).catch(()=>false);},'B was blocked by unfinished A');
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===a.jobId).status,'awaiting_chat');
 assert.equal(app.reviews.length,0);app.clock.now+=365*24*3600_000;
 const personal=await context.newPage(),cdp=await context.newCDPSession(personal),workerUrl=worker.url();
 await worker.evaluate(()=>{globalThis.__fixtureBeforeReload=true;});
 await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});
 await eventually(async()=>{
   try {const state=await evaluateTarget(cdp,workerUrl,'({old:Boolean(globalThis.__fixtureBeforeReload),tick:typeof tick})');return !state.old&&state.tick==='function';}
   catch{return false;}
 },'parallel worker failed to restart');
 worker={evaluate:fn=>evaluateTarget(cdp,workerUrl,`(${fn.toString()})()`)};
 await worker.evaluate(()=>tick());
 assert.equal(await pageA.evaluate(()=>window.sends),1);assert.equal(await pageB.evaluate(()=>window.sends),1);
 await pageB.evaluate(raw=>window.reply(raw,true),JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['B only']}));
 await eventually(async()=>{await worker.evaluate(()=>tick());return pageB.isClosed()&&app.reviews.length===1;},'B did not post and close independently');
 assert.equal(app.reviews[0].pr,202);assert.equal(pageA.isClosed(),false);assert.equal(personal.isClosed(),false);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===a.jobId).storedLegs.length,0);
 const c=request(303);assert.equal(c.queued,true);
 let pageC;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageC=context.pages().find(p=>p!==pageA&&p.url().startsWith('https://chatgpt.com/'));return pageC&&pageC.evaluate(()=>window.sends===1).catch(()=>false);},'freed B slot did not admit C');
 assert.equal(pageA.isClosed(),false);assert.equal(context.pages().filter(p=>p.url().startsWith('https://chatgpt.com/')).length,2);
 assert.equal(await pageA.evaluate(()=>window.sends),1);assert.equal(app.reviews.length,1);
});

test('MV3 fix E2E: a fix prompt is answered by its fenced JSON in a chat tab; a superseded fix tab is force-closed',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-fix-e2e-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(()=>context.close());
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 await manager.close();
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true}),app.origin);
 const chatPages=()=>context.pages().filter(p=>!p.isClosed()&&p.url().startsWith('https://chatgpt.com/'));
 const userText=p=>p.evaluate(()=>document.querySelector('[data-message-author-role="user"]')?.textContent||'');
 const request=(pr,prompt)=>app.bridge.requestBridgeFix({owner:'fixture',repo:'fixture',pr,provider:'chatgpt',prompt});
 // 1) The fix prompt reaches a chat tab; the answer's fenced JSON (literal code) is delivered, not review JSON.
 const answer='{"summary":"guard","files":[{"path":"a.ts","content":"export const answer = 43;\\n"}],"dispositions":[{"finding":"F1","action":"fixed","note":"guarded"}]}';
 let result;
 request(1,'FIX PROMPT for fixture#1: return the JSON object').then(value=>{result={value};},error=>{result={error};});
 assert.equal(app.bridge.getBridgePublic().pendingFixes,1);
 let page;
 await eventually(async()=>{await worker.evaluate(()=>tick());page=chatPages()[0];return page&&page.evaluate(()=>window.sends===1).catch(()=>false);},'fix prompt was not submitted');
 assert.match(await userText(page),/FIX PROMPT for fixture#1/);
 await page.evaluate(code=>window.reply('Guarded the null path.',true,code),answer);
 await eventually(async()=>{await worker.evaluate(()=>tick());return result!==undefined;},'fix answer was not delivered');
 assert.equal(result.error,undefined);assert.equal(result.value,answer);
 await eventually(async()=>{await worker.evaluate(()=>tick());return page.isClosed();},'answered fix tab was not closed');
 assert.equal(app.bridge.getBridgePublic().pendingFixes,0);
 assert.equal(app.reviews.length,0);assert.equal(app.harbor.getHarbor().jobs.length,0,'a fix is never a harbor review job');
 // 2) A newer request for the same PR supersedes a still-generating fix: that tab is force-closed.
 let firstError;
 request(2,'FIX PROMPT A for fixture#2').catch(error=>{firstError=error;});
 let pageA;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageA=chatPages()[0];return pageA&&pageA.evaluate(()=>window.sends===1).catch(()=>false);},'first fix prompt was not submitted');
 request(2,'FIX PROMPT B for fixture#2').catch(()=>{});
 await eventually(()=>firstError!==undefined,'the older fix was not superseded');
 assert.match(firstError.message,/superseded by a newer request for the same PR/);
 await eventually(async()=>{await worker.evaluate(()=>tick());return pageA.isClosed();},'superseded fix tab was not force-closed');
 let pageB;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageB=chatPages()[0];return pageB&&pageB.evaluate(()=>window.sends===1).catch(()=>false);},'the newer fix did not start');
 assert.match(await userText(pageB),/FIX PROMPT B for fixture#2/);
});
