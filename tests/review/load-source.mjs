import {sanitizeWorkerStatus} from "../../src/lib/bridge-worker-status.ts";
import {JsonRepairService, localJsonRepairAvailable, cancelLocalJsonRepairs} from "../../src/lib/json-repair.server.ts";
import {inspectReviewFormat} from "../../src/lib/review-json-repair.ts";
// Execute production source in a fresh realm, replacing only external I/O imports.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import {ReviewHistoryStore} from '../../src/lib/review-history.server.ts';
import {sanitizeProgressEvents} from '../../src/lib/review-progress.server.ts';
export const root = process.env.REVIEW_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const source = path => readFileSync(resolve(root, path), 'utf8');
export function loadTs(path, imports = {}) {
  let text = stripTypeScriptTypes(source(path));
  const names = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)].map(m => m[1]);
  text = text.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s*\{[^}]*\};?\s*$/gm, '').replace(/^export\s+/gm, '');
  return vm.runInNewContext(`${text}\n;({${names.join(',')}})`, {
    console, Buffer, URL, Request, Response, Headers, AbortController, setTimeout, clearTimeout,
    process: {env: {NODE_TEST_CONTEXT: 'review-test'}}, ...imports,
  }, {filename: path});
}
export const types = loadTs('src/lib/types.ts');
export const parser = loadTs('src/lib/extract-chat-json.ts');
export const fallback = loadTs('src/lib/local-fallback.ts', types);
export const json = JSON.stringify({findings:[],merge_recommendation:'COMMENT',investigated_safe:['fixture checked']});
export function job(patch={}) {
  return {id:'job1',status:'awaiting_chat',trigger:'issue_comment.mention',chatPrompt:'Review fixture',reviewProviders:['chatgpt'],
    storedLegs:[],assumptions:[],generating:{},owner:'fixture',repo:'fixture',pr:1,...patch};
}
export function bridgeHarness(jobs, extra = {}) {
  const state = {jobs,settings:types.DEFAULT_SETTINGS};
  const snapshots=[];
  const history=new ReviewHistoryStore(null);
  const bridge=loadTs('src/lib/bridge.server.ts', {
    ...crypto,...types,...parser, sanitizeWorkerStatus, JsonRepairService, localJsonRepairAvailable, cancelLocalJsonRepairs, inspectReviewFormat, sanitizeProgressEvents, reviewHistory:()=>history,
    loadDotenvFile(){},writeEnvPatch(){},resolveBridgeToken:()=>({token:'fixture',persist:false}),BRIDGE_TOKEN_ENV:'FIXTURE',
    llmWorkAllowed:j=>['issue_comment.mention','pull_request_review_comment.followup'].includes(j.trigger),
    getHarbor:()=>state,
    patchHarborJob(id, fn){state.jobs=state.jobs.map(j=>j.id===id?fn(j):j);snapshots.push(structuredClone(state.jobs.find(j=>j.id===id)));},
    submitHarborChat:async()=>({ok:true}),...extra,
  });
  return {bridge,state,snapshots};
}
