// sanitizeProgressEvents keeps only stages that are PROGRESS_LABELS keys, so a stage the extension
// records without a label never reaches review history or the live reviewer status. These rows pin
// that every stage the extension can record is labelled — including the ones built from a template.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {root, source} from './load-source.mjs';
import {background, storage} from './helpers.mjs';
import {PROGRESS_LABELS, sanitizeProgressEvents} from '../../src/lib/review-progress.ts';

/** The stages a progress call can record: string literals among the workerStep / recordReviewStep /
 * step arguments (both arms of a conditional included, arguments of a nested call such as
 * `reason?.includes("preserved")` excluded), and the template literals among them, verbatim. */
function recordedStages(text) {
  const literals = new Set(), templates = new Set();
  for (const call of text.matchAll(/\b(?:workerStep|recordReviewStep|step)\(/g)) {
    const parens = [];
    for (let i = call.index + call[0].length - 1; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
        const literal = text.slice(i + 1, j);
        if (!parens.slice(1).includes('call')) {
          if (c === '`' && literal.includes('${')) templates.add(literal);
          else if (/^[a-z][a-z0-9_]*$/.test(literal)) literals.add(literal);
        }
        i = j;
      } else if (c === '(') {
        parens.push(!parens.length ? 'outer' : /[\w$)\]]/.test(text[i - 1]) ? 'call' : 'group');
      } else if (c === ')') {
        parens.pop();
        if (!parens.length) break;
      }
    }
  }
  return {literals, templates};
}

function extensionStages() {
  const files = readdirSync(join(root, 'extension')).filter(name => name.endsWith('.js'));
  const literals = new Set(), templates = new Set();
  for (const name of files) {
    const found = recordedStages(source(`extension/${name}`));
    found.literals.forEach(stage => literals.add(stage));
    found.templates.forEach(template => templates.add(template));
  }
  return {literals, templates};
}

/** The string members of a `export type Name = "a" | "b";` union, read from source. */
function unionMembers(path, name) {
  const match = source(path).match(new RegExp(`export type ${name}\\s*=([^;]+);`));
  assert.ok(match, `${path} declares ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

/** Every value a template stage can take, keyed by its static prefix. A template stage whose prefix
 * is not listed here fails the guard: declare its expansion so each value is checked for a label. */
const TEMPLATE_STAGES = {
  repair_: unionMembers('src/lib/json-repair-types.ts', 'RepairStatus'),
  // Tab release (#82): finishTabCleanup records preserve_<cause> just before tab_preserved.
  preserve_: ['navigated', 'user_turn', 'edited', 'draft', 'ownership_unknown', 'unreachable', 'other_binding', 'unknown',
    // Tab Lease (Phase 1+): the takeover and restart causes of a preserved tab.
    'user_input', 'user_moved', 'browser_restart'],
  // Tab Lease (Phase 1+): a lease that runs out records lease_expired_<phase>.
  lease_expired_: ['creating', 'opening', 'sending', 'generating', 'answered', 'releasing'],
};

function expandTemplate(template) {
  const prefix = template.slice(0, template.indexOf('${'));
  assert.ok(Object.hasOwn(TEMPLATE_STAGES, prefix), `template stage \`${template}\` has no declared expansion in TEMPLATE_STAGES`);
  assert.match(template, /^[a-z_]+\$\{[^}]+\}$/, `template stage \`${template}\` is exactly <prefix>\${value}`);
  return TEMPLATE_STAGES[prefix].map(value => prefix + value);
}

const unlabelled = stages => [...new Set(stages)].filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)).sort();

/** The stages sanitizeProgressEvents keeps, recorded one event each (sequence and time are valid). */
function kept(stages, sourceName = 'worker') {
  const events = stages.map((stage, i) => ({source: sourceName, sequence: i + 1, stage, at: 1_000 + i}));
  return sanitizeProgressEvents(events).map(event => event.stage);
}

test('every stage the extension records has a history label (sanitizeProgressEvents drops unlabelled ones)', () => {
  const {literals, templates} = extensionStages();
  assert.ok(literals.has('tab_closed') && literals.has('generating') && literals.has('prompt_submitted'),
    'sanity: the scan sees worker, page and composer stages');
  assert.equal(literals.has('preserved'), false, 'a nested call argument is not a stage');
  assert.ok(templates.has('repair_${status.status}'), 'sanity: the scan sees template stages');
  const stages = [...literals, ...[...templates].flatMap(expandTemplate)];
  assert.deepEqual(unlabelled(stages), [], 'recorded stages without a PROGRESS_LABELS entry never reach review history');
  assert.deepEqual(kept(stages, 'worker'), stages);
  assert.deepEqual(kept(stages, 'page'), stages);
});

test('salvaged_no_repair (worker: invalid reply delivered as a raw review, no accepted repair) reaches history', () => {
  assert.deepEqual(kept(['salvaged_no_repair']), ['salvaged_no_repair']);
});

test('salvaged_no_repair is recorded with Local JSON repair on too, so its label does not claim repair was off', async () => {
  // Two call sites record it: repairProvider with repair off (the reply goes out verbatim and the server
  // salvages it), and the stall sweep after a repair that ended without being accepted (repair on; the
  // worker sends salvageReviewEnvelope's canonical raw_review, not the reply). The label holds for both.
  const job = {jobId: 'A', origin: 'http://bridge', leaseId: 'lease-A', prompt: 'review A', serverStatus: 'awaiting_chat',
    localJsonRepairEnabled: true, providers: ['chatgpt'],
    states: {chatgpt: {started: true, runId: 'run-A', tabId: 10,
      workerEvents: [{source: 'worker', sequence: 1, stage: 'submitted', at: Date.now() - 24 * 3_600_000}],
      sourceCapture: {archiveDurable: true, text: 'prose, not JSON', totalChars: 15, sourceHash: 'h', responseId: 'r', id: 'cap'},
      repairAttempt: {id: 'ra', status: 'needs_attention', sourceHash: 'h', responseId: 'r'}}}};
  const b = background({
    local: storage({origin: 'http://bridge', token: 'token', pendingReviewJobs: {A: job}}),
    tabs: new Map(), handler: () => ({ok: false, code: 'job_mismatch'}),
  });
  await b.context.clearStuckJobs({includeStalled: true});
  const stages = b.calls.flatMap(call => call.progress?.chatgpt?.events?.map(event => event.stage) ?? []);
  assert.ok(stages.includes('salvaged_no_repair'), 'the sweep records salvaged_no_repair for a repair-on leg');
  const complete = b.calls.find(call => call.action === 'complete' && call.jobId === 'A');
  assert.notEqual(complete.raw, 'prose, not JSON', 'the reply is not delivered verbatim here');
  assert.equal(JSON.parse(complete.raw).raw_review, 'prose, not JSON', 'it is delivered as a raw review');
  assert.doesNotMatch(PROGRESS_LABELS.salvaged_no_repair, /repair off|verbatim/i);
  assert.match(PROGRESS_LABELS.salvaged_no_repair, /raw review/i);
});

test('a template stage without a declared expansion fails the guard instead of passing unchecked', () => {
  assert.throws(() => expandTemplate('undeclared_${phase}'), /no declared expansion/);
  assert.throws(() => expandTemplate('repair_${status.status}_late'), /exactly <prefix>/);
  const {templates} = recordedStages('workerStep(job, provider, `repair_${status.status}`);');
  assert.deepEqual([...templates], ['repair_${status.status}']);
});

test('the tab-release (#82) stages have history labels and survive sanitize', () => {
  const stages = ['cancelled', 'cleanup_waiting_page', 'tab_preserved', 'tab_closed',
    ...expandTemplate('preserve_${state.preserveCause}')];
  assert.deepEqual(unlabelled(stages), []);
  assert.deepEqual(kept(stages, 'worker'), stages);
  assert.deepEqual(kept(['cancelled'], 'page'), ['cancelled'], '#82: the page records cancelled when its run is stopped');
});

test('tab_preserved names no cause of its own: the worker preserves for non-user reasons too, and preserve_<cause> carries why', () => {
  assert.doesNotMatch(PROGRESS_LABELS.tab_preserved, /user|repurpos/i);
});

/** The stages the Tab Lease redesign (Phase 1+) records. Labelled before the extension ships them:
 * a stage recorded ahead of its label is dropped by sanitizeProgressEvents for good. */
const TAB_LEASE_STAGES = ['tab_lost', 'tab_rekeyed', 'user_touched', 'dom_drift', 'dom_evidence_without_touch',
  'lifecycle_diverged', 'group_expanded', 'preserve_user_input', 'preserve_user_moved', 'preserve_browser_restart',
  ...expandTemplate('lease_expired_${phase}')];

test('the Tab Lease stages have history labels and survive sanitize from either source', () => {
  assert.equal(TAB_LEASE_STAGES.length, 16);
  assert.deepEqual(unlabelled(TAB_LEASE_STAGES), []);
  assert.deepEqual(kept(TAB_LEASE_STAGES, 'worker'), TAB_LEASE_STAGES);
  assert.deepEqual(kept(TAB_LEASE_STAGES, 'page'), TAB_LEASE_STAGES);
  for (const stage of TAB_LEASE_STAGES) assert.ok(PROGRESS_LABELS[stage].trim(), `${stage} has a non-empty label`);
});

test('the stage allow-list stays closed: a detail suffix or an undeclared phase is still dropped', () => {
  // The redesign doc writes dom_drift:<kind> and lifecycle_diverged:<ours>/<legacy>; only the bare
  // stage is a label key, so the detail has to travel outside the stage name.
  assert.deepEqual(kept(['dom_drift:follow_up', 'lifecycle_diverged:closed/preserved', 'lease_expired_unknown', 'preserve_']), []);
});

test('every labelled stage fits the bound the worker puts on page stage names', () => {
  const bound = source('extension/background.js').match(/\be\.stage\.length\s*<\s*(\d+)/);
  assert.ok(bound, 'the worker bounds the length of a page-reported stage');
  assert.deepEqual(Object.keys(PROGRESS_LABELS).filter(stage => stage.length >= Number(bound[1])), []);
});
