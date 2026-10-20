// Real production captures, 2026-10-20 (Mac Studio, after #171): all five open aicc-center PRs got RAW
// reviews. 24 raw observations (tests/review/fixtures/raw-capture-20261020, README there), 18 ChatGPT and
// 6 Grok. Every one is a review cut off inside its last array, `coverage`: merge_recommendation,
// highest_risk, investigated_safe, assumptions and `findings` complete, then the text just stops (the page
// logged response_completed_json_invalid on a PARTIAL answer; local repair then could not preserve it).
// Classes across the 24: a leading "JSON" / "Grok ... JSON" label (13, plus 2 bare "Grok" labels), an unclosed ```json fence (9),
// an `<escape>` tag before `{` (1: job-mvg35r08-155), a missing `[` after `"coverage":` (2: Grok -854, -466).
// Before this change the extension's and the server's extractChatJson returned null for ALL 24, so every
// one was posted raw, and aicc-center#1091 (job-mvgezanw-981) read "no major issues" while Grok's cut-off
// answer was REQUEST_CHANGES with a P1.
//
// Expected outcome, documented per case below: ALL 24 recover (status "recovered-truncated"): the verdict
// and every finding exactly as the reply wrote them, the coverage entries that arrived whole, and
// `truncated: true`. A reply cut off before its findings finished would classify "truncated" (nothing
// recovered, the reply is partial); the synthetic rows at the end pin that, never a silent null.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {content, flush} from './helpers.mjs';
import {appFixture, eventually} from './app-fixture.mjs';
import {classifyReviewText, extractChatJson, extractChatJsonRecovering, repairJsonEscapes, recoverTruncatedReviewJson} from '../../src/lib/extract-chat-json.ts';
import {inspectReviewFormat} from '../../src/lib/review-json-repair.ts';
import {incompleteVerdict} from '../../src/lib/local-fallback.ts';
import {parseChatSubmission} from '../../src/lib/chat-prompt.ts';
import {isZeroFindings} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY, REVIEW_RAW_START} from '../../src/lib/review-format.ts';

const dir = fileURLToPath(new URL('./fixtures/raw-capture-20261020/', import.meta.url));
const bundle = JSON.parse(fs.readFileSync(dir + 'cases.bundle.json', 'utf8'));
const ext = content().context;

// What each case's reply carried before it stopped: its finding severities (in order), its verdict and
// how many coverage entries arrived whole. (An independent reading of the raw text checks them below.)
const EXPECTED = new Map([
  ['job-mvg2el50-26.chatgpt.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 20}],
  ['job-mvg2ii4n-41.chatgpt.json', {findings: 'P1', merge: 'REQUEST_CHANGES', coverage: 41}],
  ['job-mvg2lbkt-56.chatgpt.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 28}],
  ['job-mvg2skzi-93.chatgpt.json', {findings: 'P1', merge: 'REQUEST_CHANGES', coverage: 31}],
  ['job-mvg2wn6q-113.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 39}],
  ['job-mvg35r08-155.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 32}],
  ['job-mvg4bxzc-269.chatgpt.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 34}],
  ['job-mvg4f95p-288.chatgpt.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 31}],
  ['job-mvg56lep-352.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 29}],
  ['job-mvg5qoxb-427.json', {findings: '', merge: 'APPROVE', coverage: 3}],
  ['job-mvg5tl50-441.chatgpt.json', {findings: 'P1', merge: 'REQUEST_CHANGES', coverage: 37}],
  ['job-mvg5tl50-441.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 30}],
  ['job-mvg5y0mm-466.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 25}],
  ['job-mvg5y0mm-466.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 2}],
  ['job-mvg61ie4-490.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 29}],
  ['job-mvg853lo-704.chatgpt.json', {findings: '', merge: 'REQUEST_CHANGES', coverage: 33}],
  ['job-mvg91dpo-773.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 45}],
  ['job-mvgaxcro-842.chatgpt.json', {findings: 'P2', merge: 'REQUEST_CHANGES', coverage: 47}],
  ['job-mvgbfzck-854.json', {findings: '', merge: 'APPROVE', coverage: 8}],
  ['job-mvgc6vw3-890.chatgpt.json', {findings: 'P1', merge: 'REQUEST_CHANGES', coverage: 38}],
  ['job-mvgc6vw3-890.json', {findings: '', merge: 'APPROVE', coverage: 29}],
  ['job-mvgdiywz-937.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 40}],
  ['job-mvge0ycx-954.chatgpt.json', {findings: '', merge: 'COMMENT', coverage: 36}],
  ['job-mvgezanw-981.json', {findings: 'P1', merge: 'REQUEST_CHANGES', coverage: 16}]
]);

/** An independent reading of a raw capture: the `findings` array parsed by bracket matching on the text. */
function oracle(text) {
  const key = /(?<!\\)"findings"\s*:\s*\[/.exec(text);
  assert.ok(key, 'a findings array');
  const open = key.index + key[0].length - 1;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth += 1;
    else if (c === ']' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, 'the findings array closed in the raw text');
  const tail = text.slice(end);
  const coverage = tail.match(/\{\s*"file"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"status"\s*:\s*"(?:cleared|not_cleared)"\s*,\s*"reason"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g) || [];
  return {findings: JSON.parse(text.slice(open, end)), coverage: coverage.length,
    merge: /(?<!\\)"merge_recommendation"\s*:\s*"([A-Z_]+)"/.exec(text)?.[1]};
}

test('the fixture bundle is the 24 real captures: 18 ChatGPT, 6 Grok, every one truncated inside coverage', () => {
  assert.equal(Object.keys(bundle).length, 24);
  assert.deepEqual([...EXPECTED.keys()].sort(), Object.keys(bundle).sort());
  assert.equal(Object.keys(bundle).filter(name => name.endsWith('.chatgpt.json')).length, 18);
  assert.equal(Object.keys(bundle).filter(name => !name.endsWith('.chatgpt.json')).length, 6);
  for (const [name, row] of Object.entries(bundle)) {
    assert.equal(row.final, false, name);
    assert.equal(row.truncated, false, `${name}: the observation was not size-truncated; the page captured a partial answer`);
    assert.equal(extractChatJson(row.text), null, `${name}: the strict extractor finds nothing (the old, silent null)`);
    assert.equal(ext.extractChatJson(row.text), null, `${name}: nor does the extension's`);
  }
});

test('the noise classes in the 24 captures: labels, unclosed fences, an <escape> tag, a missing "["', () => {
  const texts = Object.entries(bundle).map(([name, row]) => [name, row.text]);
  assert.equal(texts.filter(([, t]) => /^(?:Grok\s*)?JSON\s/.test(t)).length, 13, 'a leading JSON / Grok…JSON label');
  assert.equal(texts.filter(([, t]) => /^Grok\s+\{/.test(t)).length, 2, 'a bare Grok label (page text, no code block header)');
  assert.equal(texts.filter(([, t]) => t.startsWith('```json')).length, 9, 'an unclosed ```json fence');
  assert.deepEqual(texts.filter(([, t]) => /<escape>\s*\{/.test(t)).map(([name]) => name), ['job-mvg35r08-155.chatgpt.json']);
  assert.deepEqual(texts.filter(([, t]) => /"coverage"\s*:\s*\{/.test(t)).map(([name]) => name).sort(), ['job-mvg5y0mm-466.json', 'job-mvgbfzck-854.json']);
});

for (const [name, expected] of EXPECTED) {
  test(`${name}: recovered-truncated, verdict and findings exactly as written, truncated:true (server and extension agree)`, () => {
    const {text} = bundle[name];
    const want = oracle(text);
    assert.equal(want.findings.map(f => f.severity).join(''), expected.findings, 'the table matches the raw text');
    assert.equal(want.merge, expected.merge);
    assert.equal(want.coverage, expected.coverage, 'every whole coverage entry in the raw text');
    const server = classifyReviewText(text);
    const extension = ext.classifyReviewText(text);
    assert.equal(server.status, 'recovered-truncated');
    assert.equal(extension.status, 'recovered-truncated');
    assert.equal(extension.json, server.json, 'one parser, two copies');
    const recovered = JSON.parse(server.json);
    assert.deepEqual(recovered.findings, want.findings, 'findings preserved exactly');
    assert.equal(recovered.merge_recommendation, expected.merge);
    assert.equal(recovered.truncated, true);
    assert.equal(recovered.coverage.length, expected.coverage, 'the coverage that arrived whole, not the cut entry');
    for (const entry of recovered.coverage) assert.deepEqual(Object.keys(entry).sort(), ['file', 'reason', 'status']);
    // The same recovery is what the server's callers use, and what the bridge's format check accepts.
    assert.equal(extractChatJsonRecovering(text), server.json);
    assert.equal(parseChatSubmission(text).truncated, true);
    assert.equal(inspectReviewFormat(server.json, 'review').ok, true, JSON.stringify(inspectReviewFormat(server.json, 'review')));
  });
}

test('a recovered truncated reply with no finding is never a complete verdict; one with findings is, and keeps them', () => {
  for (const [name, expected] of EXPECTED) {
    const gate = {ok: true, truncated: true, findings: [...expected.findings].map(severity => ({severity}))};
    const why = incompleteVerdict(gate, {});
    if (expected.findings) assert.equal(why, undefined, `${name}: its findings are merged`);
    else assert.match(why, /cut off before it finished/, `${name}: no clean credit`);
  }
});

test('a truncated reply with no finding never earns clean credit, even with a raw_review text riding along', () => {
  const why = /cut off before it finished/;
  assert.match(incompleteVerdict({ok: true, truncated: true, findings: [], rawReview: 'the reviewer\'s own text'}, {}), why);
  assert.match(incompleteVerdict({ok: true, truncated: true, findings: []}, {}), why);
  assert.equal(incompleteVerdict({ok: true, truncated: true, findings: [{severity: 'P1'}], rawReview: 'x'}, {}), undefined, 'findings are a verdict');
  assert.equal(incompleteVerdict({ok: true, rawReview: 'x'}, {}), undefined, 'an ordinary salvage keeps its exit');
});

test('the missing "[" is supplied after the ROOT coverage key only, never inside a string or a nested object', () => {
  const finding = {severity: 'P2', file: 'a.ts', line: 1, side: 'RIGHT', title: 'T', failure_scenario: 's', root_cause: 'r',
    evidence: 'code: {"coverage": {"a": 1}} and \\"coverage\\": { in prose', recommended_fix: 'f', recommended_test: 't',
    extra: {coverage: {file: 'nested.ts', status: 'cleared'}}};
  const head = JSON.stringify({merge_recommendation: 'REQUEST_CHANGES', highest_risk: 'r', findings: [finding]}).slice(0, -1);
  // The root's coverage lost its "[" (Grok page text) and is cut off after one whole entry.
  const text = `Grok\n\nJSON\n${head},"coverage":{"file":"a.ts","status":"cleared","reason":"read"},{"file":"b.ts","status":"not_cl`;
  for (const [name, recover] of [['server', recoverTruncatedReviewJson], ['extension', ext.recoverTruncatedReviewJson]]) {
    const recovered = JSON.parse(recover(text));
    assert.deepEqual(recovered.findings, [finding], `${name}: the finding, nested coverage object and quoted text unchanged`);
    assert.deepEqual(recovered.coverage, [{file: 'a.ts', status: 'cleared', reason: 'read'}], `${name}: "[" supplied for the root coverage alone`);
    assert.equal(recovered.truncated, true);
  }
  // No root coverage at all: nothing is inserted anywhere.
  const without = `${head},"highest_risk_note":"x"`;
  for (const recover of [recoverTruncatedReviewJson, ext.recoverTruncatedReviewJson]) assert.deepEqual(JSON.parse(recover(without)).findings, [finding]);
});

test('a reply cut off BEFORE its findings finished is classified truncated, never recovered and never null-silent', () => {
  const {text} = bundle['job-mvg2ii4n-41.chatgpt.json'];
  const cut = text.slice(0, /(?<!\\)"findings"\s*:\s*\[/.exec(text).index + 400);
  for (const [name, read] of [['server', classifyReviewText], ['extension', ext.classifyReviewText]]) {
    const out = read(cut);
    assert.equal(out.status, 'truncated', name);
    assert.equal(out.json, undefined, `${name}: a dropped finding is worse than a missing one`);
  }
  assert.equal(recoverTruncatedReviewJson(cut), null);
  // Cut before merge_recommendation arrived: the verdict is missing, nothing is recovered either.
  const early = '```json\n{\n  "highest_risk": "x",\n  "findings": [],\n  "coverage": [\n    {"file": "a.ts", "status": "cl';
  assert.equal(classifyReviewText(early).status, 'truncated');
  assert.equal(classifyReviewText('no json here').status, 'none');
  assert.equal(classifyReviewText('').status, 'none');
  assert.equal(classifyReviewText('{"findings": [], "merge_recommendation": nope}').status, 'invalid', 'closed, but not JSON');
});

test('complete replies stay complete: labels, fences and tags before the object never change what it says', () => {
  const body = JSON.stringify({merge_recommendation: 'COMMENT', findings: [], investigated_safe: ['a.ts: x'], coverage: [{file: 'a.ts', status: 'cleared', reason: 'r'}]});
  for (const wrapped of [body, `JSON\n\n\n${body}`, `Grok\n\n×15 JSON\n×5\n${body}`, '```json\n' + body, '<escape>' + body, '```json\n' + body + '\n```']) {
    for (const read of [classifyReviewText, ext.classifyReviewText]) {
      const out = read(wrapped);
      assert.equal(out.status, 'complete', wrapped.slice(0, 30));
      assert.equal(out.json, body);
    }
  }
});

test('repairJsonEscapes escapes EVERY raw control character U+0000-U+001F inside strings, and only there (#171 P2)', () => {
  const named = {'\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'};
  for (const repair of [repairJsonEscapes, ext.repairJsonEscapes]) {
    for (let code = 0; code < 0x20; code += 1) {
      const c = String.fromCharCode(code);
      const text = `{"a":"x${c}y","b":1}`;
      const fixed = repair(text);
      assert.equal(JSON.parse(fixed).a, `x${c}y`, `U+${code.toString(16).padStart(4, '0')} round-trips`);
      assert.equal(fixed, `{"a":"x${named[c] ?? '\\u' + code.toString(16).padStart(4, '0')}y","b":1}`);
    }
    assert.equal(repair('{\n  "a": 1\n}'), '{\n  "a": 1\n}', 'whitespace between tokens is not a string');
    assert.equal(repair('{"a":"x\\ly"}'), '{"a":"x\\\\ly"}');
  }
});

// ---- Capture: a partial answer is not complete, for BOTH providers ----
const SENT = {phase: 'sent', expected: 'review', messageId: 'user-A', baseline: 0, submittedUsers: 1, sawStream: true, sawStreamKey: 'user-A'};
function writingPage(provider, text) {
  const c = content(provider);
  c.context.stopButtonVisible = () => false; // the stop control is gone ...
  c.context.replyDoneVisible = () => true; // ... and the action row is up: the old rule called this complete
  c.context.responseStreaming = () => false;
  c.context.runPrompt = () => new Promise(() => {});
  c.context.sleep = () => new Promise(() => {});
  c.context.waitForPageChange = () => new Promise(() => {});
  c.message({type: 'ashlar-run', jobId: 'A', runId: 'run-A', provider, prompt: 'review'});
  const conversation = provider === 'grok' ? 'https://grok.com/c/abc' : 'https://chatgpt.com/c/abc';
  c.context.location = {href: conversation};
  const record = {...SENT, conversation};
  c.context.savedSubmission = () => record;
  const root = {matches: () => false};
  c.context.boundReviewResponse = () => ({identified: true, followup: false, root, responseId: 'answer-A', message: root});
  c.context.assistantCorpus = () => [text];
  c.context.turnMessageId = () => 'user-A';
  c.context.userTurnEls = () => [{}];
  c.context.messagePromptText = () => 'review';
  return c;
}
const harvest = c => c.message({type: 'ashlar-harvest', jobId: 'A', runId: 'run-A', provider: c.context.__ashlarRunnerState.provider});

for (const [name, provider] of [['job-mvgc6vw3-890.chatgpt.json', 'chatgpt'], ['job-mvgc6vw3-890.json', 'grok'], ['job-mvg2ii4n-41.chatgpt.json', 'chatgpt'], ['job-mvg5y0mm-466.json', 'grok']]) {
  test(`${name}: ${provider} does not call a partial review complete until it stood still; then the recovered review is the result`, async () => {
    const {text} = bundle[name];
    const c = writingPage(provider, text);
    await flush();
    for (let i = 0; i < 3; i++) assert.equal((await harvest(c))?.code, 'busy', `harvest ${i}: the text is a partial review`);
    assert.notEqual(c.context.__ashlarRunnerState.result?.ok, true);
    const stages = () => (c.context.__ashlarRunnerState.steps?.events || []).map(e => e.stage);
    assert.equal(stages().includes('response_collected'), false, JSON.stringify(stages()));
    assert.equal(c.message({type: 'ashlar-repair-source', jobId: 'A', runId: 'run-A', provider})?.ok, false, 'nor is it a completed source to capture');
    // The same text, unchanged, with the stream gone, for the whole settle window.
    c.context.__ashlarIncompleteReview.since -= 50_000;
    const first = await harvest(c);
    const second = await harvest(c);
    const settled = first?.ok ? first : second;
    assert.equal(settled?.ok, true, JSON.stringify([first?.code, second?.code]));
    const result = JSON.parse(settled.raw);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.findings, oracle(text).findings);
  });
}

test('the settle clock belongs to one response of one run, not to the text', async () => {
  const {text} = bundle['job-mvgc6vw3-890.chatgpt.json'];
  const c = writingPage('chatgpt', text);
  await flush();
  assert.equal(c.context.reviewDoneSettled(true, {root: {matches: () => false}, message: {id: 'x'}}), false);
  c.context.__ashlarIncompleteReview.since -= 50_000;
  assert.equal(c.context.reviewDoneSettled(true, {root: {matches: () => false}, message: {id: 'x'}}), true, 'same response, same text, stood still');
  c.context.assistantCorpus = () => [text + ' '];
  assert.equal(c.context.reviewDoneSettled(true, {root: {matches: () => false}, message: {id: 'x'}}), false, 'the text moved: the clock starts over');
  c.context.__ashlarRunnerState.runId = 'run-B';
  c.context.__ashlarIncompleteReview.since -= 50_000;
  assert.equal(c.context.reviewDoneSettled(true, {root: {matches: () => false}, message: {id: 'x'}}), false, 'another run: its own clock');
  // A complete review, a non-JSON answer and a `done: false` page are never delayed.
  const whole = JSON.stringify({merge_recommendation: 'COMMENT', findings: [], investigated_safe: ['a']});
  for (const [shown, done] of [[whole, true], ['plain prose', true], [text, false]]) {
    c.context.assistantCorpus = () => [shown];
    assert.equal(c.context.reviewDoneSettled(done, {root: {matches: () => false}, message: {}}), done);
  }
});

// ---- Safety: a leg that failed or was cut off never lets a review read clean (aicc-center#1091) ----
const clean = JSON.stringify({findings: [], merge_recommendation: 'COMMENT', investigated_safe: ['a.ts: constant change only']});

/** `salvaged`: the worker's own delivery of a reply nothing could read (its repair is over): raw text, flagged. */
async function bridgeRound(t, name, legs, {salvaged = false, grok = true} = {}) {
  const app = await appFixture({reviewLocal: false, reviewGrok: grok});
  t.after(() => app.close());
  const out = await app.mention(name);
  await eventually(() => app.harbor.getHarbor().jobs.find(j => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob(`${name}-client`);
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the review');
  const result = await app.bridge.completeBridgeJob(out.jobId, legs[0].raw, legs, take.leaseId, salvaged);
  assert.equal(result.ok, true);
  await eventually(() => app.reviews.length === 1, `review ${out.jobId} was not posted`);
  return {app, body: app.reviews[0].body, job: app.harbor.getHarbor().jobs.find(j => j.id === out.jobId)};
}
/** Grok's real answer for aicc-center#1091 (job-mvgezanw-981: REQUEST_CHANGES, one P1, cut off inside
 * coverage), its finding re-pointed at the fixture PR's changed file so the gate can anchor it. */
function grok1091() {
  const {text} = bundle['job-mvgezanw-981.json'];
  const [finding] = oracle(text).findings;
  assert.equal(finding.severity, 'P1');
  return {text: text.split(finding.file).join('a.ts'), finding};
}

test('aicc-center#1091: ChatGPT clean + Grok cut off with a P1 posts the P1; the review never reads clean', async t => {
  const {text, finding} = grok1091();
  const {body, job} = await bridgeRound(t, 'raw-1091-recovered', [{provider: 'chatgpt', raw: clean}, {provider: 'grok', raw: text, originalText: text}]);
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.match(body, /p1=1/, 'the P1 is a finding of the posted review');
  assert.equal(body.includes(finding.title), true, 'with its title');
  assert.match(job.plan || '', /cut off after its findings/);
  assert.deepEqual({...(job.auxiliaryProviderFailures ?? {})}, {});
});

test('aicc-center#1091, unrecoverable: Grok cut off INSIDE its findings beside a clean ChatGPT: posted verbatim, never "no major issues"', async t => {
  const {text} = grok1091();
  const cut = text.slice(0, /(?<!\\)"findings"\s*:\s*\[/.exec(text).index + 700);
  assert.equal(classifyReviewText(cut).status, 'truncated');
  const {body, job} = await bridgeRound(t, 'raw-1091-unrecoverable', [{provider: 'chatgpt', raw: clean}, {provider: 'grok', raw: cut, originalText: cut}], {salvaged: true});
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.equal(body.includes(REVIEW_RAW_START), true, 'its reply is posted as evidence');
  assert.match(body, /not valid review JSON/);
  assert.match(body, /No complete review from grok/);
  assert.deepEqual({...job.rawCauses}, {grok: 'unparseable'});
});

test('a ChatGPT reply cut off after its findings, no finding, is never a clean pass', async t => {
  const {text} = bundle['job-mvg2wn6q-113.chatgpt.json']; // REQUEST_CHANGES-free: COMMENT, findings [], coverage cut
  const {body, job} = await bridgeRound(t, 'raw-chatgpt-truncated-clean', [{provider: 'chatgpt', raw: text, originalText: text}], {grok: false});
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.ok(job.incompleteProviders?.includes('chatgpt') || job.rawCauses?.chatgpt, 'the cut-off leg is flagged, not credited');
});
