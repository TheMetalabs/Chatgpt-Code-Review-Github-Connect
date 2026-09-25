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

/** The progress recorders and the position of their stage argument. */
const RECORDERS = {workerStep: 2, recordReviewStep: 0, step: 0};
const STAGE_NAME = /^[a-z][a-z0-9_]*$/;
const CLOSERS = {'(': ')', '[': ']', '{': '}'};
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'do', 'else', 'yield', 'await']);

/** One bracket level of JavaScript from `i` up to `close`, as tokens: str, tpl (with `subst` when it
 * has a ${}), regex, word, punct (`??`, `?.` and `||` whole) and group (a bracketed run holding its own
 * tokens). Comments and whitespace are dropped. A closer that does not match throws. */
function tokenize(text, i, close) {
  const tokens = [];
  const push = (kind, from, to, extra = {}) => { tokens.push({kind, at: from, text: text.slice(from, to), ...extra}); return to; };
  while (i < text.length && text[i] !== close) {
    const c = text[i], prev = tokens.at(-1);
    if (/\s/.test(c)) i += 1;
    else if (text.startsWith('//', i)) i = text.includes('\n', i) ? text.indexOf('\n', i) : text.length;
    else if (text.startsWith('/*', i)) i = text.includes('*/', i + 2) ? text.indexOf('*/', i + 2) + 2 : text.length;
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = push('str', i, j + 1, {value: text.slice(i + 1, j)});
    } else if (c === '`') {
      let j = i + 1, subst = false;
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') j += 2;
        else if (text.startsWith('${', j)) { subst = true; j = tokenize(text, j + 2, '}').end + 1; }
        else j += 1;
      }
      i = push('tpl', i, j + 1, {value: text.slice(i + 1, j), subst});
    } else if (c === '/' && (!prev || prev.kind === 'punct' || (prev.kind === 'word' && REGEX_AFTER.has(prev.text)))) {
      let j = i + 1, inClass = false;
      for (; j < text.length && (text[j] !== '/' || inClass); j += 1) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
      }
      for (j += 1; /[a-z]/i.test(text[j] ?? ''); j += 1);
      i = push('regex', i, j);
    } else if (CLOSERS[c]) {
      const inner = tokenize(text, i + 1, CLOSERS[c]);
      if (text[inner.end] !== CLOSERS[c]) throw new Error(`unclosed ${c}`);
      i = push('group', i, inner.end + 1, {open: c, tokens: inner.tokens});
    } else if (')]}'.includes(c)) throw new Error(`unexpected ${c}`);
    else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      i = push('word', i, j);
    } else i = push('punct', i, i + (['??', '?.', '||'].find(op => text.startsWith(op, i)) ?? c).length);
  }
  return {tokens, end: i};
}

const isPunct = (token, text) => token.kind === 'punct' && token.text === text;

/** Adds the stages a stage-argument expression can take to `found`: a string or template literal,
 * through parentheses, both arms of a conditional (its test is not a stage) and each operand of || and
 * ??. Anything else (a variable, a call, a concatenation) is a problem: the guard cannot see its value. */
function stageValues(text, tokens, found, where) {
  if (tokens.length === 1 && tokens[0].kind === 'group' && tokens[0].open === '(') return stageValues(text, tokens[0].tokens, found, where);
  const question = tokens.findIndex(token => isPunct(token, '?'));
  if (question >= 0) {
    let nested = 0, colon = -1;
    for (let k = question + 1; k < tokens.length && colon < 0; k += 1) {
      if (isPunct(tokens[k], '?')) nested += 1;
      else if (isPunct(tokens[k], ':')) nested ? nested -= 1 : colon = k;
    }
    if (colon < 0) return found.problems.push(`${where}: a conditional stage without its ':' arm`);
    stageValues(text, tokens.slice(question + 1, colon), found, where);
    return stageValues(text, tokens.slice(colon + 1), found, where);
  }
  const or = tokens.findIndex(token => isPunct(token, '||') || isPunct(token, '??'));
  if (or >= 0) {
    stageValues(text, tokens.slice(0, or), found, where);
    return stageValues(text, tokens.slice(or + 1), found, where);
  }
  const [only] = tokens;
  if (tokens.length === 1 && only.kind === 'tpl' && only.subst) return found.templates.add(only.value);
  if (tokens.length === 1 && (only.kind === 'str' || only.kind === 'tpl')) {
    if (STAGE_NAME.test(only.value)) return found.literals.add(only.value);
    return found.problems.push(`${where}: ${only.text} is not a stage name (${STAGE_NAME})`);
  }
  const expression = tokens.length ? text.slice(tokens[0].at, tokens.at(-1).at + tokens.at(-1).text.length) : '(missing)';
  found.problems.push(`${where}: stage \`${expression}\` is not a literal, so its value cannot be checked for a label`);
}

/** The bodies of the recorders declared in `text`, with the name of their stage parameter. Passing that
 * parameter on to another recorder is safe: every call of the enclosing recorder is itself checked. */
function recorderBodies(text) {
  const bodies = [];
  for (const match of text.matchAll(/\bfunction\s+(workerStep|recordReviewStep|step)\s*\(([^)]*)\)\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    try {
      const {end} = tokenize(text, open + 1, '}');
      bodies.push({param: match[2].split(',')[RECORDERS[match[1]]]?.trim(), from: open, to: end});
    } catch { /* an unbalanced body forwards nothing */ }
  }
  return bodies;
}

/** Whether a call sits in a comment, given the text before it on its line. */
function commentedOut(before) {
  if (/^\s*\*/.test(before)) return true; // a JSDoc continuation line
  for (let i = 0; i < before.length; i += 1) {
    const c = before[i];
    if (c === '"' || c === "'" || c === '`') for (i += 1; i < before.length && before[i] !== c; i += before[i] === '\\' ? 2 : 1);
    else if (before.startsWith('//', i)) return true;
    else if (before.startsWith('/*', i)) {
      if (!before.includes('*/', i + 2)) return true;
      i = before.indexOf('*/', i + 2) + 1;
    }
  }
  return false;
}

/** Every stage a recorder call in `text` can record, by the position of its stage argument: the
 * literals, the template literals verbatim, and a problem for each stage argument the guard cannot read. */
function recordedStages(text, file = 'source') {
  const found = {literals: new Set(), templates: new Set(), problems: []};
  const bodies = recorderBodies(text);
  for (const call of text.matchAll(/\b(workerStep|recordReviewStep|step)\s*\(/g)) {
    const before = text.slice(text.lastIndexOf('\n', call.index) + 1, call.index);
    if (commentedOut(before) || /\bfunction\s*$/.test(before)) continue; // a comment or the declaration
    const where = `${file}:${text.slice(0, call.index).split('\n').length} ${call[1]}()`;
    let tokens;
    try {
      const open = call.index + call[0].length - 1, inner = tokenize(text, open + 1, ')');
      if (text[inner.end] !== ')') throw new Error('unclosed (');
      tokens = inner.tokens;
    } catch (error) {
      found.problems.push(`${where}: arguments could not be read (${error.message})`);
      continue;
    }
    const args = [[]];
    for (const token of tokens) isPunct(token, ',') ? args.push([]) : args.at(-1).push(token);
    const arg = args[RECORDERS[call[1]]] ?? [];
    const forwarded = arg.length === 1 && arg[0].kind === 'word' &&
      bodies.some(body => body.from < call.index && call.index < body.to && body.param === arg[0].text);
    if (!forwarded) stageValues(text, arg, found, where);
  }
  return found;
}

function extensionStages() {
  const files = readdirSync(join(root, 'extension')).filter(name => name.endsWith('.js'));
  const literals = new Set(), templates = new Set(), problems = [];
  for (const name of files) {
    const found = recordedStages(source(`extension/${name}`), name);
    found.literals.forEach(stage => literals.add(stage));
    found.templates.forEach(template => templates.add(template));
    problems.push(...found.problems);
  }
  return {literals, templates, problems};
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
  const {literals, templates, problems} = extensionStages();
  assert.deepEqual(problems, [], 'every stage argument is a literal the guard can check');
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

test('a stage argument the guard cannot read fails it instead of passing unchecked', () => {
  const problems = text => recordedStages(text, 'fixture.js').problems;
  for (const text of [
    'const stage = expired ? `lease_expired_${phase}` : "tab_lost"; workerStep(job, provider, stage);',
    'for (const entry of row.log) workerStep(job, provider, entry.fact);',
    'workerStep(job, provider, leaseStage(row));',
    'workerStep(job, provider, "dom_drift:" + kind);',
    'recordReviewStep(cause || "context_changed");',
    'function note(stage) { recordReviewStep(stage); }',
    'function step(cause) { recordReviewStep(stage); }',
    'workerStep(job, provider);',
  ]) assert.equal(problems(text).length, 1, `${text} is a problem, not a silent pass`);
  assert.match(problems('workerStep(job, provider, "dom_drift:follow_up");')[0], /not a stage name/);
  assert.match(problems('step(`Tab_Lost`);')[0], /not a stage name/);
});

test('the guard reads the stage argument by position: other arguments, a conditional test and a forwarding recorder are not stages', () => {
  const read = text => {
    const found = recordedStages(text, 'fixture.js');
    return {literals: [...found.literals].sort(), templates: [...found.templates], problems: found.problems};
  };
  assert.deepEqual(read('workerStep(job, "chatgpt", "tab_created");'), {literals: ['tab_created'], templates: [], problems: []});
  assert.deepEqual(read('workerStep(job, /[")]/.test(p) ? p : "x", "tab_created");'), {literals: ['tab_created'], templates: [], problems: []});
  assert.deepEqual(read('workerStep(job, provider, reason?.includes("preserved") ? "tab_preserved" : done ? "tab_closed" : "tab_lost");'),
    {literals: ['tab_closed', 'tab_lost', 'tab_preserved'], templates: [], problems: []});
  assert.deepEqual(read('recordReviewStep(!done ? (stop || streaming ? "generating" : "waiting_for_response") : e?.code ?? "error");'),
    {literals: ['error', 'generating', 'waiting_for_response'], templates: [],
      problems: ['fixture.js:1 recordReviewStep(): stage `e?.code` is not a literal, so its value cannot be checked for a label']});
  assert.deepEqual(read('recordReviewStep(/* why */ "cancelled" /* ) */); // step(nothing)\n/* step(nothing) */ step("tab_created");\n  * step(nothing)'),
    {literals: ['cancelled', 'tab_created'], templates: [], problems: []});
  assert.deepEqual(read('const url = "http://x"; step(`${kind}`);').problems.length, 0, 'a // inside a string is not a comment');
  assert.deepEqual(read('const url = "http://x"; step(`${kind}`);').templates, ['${kind}']);
  // composer.js: step() forwards its own stage parameter; every step() call is checked instead.
  assert.deepEqual(read('function step(stage) {\n  if (typeof recordReviewStep === "function") recordReviewStep(stage);\n}\nstep("composer_waiting");'),
    {literals: ['composer_waiting'], templates: [], problems: []});
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
