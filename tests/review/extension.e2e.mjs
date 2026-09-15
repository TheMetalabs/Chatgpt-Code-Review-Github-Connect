import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root,json} from './load-source.mjs';
import {appFixture,eventually} from './app-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const envelope=content=>JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]});
const html=`<!doctype html><html><body>
 <div id="turns"></div><form data-type="unified-composer" onsubmit="return false">
 <textarea id="prompt-textarea" style="width:500px;height:100px"></textarea>
 <button data-testid="send-button" aria-label="Send prompt" type="button">Send</button></form>
 <script>
 window.sends=0;
 document.querySelector('button').onclick=()=>{window.sends++;const turn=document.createElement('section');turn.dataset.testid='conversation-turn-1';const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=document.querySelector('textarea').value;turn.append(user);document.querySelector('#turns').append(turn);};
 window.reply=(raw,done)=>{document.querySelector('#answer')?.remove();const turn=document.createElement('section');turn.id='answer';turn.dataset.testid='conversation-turn-2';const message=document.createElement('div');message.dataset.messageAuthorRole='assistant';const md=document.createElement('div');md.className='markdown';md.textContent=raw;message.append(md);turn.append(message);if(done){const button=document.createElement('button');button.dataset.testid='copy-turn-action-button';button.ariaLabel='Copy response';button.textContent='copy';turn.append(button);}document.querySelector('#turns').append(turn);};
 </script></body></html>`;

test('MV3 E2E: mention → indefinite queue → restart → final JSON → one GitHub review',async t=>{
 const app=await appFixture();t.after(()=>app.close());
 const profile=await mkdtemp(join(tmpdir(),'ashlar-e2e-'));t.after(()=>rm(profile,{recursive:true,force:true}));
 const extension=join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,channel:process.env.CHROMIUM_PATH?undefined:'chromium',executablePath:process.env.CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],
   args:['--no-sandbox',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 t.after(()=>context.close());
 const diagnostics=[];
 context.on('page',page=>{page.on('pageerror',error=>diagnostics.push(['pageerror',error.message]));page.on('console',msg=>{if(msg.type()==='error')diagnostics.push(['console',msg.text()]);});});
 context.on('requestfailed',request=>diagnostics.push(['requestfailed',request.url(),request.failure()?.errorText]));
 await context.route('https://chatgpt.com/**',route=>{diagnostics.push(['fixture',route.request().url()]);return route.fulfill({status:200,contentType:'text/html',body:html});});
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await worker.evaluate(origin=>chrome.storage.local.set({origin,token:'fixture-token',enabled:true}),app.origin);
 const delivered=app.mention();assert.equal(delivered.queued,true);
 await eventually(()=>app.localRequests.length===1,'local generation not started');
 await worker.evaluate(()=>tick());
 await eventually(()=>context.pages().some(p=>p.url().startsWith('https://chatgpt.com/')),'chat tab missing');
 const page=context.pages().find(p=>p.url().startsWith('https://chatgpt.com/'));
 // The tab URL can be visible before its first document script has executed.
 try {
   await page.waitForFunction(()=>typeof window.sends==='number'&&typeof window.reply==='function',null,{timeout:8000});
 } catch(error) {
   console.error('fixture diagnostics',JSON.stringify({events:diagnostics,url:page.url(),html:(await page.content()).slice(0,3000),storage:await worker.evaluate(()=>chrome.storage.local.get(null))}));
   throw error;
 }
 await eventually(async()=>{await worker.evaluate(()=>tick());return page.evaluate(()=>window.sends===1);},'prompt was not submitted');
 let job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(job.storedLegs.length,0);
 app.clock.now+=365*24*3600_000;
 await worker.evaluate(()=>tick());
 assert.equal(app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId).status,'awaiting_chat');
 assert.equal(app.localRequests.length,1);assert.equal(await page.evaluate(()=>window.sends),1);
 // Reload the actual extension, not a mocked JS function; persistent task resumes original tab.
 const restarted=context.waitForEvent('serviceworker');
 await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});
 worker=await restarted;
 await worker.evaluate(()=>tick());
 await page.evaluate(raw=>window.reply(raw,false),json);
 await new Promise(resolve=>setTimeout(resolve,1700));
 await worker.evaluate(()=>tick());
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.storedLegs.length,0);assert.equal(job.status,'awaiting_chat');
 assert.equal(await page.evaluate(()=>window.sends),1);
 // Local headers and partial JSON are not a completed response.
 app.localResponses[0].writeHead(200,{'content-type':'application/json'});app.localResponses[0].write('{"choices":');
 await page.evaluate(raw=>window.reply(raw,true),json);
 await eventually(async()=>{await worker.evaluate(()=>tick());return app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId).storedLegs.some(l=>l.provider==='chatgpt');},'final chat JSON was not stored');
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'awaiting_chat');assert.equal(job.storedLegs.some(l=>l.provider==='local'),false);
 assert.equal(app.reviews.length,0);
 assert.equal(app.ops.some(text=>/quota or empty reply|JSON not parsed|finished without JSON/.test(text)),false);
 app.localResponses[0].end(envelope(json).slice('{"choices":'.length));
 await eventually(()=>app.reviews.length===1,'final review not published to GitHub fixture');
 job=app.harbor.getHarbor().jobs.find(j=>j.id===delivered.jobId);
 assert.equal(job.status,'posted');assert.equal(job.storedLegs.length,2);
 await worker.evaluate(()=>tick());assert.equal(app.localRequests.length,1);assert.equal(await page.evaluate(()=>window.sends),1);assert.equal(app.reviews.length,1);
 if(process.env.REVIEW_EVIDENCE_DIR)await writeFile(join(process.env.REVIEW_EVIDENCE_DIR,'mv3-e2e.json'),JSON.stringify({status:job.status,localCalls:app.localRequests.length,promptSends:await page.evaluate(()=>window.sends),reviews:app.reviews.length,ops:app.ops},null,2));
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
