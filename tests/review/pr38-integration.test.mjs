import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {background, storage, source} from './helpers.mjs';

// A one-sided conflict resolution must not remove either PR's diagnostics.
test('PR38 integration: JSON waiting and admission blockers survive concurrent execution reports', async () => {
  const job = {jobId: 'A', origin: 'http://bridge', providers: ['chatgpt'], states: {
    chatgpt: {runId: 'run-A', started: true, tabId: 10, observation: {
      state: 'waiting_for_json', text: 'private response', totalChars: 16,
    }},
  }};
  const b = background();
  await Promise.all([
    b.context.recordWorkerStatus({A: job}, job.origin, 'tab_capacity'),
    b.context.recordWorkerStatus({A: job}, job.origin),
  ]);
  const report = b.local.state.bridgeWorkerStatus;
  assert.equal(report.phase, 'reviewing');
  assert.equal(report.admissionPhase, 'tab_capacity');
  assert.equal(report.waitingForJson, 1);
  assert.doesNotMatch(JSON.stringify(report), /private response/);
  job.states.chatgpt.delivered = true;
  await b.context.recordWorkerStatus({A: job}, job.origin, 'idle');
  assert.equal(b.local.state.bridgeWorkerStatus.waitingForJson, 0);
  assert.equal(b.local.state.bridgeWorkerStatus.admissionPhase, 'idle');
});

test('PR38 integration: popup retains JSON pending count, admission reason and historical-error wording', async () => {
  const elements = new Map();
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', addEventListener() {}});
    return elements.get(id);
  }};
  const local = storage({origin: 'http://bridge', enabled: true, lastError: 'prior network error',
    bridgeWorkerStatus: {origin: 'http://bridge', phase: 'reviewing', admissionPhase: 'tab_capacity',
      activeJobs: 1, recoveringJobs: 0, pendingCleanup: 0, savedReplies: 0, waitingForJson: 1}});
  const context = vm.createContext({document, console, chrome: {
    storage: {local, onChanged: {addListener() {}}},
    runtime: {getManifest: () => JSON.parse(source('extension/manifest.json'))},
  }});
  vm.runInContext(source('extension/popup.js'), context);
  await vm.runInContext('refreshDiagnostics()', context);
  const text = elements.get('worker').textContent;
  assert.match(text, /Current review in progress/);
  assert.match(text, /New requests: New tabs paused: review-tab capacity reached/);
  assert.match(text, /JSON pending: 1/);
  assert.match(elements.get('status').textContent, /Previous work error \(not a model completion status\)/);
});
