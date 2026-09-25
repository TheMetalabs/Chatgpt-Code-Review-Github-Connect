import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
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

// The fixture proxy's throwaway chatgpt.com certificate is trusted by an SPKI pin at launch.
// Playwright's ignoreHTTPSErrors is sent to each page only after Playwright attaches to it, so a
// tab the extension creates can complete its TLS handshake first and land on the certificate
// interstitial (chrome-error://chromewebdata/), leaving its run undispatched. The pin applies
// browser-wide from startup and trusts exactly this fixture key.
const certificatePin=proxy=>`--ignore-certificate-errors-spki-list=${createHash('sha256').update(new X509Certificate(proxy.certificate).publicKey.export({type:'spki',format:'der'})).digest('base64')}`;

// The extension's service worker as a Playwright Worker. `manager` is chrome://extensions with
// developer mode on. Chromium can start the MV3 worker before Playwright's browser-level
// auto-attach and then never attach it: Target.getTargets lists it with attached:false and no
// 'serviceworker' event ever fires, so a plain waitForEvent times out. Reloading the unpacked
// extension in this fresh test profile (before any test state exists) starts a new worker target,
// which is auto-attached.
async function extensionWorker(context,manager) {
 const seen=context.waitForEvent('serviceworker').catch(error=>error);
 const attached=context.serviceWorkers()[0];
 if(attached)return attached;
 const cdp=await context.newCDPSession(manager);
 let targetInfos;
 try {({targetInfos}=await cdp.send('Target.getTargets'));} finally {await cdp.detach().catch(()=>{});}
 const orphan=targetInfos.find(target=>target.type==='service_worker'&&target.url.startsWith('chrome-extension://')&&!target.attached);
 if(!orphan){const worker=await seen;if(worker instanceof Error)throw worker;return worker;}
 const restarted=context.waitForEvent('serviceworker');
 await manager.evaluate(id=>new Promise(resolve=>chrome.developerPrivate.reload(id,{failQuietly:true},()=>resolve())),new URL(orphan.url).host);
 return restarted;
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
 const profile=await mkdtemp(join(tmpdir(),'ashlar-e2e-'));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   // The disposable, local-fixture-only browser must allow its unpacked extension to reload.
   // This is a test launch setting; no installed browser profile or managed policy is changed.
   args:['--no-sandbox','--enable-unsafe-extension-debugging',certificatePin(proxy),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 // node:test runs after-hooks in registration order: the profile is removed only once the browser
 // that writes to it has exited (removing it first races Chrome's writes: ENOTEMPTY).
 t.after(async()=>{await context.close();await rm(profile,{recursive:true,force:true});});
 // Set developer mode through Chrome's own UI in this newly created test profile.
 // Never alter managed policy or an existing user's browser preferences.
 const manager=await context.newPage();
 await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');
 await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 assert.equal(await developerMode.evaluate(el=>Boolean(el.checked)),true);
 let worker=await extensionWorker(context,manager);
 await manager.close();
 const diagnostics=[];
 context.on('page',page=>{page.on('pageerror',error=>diagnostics.push(['pageerror',error.message]));page.on('console',msg=>{if(msg.type()==='error')diagnostics.push(['console',msg.text()]);});});
 context.on('requestfailed',request=>diagnostics.push(['requestfailed',request.url(),request.failure()?.errorText]));
 // The launch-level local proxy also intercepts the first extension-created tab request.
 // Explicit loopback bypass keeps bridge RPCs out of the external-destination proxy.
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
 const profile=await mkdtemp(join(tmpdir(),'ashlar-parallel-e2e-'));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',certificatePin(proxy),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 // node:test runs after-hooks in registration order: the profile is removed only once the browser
 // that writes to it has exited (removing it first races Chrome's writes: ENOTEMPTY).
 t.after(async()=>{await context.close();await rm(profile,{recursive:true,force:true});});
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 let worker=await extensionWorker(context,manager);
 await manager.close();
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

test('MV3 fix E2E: a fix prompt is answered by its fenced JSON in a chat tab; a superseded fix tab is preserved, never closed',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-fix-e2e-'));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',certificatePin(proxy),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 // node:test runs after-hooks in registration order: the profile is removed only once the browser
 // that writes to it has exited (removing it first races Chrome's writes: ENOTEMPTY).
 t.after(async()=>{await context.close();await rm(profile,{recursive:true,force:true});});
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 const worker=await extensionWorker(context,manager);
 await manager.close();
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
 // 2) A newer request for the same PR supersedes a still-generating fix: that tab is PRESERVED (a
 // fix tab is closed only on the proven-success path), its managed slot released, its leg retired.
 let firstError;
 request(2,'FIX PROMPT A for fixture#2').catch(error=>{firstError=error;});
 let pageA;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageA=chatPages()[0];return pageA&&pageA.evaluate(()=>window.sends===1).catch(()=>false);},'first fix prompt was not submitted');
 const pending=()=>worker.evaluate(async()=>(await chrome.storage.local.get('pendingReviewJobs')).pendingReviewJobs||{});
 const jobA=Object.keys(await pending()).find(id=>id.startsWith('fix-'));
 assert.ok(jobA,'the first fix is a worker job');
 request(2,'FIX PROMPT B for fixture#2').catch(()=>{});
 await eventually(()=>firstError!==undefined,'the older fix was not superseded');
 assert.match(firstError.message,/superseded by a newer request for the same PR/);
 await eventually(async()=>{await worker.evaluate(()=>tick());return !(jobA in await pending());},'the superseded fix leg did not retire');
 assert.equal(pageA.isClosed(),false,'the superseded fix tab is preserved, never closed');
 await eventually(()=>worker.evaluate(async id=>{
  await refreshTabInventory();
  const report=await tabCapacityReport((await chrome.storage.local.get('pendingReviewJobs')).pendingReviewJobs||{});
  return report.orphanTabs===0 && !report.blockers.some(blocker=>blocker.jobId===id);
 },jobA),'the preserved fix tab still holds a managed slot');
 let pageB;
 await eventually(async()=>{await worker.evaluate(()=>tick());pageB=chatPages().find(p=>p!==pageA);return pageB&&pageB.evaluate(()=>window.sends===1).catch(()=>false);},'the newer fix did not start');
 assert.match(await userText(pageB),/FIX PROMPT B for fixture#2/);
 assert.equal(await pageA.evaluate(()=>window.sends),1,'the preserved tab is never sent anything again');
});

// #93 through the real unpacked extension: a chatgpt fix (review-loop-runtime requestChatFix)
// reaches the tab as its typed line plus its one hashed attachment. The fixture composer collapses
// typed whitespace like the real one; the upload input records the bytes and renders a named chip.
const attachHtml=`<!doctype html><html><body>
 <div id="turns"></div><form data-type="unified-composer" onsubmit="return false">
 <input type="file" multiple><div id="chips"></div>
 <textarea id="prompt-textarea" style="width:500px;height:100px"></textarea>
 <button data-testid="send-button" aria-label="Send prompt" type="button">Send</button></form>
 <script>
 window.sends=0;window.uploads=[];
 const composer=document.querySelector('textarea');
 composer.addEventListener('input',()=>{composer.value=composer.value.replace(/\\s+/g,' ');});
 document.querySelector('input[type=file]').addEventListener('change',async event=>{for(const file of event.target.files){
  window.uploads.push({name:file.name,text:await file.text()});
  const chip=document.createElement('div');chip.dataset.fileName=file.name;chip.style.cssText='width:80px;height:20px';chip.textContent=file.name;document.querySelector('#chips').append(chip);}});
 document.querySelector('button').onclick=()=>{window.sends++;const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';const user=document.createElement('div');user.dataset.messageAuthorRole='user';
  // the sent turn shows the file as ChatGPT does: a card with its name and type, then the typed line
  for(const chip of document.querySelectorAll('#chips [data-file-name]'))user.insertAdjacentHTML('beforeend','<div class="file-card"><div class="truncate">'+chip.dataset.fileName+'</div><div>Document</div></div>');
  const text=document.createElement('div');text.className='whitespace-pre-wrap';text.textContent=composer.value;user.append(text);
  turn.append(user);document.querySelector('#turns').append(turn);composer.value='';document.querySelector('#chips').replaceChildren();};
 window.reply=(raw,done,code)=>{document.querySelector('#answer')?.remove();const turn=document.createElement('section');turn.id='answer';turn.dataset.testid='conversation-turn-2';const message=document.createElement('div');message.dataset.messageAuthorRole='assistant';const md=document.createElement('div');md.className='markdown';md.textContent=raw;if(code!==undefined){const pre=document.createElement('pre');const c=document.createElement('code');c.textContent=code;pre.append(c);md.append(pre);}message.append(md);turn.append(message);if(done){const button=document.createElement('button');button.dataset.testid='copy-turn-action-button';button.ariaLabel='Copy response';button.textContent='copy';turn.append(button);}document.querySelector('#turns').append(turn);};
 </script></body></html>`;

test('MV3 fix E2E (#93): the fix source is uploaded byte-exact as its hashed attachment; a whitespace-collapsing composer still sends the typed line',async t=>{
 const {requestChatFix,CHAT_FIX_FENCE_RULE}=await import('../../src/lib/review-loop-runtime.server.ts');
 const {DEFAULT_SETTINGS}=await import('../../src/lib/types.ts');
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-fixatt-e2e-'));
 const proxy=await chatFixtureProxy(attachHtml);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',certificatePin(proxy),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(async()=>{await context.close();await rm(profile,{recursive:true,force:true});});
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 const worker=await extensionWorker(context,manager);
 await manager.close();
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true}),app.origin);
 const chatPages=()=>context.pages().filter(p=>!p.isClosed()&&p.url().startsWith('https://chatgpt.com/'));
 const source='Fix F1.\nFILE "src/a.py"\nCONTENT "def f(x):\\n\\tif x:\\n\\t\\treturn \\"a  b\\"\\n"\n\n\n    pass  # two  spaces';
 const settings={...DEFAULT_SETTINGS,fixAgent:{...DEFAULT_SETTINGS.fixAgent,enabled:true,provider:'chatgpt',delivery:'script-apply',mode:'suggest'}};
 let result;
 requestChatFix(settings,{owner:'fixture',repo:'fixture',pr:1},'chatgpt',source,{loadBridge:async()=>app.bridge})
  .then(value=>{result={value};},error=>{result={error};});
 let page;
 await eventually(async()=>{await worker.evaluate(()=>tick());page=chatPages()[0];return page&&page.evaluate(()=>window.sends===1).catch(()=>false);},'fix prompt was not submitted');
 const expected=`${source}\n\n${CHAT_FIX_FENCE_RULE}`;
 const sha=createHash('sha256').update(expected,'utf8').digest('hex');
 const uploads=await page.evaluate(()=>window.uploads);
 assert.deepEqual(uploads,[{name:'ashlar-fix-request.txt',text:expected}],'one upload: the whole request, byte-exact');
 const typed=await page.evaluate(()=>document.querySelector('[data-message-author-role="user"] .whitespace-pre-wrap').textContent);
 assert.ok(typed.includes(`SHA-256 ${sha}`),typed);
 assert.equal(typed,typed.replace(/\s+/g,' ').trim(),'one canonical line');
 assert.ok(!typed.includes('def f(x)'),'no source in the typed body');
 const answer='{"summary":"s","files":[],"dispositions":[{"finding":"F1","action":"decline","note":"n"}]}';
 await page.evaluate(code=>window.reply('Done.',true,code),answer);
 await eventually(async()=>{await worker.evaluate(()=>tick());return result!==undefined;},'fix answer was not delivered');
 assert.equal(result.error,undefined,String(result.error));assert.equal(result.value,answer);
});

// ── Tab release (#82) with the real unpacked extension. The worker's own scheduling (its 2.5 s
// interval, alarm and poll-now all call the global `tick`) is gated so the test decides when the
// real tick body runs; nothing else about the worker, the content scripts or the bridge is replaced.
const releaseHtml=`<!doctype html><html><body>
 <main id="turns"></main><form data-type="unified-composer" onsubmit="return false">
 <textarea id="prompt-textarea" style="width:500px;height:100px"></textarea>
 <button id="send" data-testid="send-button" aria-label="Send prompt" type="button">Send</button></form>
 <script>
 window.sends=0;
 document.querySelector('#send').onclick=()=>{window.sends++;const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';
  const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='user-1';user.textContent=document.querySelector('textarea').value;
  turn.append(user);document.querySelector('#turns').append(turn);document.querySelector('textarea').value='';};
 window.ensureAnswer=()=>{let turn=document.querySelector('#answer');if(turn)return turn;
  turn=document.createElement('section');turn.id='answer';turn.dataset.testid='conversation-turn-2';
  turn.innerHTML='<div data-message-author-role="assistant" data-message-id="asst-1"><div class="markdown"><p>Review below.</p><pre><div>JSON</div><div><code id="code"></code></div></pre></div></div>';
  document.querySelector('#turns').append(turn);return turn;};
 // Generating: Stop visible, no response actions.
 window.stream=text=>{window.ensureAnswer();document.querySelector('#code').textContent=text;
  if(!document.querySelector('#stop')){const s=document.createElement('button');s.id='stop';s.type='button';s.dataset.testid='stop-button';s.ariaLabel='Stop streaming';s.textContent='stop';s.style.cssText='width:32px;height:32px';document.querySelector('form').append(s);}};
 // As ChatGPT ends a stream: Stop goes and the action bar mounts while the code block still ends in a
 // partial closing fence, and a few no-text commits follow; reveal() then draws the rest of the fence.
 window.finish=(raw,tail)=>{window.ensureAnswer();document.querySelector('#code').textContent=raw+tail;
  document.querySelector('#stop')?.remove();
  const bar=document.createElement('div');bar.setAttribute('aria-label','Response actions');bar.setAttribute('role','group');
  bar.innerHTML='<button data-testid="copy-turn-action-button" aria-label="Copy response" style="width:32px;height:32px">c</button>';
  document.querySelector('#answer').append(bar);
  let n=0;const id=setInterval(()=>{bar.classList.toggle('commit-'+(n%2));if(++n>=4)clearInterval(id);},15);};
 window.reveal=raw=>{document.querySelector('#code').textContent=raw;};
 </script></body></html>`;
async function gatedExtension(t,app,html) {
 const profile=await mkdtemp(join(tmpdir(),'ashlar-release-e2e-'));
 const proxy=await chatFixtureProxy(html);t.after(()=>proxy.close());
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,proxy:{server:proxy.server,bypass:'127.0.0.1,localhost'},ignoreHTTPSErrors:true,
   channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox','--enable-unsafe-extension-debugging',certificatePin(proxy),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(async()=>{await context.close();await rm(profile,{recursive:true,force:true});});
 const manager=await context.newPage();await manager.goto('chrome://extensions');
 const developerMode=manager.locator('#devMode');await developerMode.waitFor({state:'visible'});
 assert.equal(await developerMode.evaluate(el=>Boolean(el.disabled)),false,'test browser developer mode is policy-controlled');
 if(!await developerMode.evaluate(el=>Boolean(el.checked)))await developerMode.click();
 const worker=await extensionWorker(context,manager);
 await manager.close();
 await worker.evaluate(()=>{globalThis.__realTick=tick;tick=async()=>{};});
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true,maxReviewTabs:4}),app.origin);
 const chatPages=()=>context.pages().filter(p=>!p.isClosed()&&p.url().startsWith('https://chatgpt.com/'));
 return {context,worker,chatPages,tick:()=>worker.evaluate(()=>__realTick())};
}
let mentions=0;
const request=(app,pr)=>{const id=++mentions;return app.harbor.ingestGitHubWebhook({hmacOk:true,deliveryId:`release-${pr}-${id}`,event:'issue_comment',payload:{action:'created',installation:{id:1},
 repository:{full_name:'fixture/fixture'},sender:{login:'author'},issue:{number:pr,pull_request:{},title:'release '+pr},comment:{id:9000+id,body:'@ashlar-bot review'}}});};
const historyStages=(app,jobId)=>(app.history.getJob(jobId,true)?.steps||[]).filter(s=>s.provider==='chatgpt').map(s=>`${s.source}:${s.stage}`);

test('MV3 tab release: ChatGPT finishing the code fence after collection no longer keeps the posted review\'s tab open',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const {chatPages,tick}=await gatedExtension(t,app,releaseHtml);
 const req=request(app,501);assert.equal(req.queued,true);
 let page;
 await eventually(async()=>{await tick();page=chatPages()[0];return page&&page.evaluate(()=>window.sends===1).catch(()=>false);},'prompt was not submitted',15000);
 const raw=JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture checked']},null,2);
 await page.evaluate(()=>window.stream('{\n  "findings": ['));
 await tick();
 await page.evaluate(raw=>window.finish(raw,'\n`'),raw);
 // The page collects (its step journal is shared session storage) before the fence finishes; the
 // worker asks only after that, as in the field (collection -> can-close 0.5-3.7 s).
 await eventually(()=>page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('ashlar:steps:'))
  .some(k=>JSON.parse(sessionStorage.getItem(k)).events.some(e=>e.stage==='response_collected'))),'the page did not collect its answer',5000);
 await page.evaluate(raw=>window.reveal(raw),raw);
 await eventually(async()=>{await tick();return app.reviews.length===1&&page.isClosed();},'the posted review\'s tab was not closed',15000);
 const original=app.history.getJob(req.jobId,true)?.responses?.chatgpt?.original||'';
 assert.ok(original.endsWith('}\n`'),`the race happened: the collected original still ends in the partial fence (${JSON.stringify(original.slice(-4))})`);
 const stages=historyStages(app,req.jobId);
 assert.ok(stages.includes('worker:tab_closed'),`closed in history: ${stages}`);
 assert.equal(stages.includes('worker:tab_preserved'),false);
});

test('MV3 tab release: a still-generating review superseded by a new mention closes its tab at once; the new review starts',async t=>{
 const app=await appFixture({reviewLocal:false});t.after(()=>app.close());
 const {worker,chatPages,tick}=await gatedExtension(t,app,releaseHtml);
 const first=request(app,601);assert.equal(first.queued,true);
 let old;
 await eventually(async()=>{await tick();old=chatPages()[0];return old&&old.evaluate(()=>window.sends===1).catch(()=>false);},'first prompt was not submitted',15000);
 await old.evaluate(()=>window.stream('{\n  "findings": ['));
 await tick();
 const second=request(app,601);assert.equal(second.queued,true);
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===first.jobId)?.status,'cancelled','the new mention superseded the generating review');
 await eventually(async()=>{await tick();return old.isClosed();},'the superseded review\'s tab was not closed',15000);
 const jobs=await worker.evaluate(()=>chrome.storage.local.get('pendingReviewJobs').then(s=>Object.keys(s.pendingReviewJobs||{})));
 assert.equal(jobs.includes(first.jobId),false,'the superseded job retired');
 let next;
 await eventually(async()=>{await tick();next=chatPages().find(p=>p!==old);return next&&next.evaluate(()=>window.sends===1).catch(()=>false);},'the new review did not start',15000);
 assert.equal(chatPages().length,1,'only the new review\'s tab is open');
 const stages=historyStages(app,first.jobId);
 assert.ok(stages.includes('page:cancelled')&&stages.includes('worker:tab_closed'),`the stop and the close reach history: ${stages}`);
});
