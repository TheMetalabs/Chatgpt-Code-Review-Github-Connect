// Settings UI for the fix agent / review loop: the section is the loop's only switch. It starts
// OFF, validates before posting, and sends the whole fixAgent block through the settings API.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {root} from './helpers.mjs';
import {FIX_AGENT_KNOBS} from '../../src/lib/types.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser,bundle;
before(async()=>{
 const temporary=await mkdtemp(resolve(root,'.fix-agent-ui-fixture-'));
 try{
  const entry=resolve(temporary,'entry.jsx');
  await writeFile(entry,`import {createRoot} from 'react-dom/client';import {Settings} from '@/routes/settings';import {useAshlar} from '@/lib/store';import {DEFAULT_SETTINGS} from '@/lib/types';useAshlar.setState({settings:{...DEFAULT_SETTINGS,...(window.savedFix?{fixAgent:window.savedFix}:{})}});createRoot(document.getElementById('root')).render(<Settings/>);`);
  const result=await build({root,configFile:false,envFile:false,publicDir:false,logLevel:'warn',plugins:[react()],resolve:{alias:{'@':resolve(root,'src')}},define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry,name:'FixAgentUIFixture',formats:['iife'],fileName:'fix-agent-ui-fixture'}}});
  const chunks=[].concat(result).flatMap(out=>out.output).filter(out=>out.type==='chunk');assert.equal(chunks.length,1);bundle=chunks[0].code;
 }finally{await rm(temporary,{recursive:true,force:true});}
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
});
after(async()=>browser?.close());

test('Settings UI: the review loop is OFF by default, validated, and saved from the Settings screen',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());
 let savedFix,posts=[];
 await context.route('https://fix-agent.fixture/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>window.savedFix=${JSON.stringify(savedFix)||'undefined'};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  if(url.pathname==='/api/harbor'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();posts.push(body);
   // The server normalizes and answers with what it saved (here: parallelPrs clamped to 20).
   savedFix={...body.fixAgent,parallelPrs:Math.min(20,body.fixAgent.parallelPrs)};
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,settings:{fixAgent:savedFix}})});
  }
  return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
 });
 const page=await context.newPage();page.on('pageerror',error=>console.error('Fix agent UI fixture page error:',error.message));
 await page.goto('https://fix-agent.fixture/');
 const section=page.getByRole('region',{name:'Fix agent / review loop'});
 await section.waitFor();
 assert.match(await section.getByRole('note').innerText(),/Experimental/);
 const enabled=section.getByRole('button',{name:'fix_agent.enabled'});
 assert.equal(await enabled.getAttribute('aria-pressed'),'false','default: OFF');
 assert.equal(await section.getByLabel('fix_agent.provider').inputValue(),'','default: no provider');
 await section.getByText('Loop OFF (default)',{exact:false}).waitFor();
 const provider=section.getByLabel('fix_agent.provider');
 assert.deepEqual(await provider.locator('option').evaluateAll(os=>os.map(o=>o.value)),['','chatgpt','grok','local'],'only wired providers are offered');
 assert.deepEqual(await section.getByLabel('fix_agent.delivery').locator('option').evaluateAll(os=>os.map(o=>o.value)),['script-apply'],'only the wired delivery');
 const save=page.getByRole('button',{name:'Save settings',exact:true});

 // Enabled without a provider: refused on the page, nothing posted.
 await enabled.click();
 await save.click();
 await page.getByText('choose a fix provider to enable the review loop',{exact:true}).waitFor();
 assert.equal(posts.length,0);

 // An out-of-range number: refused on the page (the input's own bounds, then the section's check),
 // nothing posted.
 await provider.selectOption('grok');
 const attempts=section.getByLabel('fix_agent.attempts');
 await attempts.fill('9');
 await save.click();
 assert.equal(await attempts.evaluate(input=>input.validity.rangeOverflow),true);
 await page.locator('form').evaluate(form=>{form.noValidate=true;}); // past the browser check: the page's own
 await save.click();
 await page.getByText(/fix_agent\.attempts must be a whole number from 1 to 5/).waitFor();
 assert.equal(posts.length,0);
 await page.locator('form').evaluate(form=>{form.noValidate=false;});

 // A valid configuration is posted as one fixAgent block (minutes → ms).
 await section.getByLabel('fix_agent.attempts').fill('3');
 await section.getByLabel('fix_agent.mode').selectOption('apply');
 await section.getByLabel('fix_agent.round_cap').fill('4');
 await section.getByLabel('fix_agent.chat_timeout_minutes').fill('45');
 await section.getByLabel('fix_agent.parallel_prs').fill('20');
 await save.click();
 await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(posts.length,1);
 assert.deepEqual(posts[0].fixAgent,{enabled:true,provider:'grok',delivery:'script-apply',mode:'apply',parallelPrs:20,roundCap:4,attempts:3,
  timeoutMs:60*60_000,queueMaxMs:6*60*60_000,chatTimeoutMs:45*60_000,chatMaxPromptChars:100_000});
 await section.getByText('Loop ON: Grok (Chrome bridge) fixes, mode apply.',{exact:true}).waitFor();

 // A reload shows the saved state; switching OFF is one toggle + save.
 await page.reload();
 assert.equal(await enabled.getAttribute('aria-pressed'),'true');
 assert.equal(await section.getByLabel('fix_agent.round_cap').inputValue(),'4');
 await enabled.click();await save.click();await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(posts.at(-1).fixAgent.enabled,false);
 assert.equal(posts.at(-1).fixAgent.provider,'grok','turning the loop off keeps the chosen provider');
});

test('Settings UI: a legacy delivery cannot be switched on, and a server-side save failure is shown, not reported as saved',async t=>{
 const context=await browser.newContext();t.after(()=>context.close());
 // Hydrated from a pre-#77 save: chat-push is a stored value the runtime refuses.
 let savedFix={enabled:false,provider:'chatgpt',delivery:'chat-push',mode:'suggest',parallelPrs:3,roundCap:5,attempts:2,
  timeoutMs:60*60_000,queueMaxMs:6*60*60_000,chatTimeoutMs:30*60_000,chatMaxPromptChars:100_000};
 const posts=[];let failPersist=false;
 await context.route('https://fix-agent.fixture/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>window.savedFix=${JSON.stringify(savedFix)};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  if(url.pathname==='/api/harbor'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();posts.push(body);
   if(failPersist)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'could not save settings: .data/ashlar-settings.json is not writable (ENOTDIR); nothing was changed'})});
   savedFix=body.fixAgent;
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,settings:{fixAgent:savedFix}})});
  }
  return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
 });
 const page=await context.newPage();page.on('pageerror',error=>console.error('Fix agent UI fixture page error:',error.message));
 await page.goto('https://fix-agent.fixture/');
 const section=page.getByRole('region',{name:'Fix agent / review loop'});
 await section.waitFor();
 const delivery=section.getByLabel('fix_agent.delivery');
 assert.equal(await delivery.inputValue(),'chat-push','the stored legacy value stays visible');
 assert.deepEqual(await delivery.locator('option').evaluateAll(os=>os.map(o=>[o.value,o.disabled])),[['script-apply',false],['chat-push',true]]);
 const enabled=section.getByRole('button',{name:'fix_agent.enabled'});
 const save=page.getByRole('button',{name:'Save settings',exact:true});
 await enabled.click();
 await section.getByText(/Loop stays OFF: fix_agent\.delivery chat-push is not wired yet/).waitFor();
 await save.click();
 await page.getByText(/^fix_agent\.delivery chat-push is not wired yet: choose script-apply to enable the review loop$/).waitFor();
 assert.equal(posts.length,0,'rejected on the page: nothing posted');
 await delivery.selectOption('script-apply');
 await save.click();
 await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(posts.length,1);
 assert.deepEqual([posts[0].fixAgent.enabled,posts[0].fixAgent.provider,posts[0].fixAgent.delivery],[true,'chatgpt','script-apply']);
 await section.getByText('Loop ON: ChatGPT (Chrome bridge) fixes, mode suggest.',{exact:true}).waitFor();
 // The server cannot persist: its error is shown, the page does not claim "Saved", and a reload
 // reads the last successful save (still ON).
 failPersist=true;
 await enabled.click();
 await save.click();
 await page.getByText(/could not save settings: .*not writable/).waitFor();
 assert.equal(await page.getByText('Saved',{exact:true}).count(),0);
 assert.equal(posts.at(-1).fixAgent.enabled,false);
 await page.reload();
 assert.equal(await section.getByRole('button',{name:'fix_agent.enabled'}).getAttribute('aria-pressed'),'true');
});

// One validity domain (settings-rules): the minutes inputs represent every server-valid ms value.
// Before: step=1 minutes inputs made a stored 90000 ms (1.5 min) fail the browser's stepMismatch,
// which blocked EVERY save from the page, whatever field the operator changed.
test('Settings UI: a stored 90000 ms deadline (1.5 min) does not block an unrelated save, and every ms input takes any whole-ms value',async t=>{
 const rules=await import('../../src/lib/settings-rules.ts');
 const context=await browser.newContext();t.after(()=>context.close());
 let savedFix={enabled:false,provider:'grok',delivery:'script-apply',mode:'suggest',parallelPrs:3,roundCap:5,attempts:2,
  timeoutMs:90_000,queueMaxMs:6*60*60_000,chatTimeoutMs:90_000,chatMaxPromptChars:100_000};
 const posts=[];
 await context.route('https://fix-agent.fixture/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>window.savedFix=${JSON.stringify(savedFix)};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  if(url.pathname==='/api/harbor'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();posts.push(body);savedFix=body.fixAgent;
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,settings:{fixAgent:savedFix}})});
  }
  return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
 });
 const page=await context.newPage();page.on('pageerror',error=>console.error('Fix agent UI fixture page error:',error.message));
 await page.goto('https://fix-agent.fixture/');
 const section=page.getByRole('region',{name:'Fix agent / review loop'});
 await section.waitFor();
 const save=page.getByRole('button',{name:'Save settings',exact:true});
 for(const label of ['fix_agent.timeout_minutes','fix_agent.chat_timeout_minutes']){
  const input=section.getByLabel(label);
  assert.equal(await input.inputValue(),'1.5',label);
  assert.deepEqual(await input.evaluate(i=>[i.validity.valid,i.validity.stepMismatch]),[true,false],`${label}: 1.5 min is valid`);
 }
 // An unrelated change + save: posted, saved, and the 90000 ms values preserved.
 await page.getByRole('button',{name:'skip_forks',exact:true}).click();
 await save.click();
 await page.getByText('Saved',{exact:true}).waitFor();
 assert.equal(posts.length,1,'the save was not blocked');
 assert.equal(posts[0].skipForks,false);
 assert.equal(posts[0].fixAgent.timeoutMs,90_000);
 assert.equal(posts[0].fixAgent.chatTimeoutMs,90_000);

 // Every numeric input renders the domain settings-rules derives (not hand-written bounds).
 for(const f of rules.FIX_KNOB_FIELDS){
  const attrs=rules.formAttrs(rules.fixKnobDomain(f.key));
  const input=section.getByLabel(f.label);
  assert.deepEqual(await input.evaluate(i=>[i.min,i.max,i.step]),[String(attrs.min),String(attrs.max),String(attrs.step)],f.key);
 }
 // Boundaries for every ms field: min, max and odd whole-ms values are valid in the browser and
 // posted exactly; out of range is refused by the input; a non-whole ms value by the page's rule.
 for(const f of rules.FIX_KNOB_FIELDS.filter(f=>f.unit==='minutes')){
  const {min,max,def}=FIX_AGENT_KNOBS[f.key];
  const input=section.getByLabel(f.label);
  for(const ms of [min,max,min+1,max-1]){
   const typed=String(rules.toForm('minutes',ms));
   await input.fill(typed);
   assert.equal(await input.evaluate(i=>i.validity.valid),true,`${f.key}=${ms} (${typed} min)`);
   const n=posts.length;
   await save.click();
   await page.getByText('Saved',{exact:true}).waitFor();
   assert.equal(posts.length,n+1,`${f.key}=${ms}: posted`);
   assert.equal(posts.at(-1).fixAgent[f.key],ms,`${f.key}=${ms}: posted exactly`);
  }
  for(const [typed,flag] of [[String((min-1)/60_000),'rangeUnderflow'],[String((max+1)/60_000),'rangeOverflow']]){
   await input.fill(typed);
   assert.equal(await input.evaluate((i,flag)=>i.validity[flag],flag),true,`${f.key}: ${typed} min -> ${flag}`);
  }
  await page.locator('form').evaluate(form=>{form.noValidate=true;});
  for(const typed of [String((min-1)/60_000),String((max+1)/60_000),String(min/60_000+0.00001)]){
   await input.fill(typed);
   const n=posts.length;
   await save.click();
   await page.getByText(new RegExp(`${f.label.replace('.','\\.')} must be a whole number of milliseconds`)).waitFor();
   assert.equal(posts.length,n,`${f.key}: ${typed} min is refused by the page, as the server refuses it`);
  }
  await page.locator('form').evaluate(form=>{form.noValidate=false;});
  await input.fill(String(rules.toForm('minutes',def)));
 }
});

// The rendered screen accepts exactly what the production route accepts, field by field: a sample
// the page posts must be a 200 from the real route + validator, and a sample the page refuses (the
// input's own constraints or the page's check) must be a 400 there.
test('Settings UI: for every editable field the page accepts exactly the values the server accepts',async t=>{
 const rules=await import('../../src/lib/settings-rules.ts');
 const {settingsHarness}=await import('./settings-harness.mjs');
 const context=await browser.newContext();t.after(()=>context.close());
 const posts=[];let savedFix;
 await context.route('https://fix-agent.fixture/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div id="root"></div><script>window.savedFix=${JSON.stringify(savedFix)||'undefined'};</script><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`});
  if(url.pathname==='/api/harbor'&&route.request().method()==='POST'){
   const body=route.request().postDataJSON();posts.push(body);savedFix=body.fixAgent;
   return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,settings:{fixAgent:body.fixAgent}})});
  }
  return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
 });
 const page=await context.newPage();page.on('pageerror',error=>console.error('Fix agent UI fixture page error:',error.message));
 await page.goto('https://fix-agent.fixture/');
 const section=page.getByRole('region',{name:'Fix agent / review loop'});
 await section.waitFor();
 const save=page.getByRole('button',{name:'Save settings',exact:true});
 const bar=save.locator('xpath=..');
 const server=async fields=>{const {action:_a,...rest}=fields;return (await settingsHarness().post(rest)).status;};
 // What the page does with one typed value: refused by the input, refused by the page, or posted.
 async function pageSave(input,typed){
  await input.fill(typed);
  if(!(await input.evaluate(i=>i.validity.valid)))return {accepted:false};
  if(await save.isDisabled())return {accepted:true,body:null};
  const n=posts.length;
  await save.click();
  await bar.locator('span.text-ok, span.text-danger').first().waitFor();
  return posts.length>n?{accepted:true,body:posts.at(-1)}:{accepted:false};
 }
 const num=typed=>typed.trim()===''?null:Number(typed); // an emptied number input sends nothing numeric
 const rows=[];
 const inline=rules.formAttrs(rules.SETTINGS_INT_FIELDS.maxInlineComments);
 rows.push({label:'max_inline_comments',input:page.getByLabel('max_inline_comments'),attrs:inline,
  typed:['0','20','7','21','-1','1.5',''],fields:typed=>({maxInlineComments:num(typed)})});
 for(const f of rules.FIX_KNOB_FIELDS){
  const attrs=rules.formAttrs(rules.fixKnobDomain(f.key));
  const {min,max}=FIX_AGENT_KNOBS[f.key];
  const typed=f.unit==='minutes'
   ?[String(min/60_000),String(max/60_000),'1.5',String(rules.toForm('minutes',min+1)),String((min-1)/60_000),String(max/60_000+1),String(min/60_000+0.00001),'']
   :[String(min),String(max),String(min+1),String(min-1),String(max+1),String(min+0.5),''];
  rows.push({label:f.label,input:section.getByLabel(f.label),attrs,typed,
   fields:t=>({fixAgent:{[f.key]:num(t)===null?null:rules.fromForm(attrs.unit,num(t))}})});
 }
 rows.push({label:'bot.username',input:page.getByLabel('bot.username'),typed:['ashlar-2','   ','','x'],fields:t=>({username:t})});
 rows.push({label:'mentions',input:page.getByLabel('mentions'),typed:['@a, /b',' , ','','@solo'],
  fields:t=>({mention:t.split(',').map(s=>s.trim()).filter(Boolean)})});
 const mismatches=[];
 for(const row of rows){
  if(row.attrs){
   assert.deepEqual(await row.input.evaluate(i=>[i.min,i.max,i.step]),[String(row.attrs.min),String(row.attrs.max),String(row.attrs.step)],`${row.label}: input domain from settings-rules`);
  }
  for(const typed of row.typed){
   const ui=await pageSave(row.input,typed);
   const status=ui.body?await server(ui.body):await server(row.fields(typed));
   if(ui.accepted!==(status===200))mismatches.push(`${row.label}=${JSON.stringify(typed)}: page ${ui.accepted?'accepts':'refuses'}, server ${status}`);
   // A posted value is the typed value (after the unit conversion), never a silent coercion.
   if(ui.body){
    const want=row.fields(typed);
    const got=want.fixAgent?{fixAgent:Object.fromEntries(Object.keys(want.fixAgent).map(k=>[k,ui.body.fixAgent[k]]))}:Object.fromEntries(Object.keys(want).map(k=>[k,ui.body[k]]));
    if(JSON.stringify(got)!==JSON.stringify(want))mismatches.push(`${row.label}=${JSON.stringify(typed)}: page posted ${JSON.stringify(got)}, typed ${JSON.stringify(want)}`);
   }
  }
  // Leave the field valid for the next row.
  await row.input.fill(row.typed[0]);
 }
 assert.deepEqual(mismatches,[]);
 assert.ok(posts.length>0);
 assert.equal(posts.at(-1).fixAgent.enabled,false,'the loop stays OFF (default) throughout');
});
