import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadTs,types} from './load-source.mjs';
test('the actual dashboard store transmits false and keeps it through remote refresh',async()=>{
 let state,request;
 const create=()=>factory=>{const set=patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};};state=factory(set,()=>state);return state;};
 loadTs('src/lib/store.ts',{...types,create,fetch:async(_path,init)=>{request=JSON.parse(init.body);return {ok:true};}});
 await state.setSettings({localJsonRepairEnabled:false});assert.equal(request.localJsonRepairEnabled,false);
 state.mergeRemote({jobs:[],events:[],reviews:[],settings:{localJsonRepairEnabled:false}});assert.equal(state.settings.localJsonRepairEnabled,false);
});
test('saved OFF survives process restart even when the startup environment default is true',t=>{
 const cwd=mkdtempSync(join(tmpdir(),'repair-settings-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const module=new URL('../../src/lib/settings.server.ts',import.meta.url).href;
 const env={PATH:process.env.PATH,HOME:cwd,ASHLAR_LOCAL_JSON_REPAIR_ENABLED:'true'};
 const run=code=>spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import * as settings from ${JSON.stringify(module)};${code}`],{cwd,env,encoding:'utf8'});
 const saved=run('settings.saveBotSettings(settings.sanitizeBotSettings({localJsonRepairEnabled:false}));');assert.equal(saved.status,0,saved.stderr);
 const restored=run('console.log(settings.loadBotSettings().localJsonRepairEnabled)');assert.equal(restored.status,0,restored.stderr);assert.equal(restored.stdout.trim(),'false');
});
