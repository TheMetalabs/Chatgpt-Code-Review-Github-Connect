// Tab release (#82), real Chromium pages: once a review or fix leg's result is secured (or nobody
// wants it: cancelled / forgotten), its chat tab has no further use and is closed; the ONLY reason
// to keep it is positive evidence the user took it over (a follow-up turn, a draft that is not
// Ashlar's prompt, an edit of Ashlar's prompt, another conversation or site). ChatGPT's own redraws
// of the answer (a finishing code fence, labels, re-keyed ids, streaming flags) are not user activity.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {source} from './load-source.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});});
after(async()=>{await browser?.close();});

test('composer.js can be injected twice into one page (the worker re-injects on a lost receiver): the second copy is in effect',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<main></main>');
 await page.addScriptTag({content:source('extension/composer.js')});
 await page.evaluate(()=>{window.first={clickSend,fillComposer,waitUntilComposer};});
 await page.addScriptTag({content:source('extension/composer.js')});
 assert.deepEqual(errors,[],'a re-injected composer.js must not throw (a top-level const/let redeclaration aborts the whole script)');
 assert.deepEqual(await page.evaluate(()=>Object.entries(window.first).filter(([name,fn])=>globalThis[name]===fn).map(([name])=>name)),[],
  'the re-injected definitions replace the old ones, so new checks (the stop fence) apply to later calls');
});
