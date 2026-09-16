// Real React/Chromium component; backend I/O is controlled. Production HTTP is tested separately.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {root} from './helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser,bundle;
before(async()=>{
 const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {HistoryBrowser} from './src/components/history-browser';createRoot(document.getElementById('root')).render(<HistoryBrowser/>);`,loader:'tsx',resolveDir:root},absWorkingDir:root,alias:{'@':resolve(root,'src')},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'}});
 bundle=result.outputFiles[0].text;browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();});
const record={job:{id:'job-A',owner:'fixture',repo:'repo',pr:219,status:'posted',createdAt:1,deliveryId:'delivery-A',commentId:42,findingCount:0},inCurrentRuntime:false,droppedSteps:0,steps:[{id:'s',stage:'send_unconfirmed',source:'page',at:2,runId:'run-A'}],review:{githubId:55,event:'COMMENT',at:3,body:'Posted review body'}};
test('history UI: authenticated search, archived timeline and inert original text',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());let requests=0;
 await context.route('https://history.fixture/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script>'+bundle.replace(/<\/script/gi,'<\\/script')+'</script>'});
  if(url.pathname!=='/api/history')return route.fulfill({status:404,body:''});
  requests++;assert.equal(request.headers()['x-ashlar-history-token'],'fixture-token');assert.equal(url.searchParams.has('token'),false);
  const body=url.searchParams.has('jobId')?{ok:true,record:{...record,...(url.searchParams.has('responses')?{responses:{chatgpt:{json:'{"findings":[]}',original:'<script>window.exfiltrated=true</script>',jsonChars:15,originalChars:40,truncated:false}}}:{})}}:
   {ok:true,items:[record.job],total:1,nextCursor:null,health:{ok:true,retentionDays:30}};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 const page=await context.newPage();await page.goto('https://history.fixture/');assert.equal(requests,0);
 await page.getByLabel('History access token').fill('fixture-token');await page.getByRole('button',{name:'Open private history'}).click();
 await page.getByRole('button',{name:'job-A',exact:true}).click();await page.getByText('Archived record;', {exact:false}).waitFor();
 await page.getByRole('button',{name:'Load original response / JSON'}).click();await page.getByText('Original rendered response',{exact:true}).waitFor({state:'attached'});
 assert.equal(await page.evaluate(()=>window.exfiltrated),undefined);assert.equal(await page.locator('body').innerText().then(x=>x.includes('fixture-token')),false);
 await page.getByRole('button',{name:'Lock history'}).click();assert.equal(await page.getByText('Job timeline · job-A',{exact:true}).count(),0);
});
