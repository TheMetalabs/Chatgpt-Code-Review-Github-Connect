// Settings UI for the fix agent / review loop: the section is the loop's only switch. It starts
// OFF, validates before posting, and sends the whole fixAgent block through the settings API.
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
