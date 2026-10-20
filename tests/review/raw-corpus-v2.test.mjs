// JSON conversion rate over every real raw/failed review leg (tests/review/fixtures/raw-corpus-v2: 163 legs,
// 2026-10-06..10-20, plus the 24 captures of raw-capture-20261020). Horim's policy (2026-10-20):
//  1. Format-only recovery: syntax is supplied (a bare quote inside a string escaped, a missing `[` after
//     "findings": supplied, brackets closed at a whole element), never a word of the reply changed.
//  2. A reply cut off after a complete verdict with a complete, closed, EMPTY findings list and no
//     REQUEST_CHANGES is that reviewer's verdict: the review reads "Didn't find any major issues." (the gate
//     passes), its reply posts verbatim below as evidence and coverage is marked incomplete. A reply cut
//     before or inside its findings never is (aicc-center#1091): it stays raw / incomplete.
//  3. One leg's findings post (ashlar-findings total=N) beside a failed leg, which is named incomplete.
//
// "converted" = extractChatJsonRecovering(text) non-null and inspectReviewFormat ok (canonicalLegRaw).
// "structured" = converted and it posts as a structured verdict under the gate rule: not a truncated reply
// with no finding, unless (2) holds (merge_recommendation not REQUEST_CHANGES, and it passes the gate as it
// is: an empty reply without investigated_safe is an Instant-tier skip, a content rule left unchanged).
// "before" is main@ebb1cdcf (#172), recorded per case in index.json; "after" is this tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {content} from './helpers.mjs';
import {appFixture, eventually} from './app-fixture.mjs';
import {classifyReviewText, extractChatJsonRecovering, extractChatJsonParts, normalizeReviewFormat} from '../../src/lib/extract-chat-json.ts';
import {inspectReviewFormat} from '../../src/lib/review-json-repair.ts';
import {isZeroFindings, isConvergedFindings, notCleanOutcomeOf} from '../../src/lib/review-loop.ts';
import {CLEAN_REVIEW_BODY, REVIEW_RAW_START, REVIEW_RAW_END, redactSalvagedReviewBody} from '../../src/lib/review-format.ts';

const dir = fileURLToPath(new URL('./fixtures/raw-corpus-v2/', import.meta.url));
const corpus = JSON.parse(fs.readFileSync(dir + 'cases.bundle.json', 'utf8'));
const index = JSON.parse(fs.readFileSync(dir + 'index.json', 'utf8'));
const old24 = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/raw-capture-20261020/cases.bundle.json', import.meta.url)), 'utf8'));
const ext = content().context;

const providerOf = name => (/\.chatgpt\.(?:txt|json)$/.test(name) ? 'chatgpt' : /\.local\.txt$/.test(name) ? 'local' : 'grok');
const safeListed = review => Array.isArray(review.investigated_safe) && review.investigated_safe.some(x => String(x).trim());

/** One leg read by this tree: converted, and whether it posts as a structured verdict (header). */
function readLeg(text) {
  const json = extractChatJsonRecovering(text);
  const converted = Boolean(json) && inspectReviewFormat(json, 'review').ok;
  if (!converted) return {converted, structured: false, status: classifyReviewText(text).status};
  const review = JSON.parse(json);
  const cutEmpty = review.truncated === true && !review.findings.length;
  const structured = !cutEmpty || (review.merge_recommendation !== 'REQUEST_CHANGES' && safeListed(review));
  return {converted, structured, review, cutEmpty};
}

function rates(rows) {
  const out = {};
  for (const row of rows) for (const key of ['all', row.provider]) {
    out[key] ??= {n: 0, converted: 0, structured: 0};
    out[key].n += 1;
    out[key].converted += Number(row.converted);
    out[key].structured += Number(row.structured);
  }
  return out;
}

const cases = Object.entries(corpus).map(([name, text]) => ({name, provider: providerOf(name), text, set: 'v2'}))
  .concat(Object.entries(old24).map(([name, row]) => ({name, provider: providerOf(name), text: row.text, set: 'old24'})));
const after = cases.map(c => ({...c, ...readLeg(c.text)}));
const meta = new Map(index.map(row => [row.file, row]));

test('the corpus: 163 real legs (88 Grok, 58 ChatGPT, 17 local) and the 24 captures of #172', () => {
  assert.equal(Object.keys(corpus).length, 163);
  assert.equal(Object.keys(old24).length, 24);
  assert.deepEqual(rates(after.filter(c => c.set === 'v2')).grok.n, 88);
  assert.deepEqual(rates(after.filter(c => c.set === 'v2')).chatgpt.n, 58);
  assert.deepEqual(rates(after.filter(c => c.set === 'v2')).local.n, 17);
});

test('conversion and structured rates, before (main@ebb1cdcf) and after: every provider improves or holds', () => {
  const v2 = after.filter(c => c.set === 'v2');
  const before = rates(v2.map(c => {
    const m = meta.get(c.name).main_ebb1cdcf;
    return {provider: c.provider, converted: m.converted, structured: m.posts_as_structured};
  }));
  const now = rates(v2);
  const pct = r => `${r.converted}/${r.n} converted (${(100 * r.converted / r.n).toFixed(1)}%), ${r.structured}/${r.n} structured (${(100 * r.structured / r.n).toFixed(1)}%)`;
  for (const key of ['all', 'grok', 'chatgpt', 'local']) console.log(`raw-corpus-v2 ${key}: before ${pct(before[key])} -> after ${pct(now[key])}`);
  // The baseline recorded with the corpus (summary.json).
  assert.deepEqual(before.all, {n: 163, converted: 156, structured: 92});
  // After: the two bare-quote replies convert; 54 cut-off, empty, non-REQUEST_CHANGES verdicts that list
  // investigated_safe now post structured (clean, coverage incomplete).
  assert.deepEqual(now.all, {n: 163, converted: 158, structured: 148});
  assert.deepEqual(now.grok, {n: 88, converted: 84, structured: 84});
  assert.deepEqual(now.chatgpt, {n: 58, converted: 57, structured: 47});
  assert.deepEqual(now.local, {n: 17, converted: 17, structured: 17});
  for (const key of ['all', 'grok', 'chatgpt', 'local']) {
    assert.ok(now[key].converted >= before[key].converted, key);
    assert.ok(now[key].structured >= before[key].structured, key);
  }
  // The 24 captures of #172 all still convert.
  const old = rates(after.filter(c => c.set === 'old24'));
  assert.deepEqual(old.all, {n: 24, converted: 24, structured: 17});
});

test('what still does not convert, and why: nothing to read, or cut off before / inside its findings', () => {
  const left = after.filter(c => !c.converted).map(c => `${c.name}:${c.status}`).sort();
  assert.deepEqual(left, [
    'job-muwpcwk6-1345.grok.txt:truncated', // findings written without `[` (supplied) and cut inside them
    'job-muyrcz2x-4067.grok.txt:truncated', // cut inside investigated_safe, before findings
    'job-mvfxbrxx-1023.chatgpt.txt:truncated', // cut inside highest_risk, before findings
    'job-mvfz0n0e-1250.grok.txt:none', // the page text was only the "Grok" label
    'job-mvfzpvgg-1330.grok.txt:none', // the page text was only the "Grok" label
  ]);
});

test('every structured-but-not-clean leg left: REQUEST_CHANGES with no finding, or an Instant-tier empty reply', () => {
  for (const c of after.filter(c => c.converted && !c.structured)) {
    assert.equal(c.cutEmpty, true, c.name);
    assert.ok(c.review.merge_recommendation === 'REQUEST_CHANGES' || !safeListed(c.review), c.name);
  }
});

test('server and extension read every case the same', () => {
  for (const c of cases) {
    const server = classifyReviewText(c.text);
    const extension = ext.classifyReviewText(c.text);
    assert.equal(extension.status, server.status, c.name);
    assert.equal(extension.json, server.json, c.name);
  }
});

// ---- Format-only recovery: syntax supplied, never a word changed ----
/** The characters of every string value, in order: what the reply SAYS. */
function words(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => words(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); words(v, out); }
  return out;
}

for (const [name, needle] of [['job-mv2soem0-3240.grok.txt', '"This AI\'s style or rules changed elsewhere'], ['job-mvffb9ms-672.grok.txt', 'for f in "$QUEUE_DIR"/; do']]) {
  test(`${name}: bare quotes inside strings are escaped; the reply converts complete, word for word`, () => {
    const text = corpus[name];
    assert.equal(meta.get(name).main_ebb1cdcf.converted, false, 'did not convert before');
    const out = classifyReviewText(text);
    assert.equal(out.status, 'complete');
    assert.equal(ext.classifyReviewText(text).json, out.json);
    const review = JSON.parse(out.json);
    assert.equal(review.merge_recommendation, 'REQUEST_CHANGES');
    assert.ok(review.findings.length > 0);
    assert.ok(words(review).some(s => s.includes(needle)), 'the quoted text is kept as written');
    // Nothing but escapes was added: the reply's own characters, minus whitespace, read back identically.
    const squash = s => s.replace(/\\(["\\/bfnrtu])/g, '$1').replace(/\s+/g, '');
    assert.equal(squash(out.json), squash(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  });
}

test('normalizeReviewFormat: a bare quote inside a value, key or item is escaped only where it cannot end the string', () => {
  const cases = [
    ['{"a": "say "hi" now", "b": 1}', {a: 'say "hi" now', b: 1}],
    ['{"a": ["x "y", z", "w"]}', {a: ['x "y", z', 'w']}],
    ['{"a": "ends with "quote"", "b": "ok"}', {a: 'ends with "quote"', b: 'ok'}],
    ['{"a": "keeps \\"escaped\\" ones"}', {a: 'keeps "escaped" ones'}],
    ['{"a": "x"} trailing prose', {a: 'x'}],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(JSON.parse(normalizeReviewFormat(text)), want, text);
    assert.equal(ext.normalizeReviewFormat(text), normalizeReviewFormat(text));
  }
});

test('a missing "[" after "findings": is supplied; complete findings convert, findings cut inside never do', () => {
  const finding = {severity: 'P1', file: 'a.ts', line: 1, side: 'RIGHT', title: 't', failure_scenario: 'f', root_cause: 'r', evidence: 'e', recommended_fix: 'x', recommended_test: 'y'};
  const whole = `{"merge_recommendation": "REQUEST_CHANGES", "findings": ${JSON.stringify(finding)}], "investigated_safe": ["a.ts: ok"]}`;
  const out = classifyReviewText(whole);
  assert.equal(out.status, 'complete');
  assert.deepEqual(JSON.parse(out.json).findings, [finding]);
  assert.equal(ext.classifyReviewText(whole).json, out.json);
  const cut = `{"merge_recommendation": "REQUEST_CHANGES", "findings": ${JSON.stringify(finding)}, {"severity": "P1", "file": "b.ts", "title": "cut`;
  assert.equal(classifyReviewText(cut).status, 'truncated', 'a finding may be missing: nothing recovered');
  assert.equal(extractChatJsonRecovering(cut), null);
  assert.equal(ext.classifyReviewText(cut).status, 'truncated');
  // Real: Grok wrote its findings without `[` and was cut inside them.
  assert.equal(classifyReviewText(corpus['job-muwpcwk6-1345.grok.txt']).status, 'truncated');
});

test('the residual text around a format-repaired object is kept, as written', () => {
  const parts = extractChatJsonParts('Grok\n\n{"findings": [], "merge_recommendation": "COMMENT", "investigated_safe": ["a "b" c"]}\nafter');
  assert.deepEqual(JSON.parse(parts.json).investigated_safe, ['a "b" c']);
  assert.equal(parts.residual, 'Grok\n\n\n\nafter');
});

// ---- The gate rule, end to end: bridge in, review body out ----
async function bridgeRound(t, name, legs, {salvaged = false, grok = true} = {}) {
  const app = await appFixture({reviewLocal: false, reviewGrok: grok});
  t.after(() => app.close());
  const out = await app.mention(name);
  await eventually(() => app.harbor.getHarbor().jobs.find(j => j.id === out.jobId)?.status === 'awaiting_chat', 'snapshot not ready');
  app.bridge.bridgeHeartbeat();
  const take = app.bridge.takeNextBridgeJob(`${name}-client`);
  assert.equal(take?.jobId, out.jobId, 'the bridge claims the review');
  const result = await app.bridge.completeBridgeJob(out.jobId, legs[0].raw, legs, take.leaseId, salvaged);
  assert.equal(result.ok, true, JSON.stringify(result));
  await eventually(() => app.reviews.length === 1, `review ${out.jobId} was not posted`);
  return {app, body: app.reviews[0].body, job: app.harbor.getHarbor().jobs.find(j => j.id === out.jobId)};
}
const clean = JSON.stringify({findings: [], merge_recommendation: 'COMMENT', investigated_safe: ['a.ts: constant change only']});
const cutClean = corpus['job-mvfoihjo-433.chatgpt.txt']; // COMMENT, findings [] closed, investigated_safe listed, cut in coverage
const cutCleanGrok = old24['job-mvgc6vw3-890.json'].text; // Grok APPROVE, findings [] closed, cut in coverage

test('a reply cut off in its coverage after a complete, empty, non-REQUEST_CHANGES verdict reads clean, with its reply as evidence and coverage incomplete', async t => {
  const recovered = JSON.parse(extractChatJsonRecovering(cutClean));
  assert.deepEqual([recovered.truncated, recovered.findings.length, recovered.merge_recommendation], [true, 0, 'COMMENT']);
  const {body, job} = await bridgeRound(t, 'cut-clean', [{provider: 'chatgpt', raw: cutClean, originalText: cutClean}], {grok: false});
  assert.equal(body.split('\n')[0], CLEAN_REVIEW_BODY, 'the gate line');
  assert.equal(isZeroFindings(body, {authoredByBot: true}), true, 'the gate passes');
  assert.equal(isConvergedFindings(body), true);
  assert.equal(notCleanOutcomeOf(body), null);
  assert.match(body, /<!-- ashlar-findings total=0 [^>]*coverage=incomplete -->\s*$/);
  assert.match(body, /<!-- ashlar-coverage [^>]*incomplete=chatgpt -->/);
  assert.match(body, /\*\*Coverage incomplete\*\* — ChatGPT's reply was cut off after its verdict/);
  assert.ok(body.includes(REVIEW_RAW_START) && body.includes(REVIEW_RAW_END), 'its reply is posted verbatim');
  assert.ok(body.includes(recovered.highest_risk), 'the reply itself');
  assert.deepEqual([...job.coverageCutProviders], ['chatgpt']);
  assert.equal(job.rawReview, undefined, 'not a salvaged review');
  assert.equal(redactSalvagedReviewBody(body).includes(recovered.highest_risk), false, 'redacted from the public snapshot');
});

test('ChatGPT clean + Grok cut off in coverage after APPROVE with no finding: clean, Grok named, coverage incomplete', async t => {
  const {body, job} = await bridgeRound(t, 'cut-clean-grok', [{provider: 'chatgpt', raw: clean}, {provider: 'grok', raw: cutCleanGrok, originalText: cutCleanGrok}]);
  assert.equal(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), true);
  assert.match(body, /Grok's reply was cut off after its verdict/);
  assert.deepEqual([...job.coverageCutProviders], ['grok']);
  assert.deepEqual([...(job.incompleteProviders ?? [])], []);
});

test('a cut-off reply with no finding but REQUEST_CHANGES is never clean: it posts raw', async t => {
  const text = corpus['job-mvg853lo-704.chatgpt.txt'];
  const recovered = JSON.parse(extractChatJsonRecovering(text));
  assert.deepEqual([recovered.truncated, recovered.findings.length, recovered.merge_recommendation], [true, 0, 'REQUEST_CHANGES']);
  const {body, job} = await bridgeRound(t, 'cut-rc', [{provider: 'chatgpt', raw: text, originalText: text}], {grok: false});
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.equal(notCleanOutcomeOf(body), 'raw');
  assert.equal(job.coverageCutProviders, undefined);
});

test('a cut-off empty reply with no investigated_safe (Instant-tier) stays raw: the gate rule changes no content rule', async t => {
  const text = old24['job-mvg2wn6q-113.chatgpt.json'].text;
  const {body} = await bridgeRound(t, 'cut-instant', [{provider: 'chatgpt', raw: text, originalText: text}], {grok: false});
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.equal(notCleanOutcomeOf(body), 'raw');
});

test('ChatGPT clean + Grok cut off BEFORE its findings: never clean (#1091 safety rule)', async t => {
  const text = corpus['job-muyrcz2x-4067.grok.txt'];
  assert.equal(classifyReviewText(text).status, 'truncated');
  const {body} = await bridgeRound(t, 'cut-before-findings', [{provider: 'chatgpt', raw: clean}, {provider: 'grok', raw: text, originalText: text}], {salvaged: true});
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
  assert.match(body, /No complete review from grok/);
});

test('one leg succeeds with a finding, the other returns nothing readable: total=N, the failed leg named incomplete, never clean', async t => {
  const finding = {severity: 'P1', file: 'a.ts', line: 1, side: 'RIGHT', title: 'Answer changed without a migration', failure_scenario: 'f', root_cause: 'r', evidence: 'a.ts:1', recommended_fix: 'x', recommended_test: 'y'};
  const chatgpt = JSON.stringify({findings: [finding], merge_recommendation: 'REQUEST_CHANGES', investigated_safe: []});
  const grok = corpus['job-mvfz0n0e-1250.grok.txt']; // only the "Grok" label was captured
  const {app, body} = await bridgeRound(t, 'single-leg', [{provider: 'chatgpt', raw: chatgpt}, {provider: 'grok', raw: grok, originalText: grok}], {salvaged: true});
  assert.match(body, /<!-- ashlar-findings total=1 [^>]*p1=1[^>]* -->\s*$/);
  assert.ok(app.reviews[0].comments.some(c => c.body.includes(finding.title)), 'its finding posts inline');
  assert.match(body, /No complete review from grok/);
  assert.notEqual(body.split('\n')[0], CLEAN_REVIEW_BODY);
  assert.equal(isZeroFindings(body, {authoredByBot: true}), false);
});

test('a worker that gave up (salvage envelope) is read once more by the server: a bare-quote reply converts', async t => {
  // Its findings re-pointed at the fixture PR's changed file, so the gate can anchor them.
  let text = corpus['job-mv2soem0-3240.grok.txt'];
  for (const f of JSON.parse(classifyReviewText(text).json).findings) text = text.split(f.file).join('a.ts');
  const envelope = JSON.stringify({findings: [], merge_recommendation: 'COMMENT', raw_review: text});
  const {body} = await bridgeRound(t, 'reread', [{provider: 'chatgpt', raw: envelope, originalText: text}], {salvaged: true, grok: false});
  assert.equal(body.includes(REVIEW_RAW_START), false, 'not posted verbatim');
  assert.match(body, /<!-- ashlar-findings total=2 [^>]*-->\s*$/);
});

test('redactSalvagedReviewBody removes every verbatim block, not only the last', () => {
  const body = `head\n${REVIEW_RAW_START}\nsecret one\n${REVIEW_RAW_END}\nmid\n${REVIEW_RAW_START}\nsecret two\n${REVIEW_RAW_END}\ntail`;
  const out = redactSalvagedReviewBody(body);
  assert.equal(out.includes('secret'), false);
  assert.ok(out.startsWith('head') && out.includes('mid') && out.endsWith('tail'));
});
