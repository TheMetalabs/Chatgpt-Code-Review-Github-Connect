// Live 2026-10-20 raw Grok observations (jobs 1330/1250/1314/1387): the result was the sender label
// "Grok" alone, a reply cut off mid array, and a reply with LaTeX (a backslash-l-d-o-t-s command) inside a
// JSON string ("Invalid \escape"). `final:false` on those observations is NOT a finality signal: the
// server writes it on every observation (review-history.server.ts recordObservation). The tab_preserved
// cause=edited event beside each harvest is the cleanup that FOLLOWS a captured source, not what ended the
// leg. These rows pin: a takeover verdict (real or inferred) never harvests partial text while Grok is
// still writing, a close is held back while it writes, and a review whose strings carry invalid escapes
// still parses.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {background, content, storage, raw, flush} from './helpers.mjs';
import {extractChatJson as server, repairJsonEscapes} from '../../src/lib/extract-chat-json.ts';

const CONV = 'https://grok.com/c/abc';
const extension = content().context.extractChatJson;
const valid = {findings: [{severity: 'P1', file: 'a.ts', line: 3, side: 'RIGHT', title: 'Bug', failure_scenario: 's', root_cause: 'r', evidence: 'e', recommended_fix: 'f', recommended_test: 't'}], merge_recommendation: 'REQUEST_CHANGES'};
const withBackslashes = body => JSON.stringify(valid).replace('"evidence":"e"', `"evidence":"${body}"`);

test('both parsers read a review whose string carries invalid escapes (LaTeX, regex), after the strict parse fails', () => {
  for (const body of ['sum x_1 \\ldots x_n', 'angle \\alpha and \\(x\\)', 'path \\d+\\.ts', 'mixed \\ldots and valid \\n newline and \\u00e9 and \\\\ and \\" quote']) {
    const text = withBackslashes(body);
    assert.throws(() => JSON.parse(text), 'strict JSON rejects it');
    for (const [name, read] of [['server', server], ['extension', extension]]) {
      const hit = read('```json\n' + text + '\n```');
      assert.notEqual(hit, null, `${name}: ${body}`);
      const parsed = JSON.parse(hit);
      assert.equal(parsed.merge_recommendation, 'REQUEST_CHANGES');
      assert.equal(parsed.findings[0].evidence.includes('\\'), true, `${name} keeps the backslash in the text`);
    }
  }
  const out = JSON.parse(server(withBackslashes('sum \\ldots')));
  assert.equal(out.findings[0].evidence, 'sum \\ldots');
  assert.equal(JSON.parse(extension(withBackslashes('sum \\ldots'))).findings[0].evidence, 'sum \\ldots');
});

test('the repair never touches valid JSON, valid escapes, or text outside strings, and rejects what stays invalid', () => {
  const text = JSON.stringify(valid);
  assert.equal(server(text), text);
  assert.equal(extension(text), text);
  const escaped = JSON.stringify({...valid, merge_recommendation: 'REQUEST_CHANGES', findings: [{...valid.findings[0], evidence: 'a\\b "q" \n \u00e9 / \\u0041'}]});
  assert.equal(server(escaped), escaped, 'valid escapes are the strict parse\'s');
  assert.equal(repairJsonEscapes('{"a":"x\\ly","b":1}'), '{"a":"x\\\\ly","b":1}');
  assert.equal(repairJsonEscapes('{"a":"x\\u12"}'), '{"a":"x\\\\u12"}', 'a short \\u is not an escape');
  assert.equal(repairJsonEscapes('{"a":"line\nbreak"}'), '{"a":"line\\nbreak"}');
  for (const input of ['{"findings":[{"evidence":"sum \\ldots', '{"x":"\\ldots"}', '{"findings":["unfinished \\ldots }']) {
    assert.equal(server(input), null, input);
    assert.equal(extension(input), null, input);
  }
});

// ---- a takeover (real or inferred) while Grok is still writing never harvests partial text ----
function writingPage({rendered = 'Review PR #1\n\n\u2022 item one', input = false} = {}) {
  const c = content('grok');
  c.context.stopButtonVisible = () => true; // Grok's stop control is up: the answer is being written
  c.context.replyDoneVisible = () => false;
  c.context.responseStreaming = () => true;
  c.context.runPrompt = () => new Promise(() => {});
  c.context.sleep = () => new Promise(() => {});
  c.context.waitForPageChange = () => new Promise(() => {});
  c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider: 'grok', prompt: 'review'});
  const record = {phase: 'sent', expected: 'Review PR #1 - item one', messageId: 'user-A', baseline: 0, submittedUsers: 1, conversation: CONV};
  c.context.location = {href: CONV};
  c.context.savedSubmission = () => record;
  c.context.boundReviewResponse = () => ({identified: true, followup: false, root: {}, responseId: 'answer-A', message: {}});
  c.context.assistantCorpus = () => ['Grok'];
  c.context.userTurnEls = () => [{}];
  c.context.turnMessageId = () => 'user-A';
  c.context.messagePromptText = () => rendered;
  c.context.composerDraftText = () => '';
  c.context.composerStagedFiles = () => [];
  c.context.regeneratedAfterCompletion = () => false;
  if (input) c.context.noteUserInput({isTrusted: true});
  return c;
}
const harvest = c => c.message({type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: 'grok'});

test('while Grok is still writing, no harvest settles partial text, taken over or not', async () => {
  for (const [name, takeover] of [['not taken over', false], ['inferred takeover (render differs, no input)', 'inferred'], ['real takeover (trusted input)', 'real']]) {
    const c = writingPage({input: takeover === 'real'});
    await flush();
    if (takeover) c.context.__ashlarRunnerState.tabRepurposed = takeover === 'real';
    for (let i = 0; i < 3; i++) assert.equal((await harvest(c))?.code, 'busy', `${name}: harvest ${i}`);
    assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true, name);
    const stages = (c.context.__ashlarRunnerState.steps?.events || []).map(e => e.stage);
    assert.equal(stages.includes('response_collected'), false, `${name}: ${JSON.stringify(stages)}`);
  }
});

test('a takeover verdict during generation is not final: a real one is still reported, an owned one is held back', async () => {
  const ask = c => c.message({type: 'ashlar-can-close', jobId: 'A', runId: 'run-A', provider: 'grok', allocationUrl: 'https://grok.com/', secured: true});
  // Ashlar's own turn rendered differently, no input, stop control up: nothing says "close" yet.
  const inferred = writingPage();
  await flush();
  const held = await ask(inferred);
  assert.equal(held.ownership, 'unknown', JSON.stringify(held));
  assert.equal(held.cause, 'generating');
  assert.equal(held.canClose, false);
  assert.equal(held.generating, true);
  assert.equal(inferred.context.__ashlarRunnerState.tabRepurposed, undefined, 'not marked repurposed either');
  // The same page once Grok stopped writing: closable.
  inferred.context.stopButtonVisible = () => false;
  assert.equal((await ask(inferred)).ownership, 'owned');
  // A real takeover (trusted input) is reported as it is, even mid-generation.
  const real = writingPage({input: true});
  await flush();
  const taken = await ask(real);
  assert.equal(taken.ownership, 'takenOver');
  assert.equal(taken.cause, 'edited');
  assert.equal(taken.userInput, true);
});

test('the worker waits on a generating verdict: the tab stays open, nothing is preserved, posted or closed', async () => {
  const tabs = new Map([[10, {id: 10, url: CONV, status: 'complete'}]]);
  const job = {jobId: 'A', origin: 'http://bridge', leaseId: 'l', prompt: 'review', providers: ['grok'],
    states: {grok: {tabId: 10, started: true, runId: 'A-run', outcome: {ok: true, raw, originalText: raw}}}};
  const b = background({local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {A: job}}), tabs,
    handler: (_id, msg) => msg.type === 'ashlar-can-close'
      ? {ok: true, canClose: false, ownership: 'unknown', cause: 'generating', generating: true, url: CONV} : {ok: false, code: 'busy'},
    api: async () => ({ok: true, active: true, accepted: true, status: 'awaiting_chat'})});
  for (let i = 0; i < 3; i++) { await b.tick(); await flush(); }
  assert.deepEqual(b.closedTabs, []);
  assert.equal(b.messages.some(m => m.type === 'ashlar-fix-cancel'), false, 'the page was not told to release the tab');
  const state = b.local.state.pendingReviewJobs?.A?.states.grok;
  assert.equal(state?.cleanupDone, undefined, 'the leg is still waiting');
  assert.equal(state?.cleanupWaitReason, 'ownership_unknown');
});
