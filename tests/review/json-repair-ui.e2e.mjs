import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {root} from './helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser,bundle;
before(async()=>{
 const temporary=await mkdtemp(resolve(root,'.repair-ui-fixture-'));
 try{
  const entry=resolve(temporary,'entry.jsx');
  await writeFile(entry,`import {createRoot} from 'react-dom/client';import {Settings} from '@/routes/settings';import {HistoryBrowser} from '@/components/history-browser';import {useAshlar} from '@/lib/store';import {DEFAULT_SETTINGS} from '@/lib/types';useAshlar.setState({settings:{...DEFAULT_SETTINGS,...(window.repairFlag===undefined?{}:{localJsonRepairEnabled:window.repairFlag})}});createRoot(document.getElementById('root')).render(location.search.includes('settings')?<Settings/>:<HistoryBrowser/>);`);
  const result=await build({root,configFile:false,envFile:false,publicDir:false,logLevel:'warn',plugins:[react()],resolve:{alias:{'@':resolve(root,'src')}},define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry,name:'RepairUIFixture',formats:['iife'],fileName:'repair-ui-fixture'}}});
  const chunks=[].concat(result).flatMap(out=>out.output).filter(out=>out.type==='chunk');assert.equal(chunks.length,1);bundle=chunks[0].code;
 }finally{await rm(temporary,{recursive:true,force:true});}
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
});
after(async()=>browser?.close());
test('Settings UI: repair defaults ON, saved OFF survives reload and does not change reviewer flags',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());let flag,submitted;
 await context.route('https://repair.fixture/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<div id="root"></div><script>window.repairFlag=${JSON.stringify(flag) || 'undefined'};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  if(url.pathname==='/api/harbor') {submitted=route.request().postDataJSON();flag=submitted.localJsonRepairEnabled;return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}
  return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
 });
 const page=await context.newPage();await page.goto('https://repair.fixture/?settings');const toggle=page.getByRole('button',{name:/파싱 실패 시 Local LLM으로 JSON 복구/});
 assert.equal(await toggle.getAttribute('aria-pressed'),'true');await toggle.click();await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(submitted.localJsonRepairEnabled,false);assert.equal(submitted.reviewChatgpt,true);assert.equal(submitted.reviewLocal,false);
 await page.reload();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
});
test('History UI: repair status visible, originals and candidates only after protected load and remain inert',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());const metadata={id:'repair-A',jobId:'A',provider:'chatgpt',runId:'run-A',responseId:'response-A',sourceHash:'a'.repeat(64),schemaVersion:'review-format-1',schema:'review',headSha:'abc',model:'formatter',status:'needs_attention',attempts:1,createdAt:1,updatedAt:2,errors:['original_content_not_preserved']};
 const job={id:'A',owner:'fixture',repo:'repo',pr:1,status:'awaiting_chat'};
 await context.route('https://repair.fixture/**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<div id="root"></div><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  assert.equal(req.headers()['x-ashlar-history-token'],'history-fixture');assert.equal(url.searchParams.has('token'),false);
  const details={job,inCurrentRuntime:true,steps:[],droppedSteps:0,repairs:[{...metadata,...(url.searchParams.has('responses')?{original:'PRIVATE ORIGINAL',candidate:'<script>window.injected=true</script>'}:{})}]};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.has('jobId')?{ok:true,record:details}:{ok:true,items:[job],total:1,health:{ok:true},nextCursor:null})});
 });
 const page=await context.newPage();await page.goto('https://repair.fixture/');await page.getByLabel('History access token').fill('history-fixture');await page.getByRole('button',{name:'Open private history'}).click();await page.getByRole('button',{name:'A',exact:true}).click();
 await page.getByText('Local JSON repair',{exact:true}).waitFor();assert.equal(await page.getByText('PRIVATE ORIGINAL',{exact:true}).count(),0);
 await page.getByRole('button',{name:'Load original response / JSON'}).click();await page.getByText('PRIVATE ORIGINAL',{exact:true}).waitFor({state:'attached'});
 assert.equal(await page.evaluate(()=>window.injected),undefined);await page.getByRole('button',{name:'Lock history'}).click();assert.equal(await page.getByText('PRIVATE ORIGINAL',{exact:true}).count(),0);
});
