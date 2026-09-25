// sanitizeProgressEvents keeps only stages that are PROGRESS_LABELS keys, so a stage the extension
// records without a label never reaches review history or the live reviewer status. These rows pin
// that every stage the extension can record is labelled — including the ones built from a template.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, sep} from 'node:path';
import {root, source} from './load-source.mjs';
import {background, storage} from './helpers.mjs';
import {PROGRESS_LABELS, sanitizeProgressEvents} from '../../src/lib/review-progress.ts';

/** The progress recorders and the position of their stage argument. */
const RECORDERS = {workerStep: 2, recordReviewStep: 0, step: 0};
const STAGE_NAME = /^[a-z][a-z0-9_]*$/;
const CLOSERS = {'(': ')', '[': ']', '{': '}'};
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'do', 'else', 'yield', 'await']);
/** Statements whose parenthesised head is followed by a statement, which may start with a regex. */
const HEADED = new Set(['if', 'while', 'for', 'with']);
/** Punctuators read whole, longest first. An operator read in pieces changes what follows it: after
 * `i++` a `/` divides, while after `+` it starts a regex that would swallow the code up to the next `/`;
 * and `a = b` assigns where `a == b`, `a <= b` and `a => b` do not. */
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

/** An escape that spells an identifier character (`st\u0061ge` is the name stage): the character and
 * the escape's length at `i`, or null. */
function escapeAt(text, i) {
  const escape = /\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/iy;
  escape.lastIndex = i;
  const match = escape.exec(text);
  return match && {char: String.fromCodePoint(parseInt(match[1] ?? match[2], 16)), length: match[0].length};
}

/** One bracket level of JavaScript from `i` up to `close` (the end of `text` when there is none), as
 * tokens: str, tpl (`substs` holds the tokens of each ${}), regex, word (its text is the name, escapes
 * decoded), punct (PUNCTUATORS whole) and group (a bracketed run holding its own tokens), each spanning
 * `at` to `end` in `text`. Comments and whitespace are dropped. A closer that does not match throws. */
function tokenize(text, i, close) {
  const tokens = [];
  const push = (kind, from, to, extra = {}) => { tokens.push({kind, at: from, end: to, text: text.slice(from, to), ...extra}); return to; };
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
      let j = i + 1;
      const substs = [];
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') j += 2;
        else if (text.startsWith('${', j)) {
          const inner = tokenize(text, j + 2, '}');
          substs.push(inner.tokens);
          j = inner.end + 1;
        } else j += 1;
      }
      i = push('tpl', i, j + 1, {value: text.slice(i + 1, j), substs});
    } else if (c === '/' && (!prev || (prev.kind === 'punct' && prev.text !== '++' && prev.text !== '--') ||
        (prev.kind === 'word' && REGEX_AFTER.has(prev.text)) || (prev.open === '(' && HEADED.has(tokens.at(-2)?.text)))) {
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
    else if (/[\w$]/.test(c) || escapeAt(text, i)) {
      let j = i, name = '';
      for (let escape; j < text.length; ) {
        if ((escape = escapeAt(text, j))) { name += escape.char; j += escape.length; }
        else if (/[\w$]/.test(text[j])) name += text[j++];
        else break;
      }
      i = push('word', i, j, {text: name});
    } else i = push('punct', i, i + (PUNCTUATORS.find(op => text.startsWith(op, i)) ?? c).length);
  }
  return {tokens, end: i};
}

const isPunct = (token, text) => token?.kind === 'punct' && token.text === text;
/** The operators that assign to their left side. */
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);

/** The comma-separated arguments of a call's token run. */
function argumentsOf(tokens) {
  const args = [[]];
  for (const token of tokens) isPunct(token, ',') ? args.push([]) : args.at(-1).push(token);
  return args;
}

/** Adds the stages a stage-argument expression can take to `found`: a string or template literal,
 * through parentheses, both arms of a conditional (its test is not a stage) and each operand of || and
 * ??. Anything else (a variable, a call, a concatenation) is a problem: the guard cannot see its value.
 * So is an assignment: it binds looser than a conditional, so `x += late ? "a" : "b"` records x + "a". */
function stageValues(text, tokens, found, where) {
  if (tokens.length === 1 && tokens[0].kind === 'group' && tokens[0].open === '(') return stageValues(text, tokens[0].tokens, found, where);
  const expression = tokens.length ? text.slice(tokens[0].at, tokens.at(-1).end) : '(missing)';
  if (tokens.some(token => token.kind === 'punct' && ASSIGN.has(token.text))) {
    return found.problems.push(`${where}: stage \`${expression}\` assigns, so what it records is the assigned value, which cannot be checked for a label`);
  }
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
  if (tokens.length === 1 && only.kind === 'tpl' && only.substs.length) return found.templates.add(only.value);
  if (tokens.length === 1 && (only.kind === 'str' || only.kind === 'tpl')) {
    if (STAGE_NAME.test(only.value)) return found.literals.add(only.value);
    return found.problems.push(`${where}: ${only.text} is not a stage name (${STAGE_NAME})`);
  }
  found.problems.push(`${where}: stage \`${expression}\` is not a literal, so its value cannot be checked for a label`);
}

/** Calls `visit(token, level, k, container)` for every token of `level` and of the groups and template
 * substitutions inside it; `container` is the group or template holding `level` (none for the file). */
function walkTokens(level, visit, container) {
  level.forEach((token, k) => {
    visit(token, level, k, container);
    for (const inner of token.kind === 'group' ? [token.tokens] : token.substs ?? []) walkTokens(inner, visit, token);
  });
}

/** The argument group of the recorder call at `level[k]`, `name(...)` or `name?.(...)`, else null.
 * `name(...) {...}` is not a call: a function declaration's name, a method named after the recorder (or
 * a call followed by a block), whose parentheses may bind the stage name. */
function recorderCall(level, k) {
  const token = level[k];
  if (token?.kind !== 'word' || !Object.hasOwn(RECORDERS, token.text)) return null;
  const at = isPunct(level[k + 1], '?.') ? k + 2 : k + 1, group = level[at];
  return group?.kind === 'group' && group.open === '(' && level[at + 1]?.open !== '{' ? group : null;
}

/** Whether `level[k]` starts a statement: first in the file or a block, or after `;` or a bracketed run
 * (an if head, a block, a call ended by a line break). A function there is a declaration; anywhere else
 * it is an expression, which is called through whatever holds it rather than by its name. */
const startsStatement = (level, k, container) => (!container || container.open === '{') &&
  (k === 0 || isPunct(level[k - 1], ';') || level[k - 1].kind === 'group');

/** Names that reach a binding without naming it: a sloppy-mode `arguments[i] = x` rebinds a parameter,
 * and eval and with can reassign or shadow one. */
const INDIRECT = new Set(['arguments', 'eval', 'with']);

/** Whether a recorder body (`tokens`) passes its stage parameter `param` on unchanged. The name may
 * appear only as the whole stage argument of recorder calls: an assignment, a declaration, a nested
 * function's parameter or a catch binding of it is another appearance, so the body is not trusted to
 * forward it. Property names (`x.stage`) are not the binding; a spread (`...stage`) is. */
function forwardsUnchanged(tokens, param) {
  return tokens.every((token, k) => {
    const prev = tokens[k - 1];
    if (token.kind === 'word') {
      const property = isPunct(prev, '?.') || isPunct(prev, '.');
      return property || (token.text !== param && !INDIRECT.has(token.text));
    }
    if (token.kind === 'tpl') return token.substs.every(inner => forwardsUnchanged(inner, param));
    if (token.kind !== 'group') return true;
    const caller = [k - 1, k - 2].find(j => recorderCall(tokens, j) === token);
    const [stage, ...rest] = caller === undefined ? [] : argumentsOf(token.tokens)[RECORDERS[tokens[caller].text]] ?? [];
    const forwarded = !rest.length && stage?.kind === 'word' && stage.text === param ? stage : null;
    return forwardsUnchanged(token.tokens.filter(inner => inner !== forwarded), param);
  });
}

/** The bodies of the recorders declared in a file's `tokens` (a declaration in a comment or a string is
 * none), each with the name of its stage parameter when the body passes it on unchanged, else null.
 * Forwarding that parameter to another recorder is safe: every use of the enclosing recorder's name is a
 * checked call, and a declaration is reached only by its name (a function expression named after a
 * recorder forwards nothing). Its parameters must be plain names, the stage one once: a default value
 * can reassign it, and a repeated name binds the last one. */
function recorderBodies(tokens) {
  const bodies = [];
  walkTokens(tokens, (token, level, k, container) => {
    const [name, params, body] = level.slice(k + 1, k + 4);
    if (token.kind === 'word' && token.text === 'function' && name?.kind === 'word' && Object.hasOwn(RECORDERS, name.text) &&
        params?.kind === 'group' && params.open === '(' && body?.kind === 'group' && body.open === '{') {
      const names = argumentsOf(params.tokens).map(param => param.length === 1 && param[0].kind === 'word' ? param[0].text : null);
      const param = names[RECORDERS[name.text]];
      const plain = param && names.every(Boolean) && names.filter(other => other === param).length === 1;
      const declared = startsStatement(level, k, container);
      bodies.push({param: declared && plain && forwardsUnchanged(body.tokens, param) ? param : null, from: body.at, to: body.end});
    }
  });
  return bodies;
}

/** Every stage a recorder call in `text` can record, by the position of its stage argument: the
 * literals, the template literals verbatim, and a problem for each stage argument the guard cannot read.
 * Calls are found in the tokens, so a comment or a string is never one, and one is never hidden by a
 * comment or a regex before it. A file the tokenizer cannot read is itself a problem. So is any other
 * use of a recorder's name than a call, its function declaration or `typeof name`: a recorder passed as
 * a value, aliased, or called through .call or .apply records a stage no call here shows. */
function recordedStages(text, file = 'source') {
  const found = {literals: new Set(), templates: new Set(), problems: []};
  let tokens;
  try { ({tokens} = tokenize(text, 0)); } catch (error) {
    found.problems.push(`${file}: could not be tokenized (${error.message}), so its recorder calls cannot be read`);
    return found;
  }
  const bodies = recorderBodies(tokens);
  walkTokens(tokens, (token, level, k) => {
    if (token.kind !== 'word' || !Object.hasOwn(RECORDERS, token.text)) return;
    const group = recorderCall(level, k), before = level[k - 1];
    const where = `${file}:${text.slice(0, token.at).split('\n').length} ${token.text}`;
    if (!group) {
      if (before?.kind === 'word' && (before.text === 'function' || before.text === 'typeof')) return;
      return found.problems.push(level[k + 1]?.open === '('
        ? `${where}(...) {...}: a method named after a recorder, or a call followed by a block, is not read as a call`
        : `${where}: the recorder is used other than by a call, so the stages it records through that use cannot be checked`);
    }
    const arg = argumentsOf(group.tokens)[RECORDERS[token.text]] ?? [];
    const forwarded = arg.length === 1 && arg[0].kind === 'word' &&
      bodies.some(body => body.from < token.at && token.at < body.to && body.param === arg[0].text);
    if (!forwarded) stageValues(text, arg, found, `${where}()`);
  });
  return found;
}

/** The extension's scripts at any depth under `dir`, {path relative to it: text}. A recorder call in
 * a script below the top level records stages too. */
function extensionFiles(dir = join(root, 'extension')) {
  const paths = readdirSync(dir, {recursive: true}).filter(path => /\.[cm]?js$/.test(path) && statSync(join(dir, path)).isFile());
  return Object.fromEntries(paths.sort().map(path => [path.split(sep).join('/'), readFileSync(join(dir, path), 'utf8')]));
}

function extensionStages(files) {
  const literals = new Set(), templates = new Set(), problems = [];
  for (const [name, text] of Object.entries(files)) {
    const found = recordedStages(text, name);
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

/** The strings of `function name() { return [...]; }` in any of `files`, or null when none defines it. */
function returnedList(files, name) {
  const pattern = new RegExp(`\\bfunction\\s+${name}\\s*\\(\\s*\\)\\s*\\{\\s*return\\s*\\[([^\\]]*)\\]\\s*;?\\s*\\}`);
  const match = Object.values(files).map(text => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const items = match[1].split(',').map(item => item.trim()).filter(Boolean);
  const values = items.map(item => /^"([^"\\]*)"$|^'([^'\\]*)'$/.exec(item)).map(m => m && (m[1] ?? m[2]));
  assert.ok(values.every(value => typeof value === 'string'), `${name}() returns a list of string literals only`);
  return values;
}

/** The values of a template stage, keyed by its static prefix and then by the whole `${...}` expression
 * it substitutes. The prefix says nothing about the value: `preserve_${row.cause}` does not take
 * preserveCauses()'s values because it starts with preserve_. So each expression the extension records
 * is declared here with a reader of its value domain, the list the code draws that expression's value
 * from (null when it is not in source); `declared` holds values labelled ahead of the code. A recorded
 * template expands to both, so a value added only in the code still needs a label. A recorded template
 * whose prefix or expression is not declared here, or whose list is not found in source, fails the guard. */
const TEMPLATE_STAGES = {
  // background.js: `status` is the bridge's repair reply, whose status is a RepairStatus.
  repair_: {declared: [], expressions: {'status.status': () => unionMembers('src/lib/json-repair-types.ts', 'RepairStatus')}},
  // Tab release (#82): finishTabCleanup sets state.preserveCause to one of preserveCauses(), then records
  // preserve_${state.preserveCause}.
  preserve_: {expressions: {'state.preserveCause': files => returnedList(files, 'preserveCauses')},
    declared: ['navigated', 'user_turn', 'edited', 'draft', 'ownership_unknown', 'unreachable', 'other_binding', 'unknown',
      // Tab Lease (Phase 1+): the takeover and restart causes of a preserved tab.
      'user_input', 'user_moved', 'browser_restart']},
  // Tab Lease (Phase 1+): a lease that runs out records lease_expired_<phase>. Nothing lists the phases in
  // code yet: when the extension records this template, its expression goes here with a reader of its phases.
  lease_expired_: {expressions: {}, declared: ['creating', 'opening', 'sending', 'generating', 'answered', 'releasing']},
};

/** Every stage a recorded template can produce, given the extension's scripts. */
function expandTemplate(template, files) {
  const prefix = template.slice(0, template.indexOf('${'));
  assert.ok(Object.hasOwn(TEMPLATE_STAGES, prefix), `template stage \`${template}\` has no declared expansion in TEMPLATE_STAGES`);
  assert.match(template, /^[a-z_]+\$\{[^}]+\}$/, `template stage \`${template}\` is exactly <prefix>\${value}`);
  const {declared, expressions} = TEMPLATE_STAGES[prefix];
  const expression = template.slice(prefix.length + 2, -1).trim();
  assert.ok(Object.hasOwn(expressions, expression),
    `template stage \`${template}\`: \`${expression}\` is not a declared ${prefix} expression, so the values it can take are unknown`);
  const values = expressions[expression](files);
  assert.ok(values, `template stage \`${template}\` is recorded, but the list of its values was not found in source`);
  return [...new Set([...declared, ...values])].map(value => prefix + value);
}

/** The stages labelled ahead of the code for a template prefix. */
const declaredStages = prefix => TEMPLATE_STAGES[prefix].declared.map(value => prefix + value);

/** Every stage `files` can record, and the stage arguments the guard could not read. */
function guardedStages(files) {
  const {literals, templates, problems} = extensionStages(files);
  return {literals, templates, problems, stages: [...literals, ...[...templates].flatMap(template => expandTemplate(template, files))]};
}

const unlabelled = stages => [...new Set(stages)].filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)).sort();

/** The stages sanitizeProgressEvents keeps, recorded one event each (sequence and time are valid). */
function kept(stages, sourceName = 'worker') {
  const events = stages.map((stage, i) => ({source: sourceName, sequence: i + 1, stage, at: 1_000 + i}));
  return sanitizeProgressEvents(events).map(event => event.stage);
}

test('every stage the extension records has a history label (sanitizeProgressEvents drops unlabelled ones)', () => {
  const {literals, templates, problems, stages} = guardedStages(extensionFiles());
  assert.deepEqual(problems, [], 'every stage argument is a literal the guard can check');
  assert.ok(literals.has('tab_closed') && literals.has('generating') && literals.has('prompt_submitted'),
    'sanity: the scan sees worker, page and composer stages');
  assert.equal(literals.has('preserved'), false, 'a nested call argument is not a stage');
  assert.ok(templates.has('repair_${status.status}'), 'sanity: the scan sees template stages');
  assert.deepEqual(unlabelled(stages), [], 'recorded stages without a PROGRESS_LABELS entry never reach review history');
  assert.deepEqual(kept(stages, 'worker'), stages);
  assert.deepEqual(kept(stages, 'page'), stages);
});

test('the scan reads extension scripts below the top level, keyed by their path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ashlar-extension-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const write = (path, text) => { mkdirSync(dirname(join(dir, path)), {recursive: true}); writeFileSync(join(dir, path), text); };
  write('background.js', 'workerStep(job, provider, "tab_created");');
  write('runtime/lease.js', '\nworkerStep(job, provider, "lease_nested_unlabelled");');
  write('runtime/page/steps.mjs', 'recordReviewStep(pageStage);');
  write('runtime/notes.txt', 'workerStep(job, provider, "not_a_script");');
  mkdirSync(join(dir, 'runtime/vendor.js'));
  const files = extensionFiles(dir);
  assert.deepEqual(Object.keys(files), ['background.js', 'runtime/lease.js', 'runtime/page/steps.mjs']);
  const {stages, problems} = guardedStages(files);
  assert.deepEqual(unlabelled(stages), ['lease_nested_unlabelled'], 'a nested script\'s unlabelled stage fails the guard');
  assert.deepEqual(problems, ['runtime/page/steps.mjs:1 recordReviewStep(): stage `pageStage` is not a literal, so its value cannot be checked for a label']);
  assert.ok(Object.keys(extensionFiles()).includes('background.js'), 'the top-level scripts keep their names');
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

test('a preserve_ cause added only to preserveCauses() fails the guard: the expansion reads the extension\'s own list', () => {
  const recorder = 'function finish(state) { workerStep(job, provider, `preserve_${state.preserveCause}`); }\n';
  const files = cause => ({'background.js': `function preserveCauses() {\n  return ["navigated", "draft", ${cause}];\n}\n${recorder}`});
  assert.deepEqual(unlabelled(guardedStages(files('"unknown"')).stages), []);
  assert.deepEqual(unlabelled(guardedStages(files('"staged"')).stages), ['preserve_staged'],
    'a cause the extension can record, labelled nowhere');
  assert.deepEqual(kept(['preserve_staged']), [], 'its event would be dropped from history');
  assert.throws(() => guardedStages(files('...LEGACY')), /string literals only/);
  assert.throws(() => guardedStages({'background.js': recorder}), /not found in source/, 'no list, no expansion');
  assert.throws(() => guardedStages({'background.js': 'workerStep(job, provider, `lease_expired_${phase}`);'}),
    /`phase` is not a declared lease_expired_ expression/,
    'Tab Lease: recording lease_expired_<phase> needs its expression declared with a list of the phases in code');
});

test('a template stage takes its declared list only through a declared expression, not through its prefix', () => {
  // preserveCauses() lists only labelled causes, so expanding by prefix would pass; row.cause is not drawn
  // from it and can be preserve_staged, which sanitizeProgressEvents drops.
  const causes = 'function preserveCauses() {\n  return ["navigated", "draft", "unknown"];\n}\n';
  const recorded = expression => ({'background.js': `${causes}workerStep(job, provider, \`preserve_\${${expression}}\`);`});
  assert.deepEqual(unlabelled(guardedStages(recorded('state.preserveCause')).stages), []);
  assert.deepEqual(unlabelled(guardedStages(recorded(' state.preserveCause ')).stages), [], 'spacing inside ${} is not the expression');
  for (const expression of ['row.cause', 'cause', 'state.preserveCause || row.cause', 'state.preserveCause.trim()', 'state?.preserveCause']) {
    assert.throws(() => guardedStages(recorded(expression)), /is not a declared preserve_ expression/, `preserve_\${${expression}}`);
  }
  assert.throws(() => guardedStages({'background.js': 'workerStep(job, provider, `repair_${response.status}`);'}),
    /`response.status` is not a declared repair_ expression/, 'the same for repair_: RepairStatus is the domain of status.status only');
  assert.throws(() => guardedStages({'background.js': 'workerStep(job, provider, `repair_${status.state}`);'}), /not a declared repair_ expression/);
  const {stages} = guardedStages({'background.js': 'workerStep(job, provider, `repair_${status.status}`);'});
  assert.deepEqual(stages.sort(), unionMembers('src/lib/json-repair-types.ts', 'RepairStatus').map(value => `repair_${value}`).sort());
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
  // An assignment binds looser than a conditional: the stage is the assigned value, not an arm.
  for (const op of ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']) {
    assert.deepEqual(problems(`workerStep(job, provider, stage ${op} late ? "tab_lost" : "tab_closed");`), [`fixture.js:1 workerStep(): stage ` +
      `\`stage ${op} late ? "tab_lost" : "tab_closed"\` assigns, so what it records is the assigned value, which cannot be checked for a label`], op);
  }
  assert.deepEqual(problems('workerStep(job, provider, (stage = next()) ? "tab_lost" : "tab_closed");'), [], 'an assignment in the test is not the stage');
  assert.match(problems('step(`Tab_Lost`);')[0], /not a stage name/);
  assert.match(problems('recordReviewStep(st\\u0061ge);')[0], /stage `st\\u0061ge` is not a literal/, 'the problem quotes the source');
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
  assert.deepEqual(read('recordReviewStep(/* why */ "cancelled" /* ) */); // step(nothing)\n/* step(nothing) */ step("tab_created");\n/**\n  * step(nothing)\n  */'),
    {literals: ['cancelled', 'tab_created'], templates: [], problems: []});
  assert.deepEqual(read('const url = "http://x"; step(`${kind}`);').problems.length, 0, 'a // inside a string is not a comment');
  assert.deepEqual(read('const url = "http://x"; step(`${kind}`);').templates, ['${kind}']);
  // composer.js: step() forwards its own stage parameter; every step() call is checked instead.
  assert.deepEqual(read('function step(stage) {\n  if (typeof recordReviewStep === "function") recordReviewStep(stage);\n}\nstep("composer_waiting");'),
    {literals: ['composer_waiting'], templates: [], problems: []});
});

test('a recorder call is found in the tokens: a // in a regex or a comment before its ( hides nothing', () => {
  const read = text => {
    const found = recordedStages(text, 'fixture.js');
    return {literals: [...found.literals], problems: found.problems};
  };
  assert.deepEqual(read('function probe(job, provider, url) { if (/^https:\\/\\/chatgpt\\.com\\//.test(url)) workerStep(job, provider, "after_regex"); }'),
    {literals: ['after_regex'], problems: []}, 'a // inside a regex literal is not a comment');
  assert.deepEqual(read('workerStep /* why */ (job, provider, "after_comment");'), {literals: ['after_comment'], problems: []});
  assert.deepEqual(read('if (/[/]/.test(url)) workerStep(job, provider, "after_class");'), {literals: ['after_class'], problems: []},
    'a / inside a regex character class does not end the regex');
  assert.deepEqual(read('globalThis.recordReviewStep?.("optional_call");'), {literals: ['optional_call'], problems: []}, 'name?.(...) is a call');
  assert.deepEqual(read('workerSt\\u0065p(job, provider, "escaped_name");'), {literals: ['escaped_name'], problems: []});
  assert.deepEqual(read('const doc = "workerStep(job, provider, stage)";'), {literals: [], problems: []}, 'a call in a string is none');
});

test('a recorder is reached only by its calls: a recorder used as a value, an alias or a method is a problem', () => {
  const problems = text => recordedStages(text, 'fixture.js').problems;
  const value = (line, name) => `fixture.js:${line} ${name}: the recorder is used other than by a call, so the stages it records through that use cannot be checked`;
  for (const [text, line, name] of [
    ['["unlabelled_cb"].forEach(step);', 1, 'step'],
    ['setTimeout(step, 0, "unlabelled_timer");', 1, 'step'],
    ['const record = workerStep;\nrecord(job, provider, "unlabelled_alias");', 1, 'workerStep'],
    ['const {recordReviewStep: record} = globalThis;\nrecord("unlabelled_alias");', 1, 'recordReviewStep'],
    ['workerStep.call(null, job, provider, "unlabelled_call");', 1, 'workerStep'],
    ['\nworkerStep.apply(null, [job, provider, "unlabelled_apply"]);', 2, 'workerStep'],
    ['globalThis.recordReviewStep = stage => post(stage);', 1, 'recordReviewStep'],
    ['function pick() {\n  return step;\n}', 2, 'step'],
  ]) assert.deepEqual(problems(text), [value(line, name)], text);
  // A method named after a recorder: its parentheses bind `stage`, so step() no longer forwards, and
  // passing the method on is a use as a value.
  assert.deepEqual(problems('function step(stage) {\n  const o = {recordReviewStep(stage) { recordReviewStep(stage); }};\n  [row.stage].forEach(o.recordReviewStep);\n}\nstep("composer_waiting");'), [
    'fixture.js:2 recordReviewStep(...) {...}: a method named after a recorder, or a call followed by a block, is not read as a call',
    'fixture.js:2 recordReviewStep(): stage `stage` is not a literal, so its value cannot be checked for a label',
    value(3, 'recordReviewStep'),
  ]);
  // A function expression named after a recorder is called through what holds it, never by that name.
  for (const text of ['const record = function step(stage) {\n  recordReviewStep(stage);\n};\nrecord(computeStage());',
    '(function step(stage) {\n  recordReviewStep(stage);\n})(computeStage());']) {
    assert.deepEqual(problems(text), ['fixture.js:2 recordReviewStep(): stage `stage` is not a literal, so its value cannot be checked for a label'], text);
  }
  // typeof and the declaration's own name are not uses that record; a declaration starts a statement.
  assert.deepEqual(problems('function step(stage) {\n  if (typeof recordReviewStep === "function") recordReviewStep(stage);\n}\nstep("composer_waiting");'), []);
  assert.deepEqual(problems('const ready = true;\nfunction step(stage) {\n  recordReviewStep(stage);\n}\nstep("composer_waiting");'), []);
});

test('a recorder forwards its stage parameter only when nothing in its body can change or shadow it', () => {
  const problems = text => recordedStages(text, 'fixture.js').problems;
  const forwarding = body => `function step(stage) {\n  ${body}\n}\nstep("composer_waiting");`;
  // Still forwarding: the parameter reaches the recorder as is; x.stage and row?.stage are other names.
  for (const body of ['recordReviewStep(stage);', 'if (x.stage && row?.stage !== "a") recordReviewStep(stage);',
    'setTimeout(() => recordReviewStep(stage), 0);', 'recordReviewStep(stage); recordReviewStep(stage);',
    'globalThis.recordReviewStep?.(stage);']) {
    assert.deepEqual(problems(forwarding(body)), [], body);
  }
  for (const text of [
    forwarding('stage = computeStage();\n  recordReviewStep(stage);'),
    forwarding('stage ??= fallback;\n  recordReviewStep(stage);'),
    forwarding('if (late) stage += "_late";\n  recordReviewStep(stage);'),
    forwarding('[...stage] = parts;\n  recordReviewStep(stage);'),
    // `++` and `--` are one operator: the `/` after them divides, so it does not hide the assignment.
    forwarding('n = i++ / 2; stage = computeStage(); m = n / 2;\n  recordReviewStep(stage);'),
    forwarding('n = i-- / 2; stage = computeStage(); m = n / 2;\n  recordReviewStep(stage);'),
    // After a call's parentheses (not an if, while, for or with head) a `/` divides too.
    forwarding('n = f(a) / 2; stage = computeStage(); m = n / 2;\n  recordReviewStep(stage);'),
    // An escape in an identifier spells the same name.
    forwarding('st\\u0061ge = computeStage();\n  recordReviewStep(stage);'),
    forwarding('st\\u{61}ge = computeStage();\n  recordReviewStep(stage);'),
    forwarding('\\u0073tage = computeStage();\n  recordReviewStep(stage);'),
    forwarding('var stage = row.stage;\n  recordReviewStep(stage);'),
    forwarding('log(`${stage = computeStage()}`);\n  recordReviewStep(stage);'),
    forwarding('arguments[0] = computeStage();\n  recordReviewStep(stage);'),
    forwarding('eval(patch);\n  recordReviewStep(stage);'),
    forwarding('with (row) recordReviewStep(stage);'),
    // A nested binding of the same name shadows the parameter.
    forwarding('rows.forEach(stage => recordReviewStep(stage));'),
    forwarding('function inner(stage) { recordReviewStep(stage); }\n  inner(computeStage());'),
    forwarding('try { run(); } catch (stage) { recordReviewStep(stage); }'),
    // A nested declaration named after a recorder: its parameters are a binding, not a call's arguments.
    forwarding('function recordReviewStep(stage) { workerStep(job, provider, stage); }\n  recordReviewStep(stage);'),
    // A default value can reassign the parameter before the body runs; a repeated name binds the last one.
    'function step(stage, late = stage += "_late") {\n  recordReviewStep(stage);\n}\nstep("composer_waiting");',
    'function step(stage, stage) {\n  recordReviewStep(stage);\n}\nstep("composer_waiting");',
    // A declaration in a comment or a string is not a recorder.
    'function note(stage) {\n  // function step(stage) {\n  recordReviewStep(stage);\n}',
    'function note(stage) {\n  const doc = "function step(stage) {";\n  recordReviewStep(stage);\n}',
  ]) {
    const found = problems(text);
    assert.equal(found.length, 1, `${text}\n: the forwarded stage is a problem, not a silent pass`);
    assert.match(found[0], /recordReviewStep\(\): stage `stage` is not a literal/);
  }
  // Only a call inside the forwarder's body forwards its parameter: one before or after it is checked.
  const outside = 'fixture.js:%s recordReviewStep(): stage `stage` is not a literal, so its value cannot be checked for a label';
  assert.deepEqual(problems('function step(stage) {\n  recordReviewStep(stage);\n}\nrecordReviewStep(stage);'), [outside.replace('%s', 4)]);
  assert.deepEqual(problems('recordReviewStep(stage);\nfunction step(stage) {\n  recordReviewStep(stage);\n}'), [outside.replace('%s', 1)]);
  // A forwarded stage is the whole stage argument: `stage = computeStage()` starts with the name and
  // reassigns it, so the call after it does not forward either.
  assert.deepEqual(problems(forwarding('recordReviewStep(stage = computeStage());\n  recordReviewStep(stage);')), [
    'fixture.js:2 recordReviewStep(): stage `stage = computeStage()` assigns, so what it records is the assigned value, which cannot be checked for a label',
    'fixture.js:3 recordReviewStep(): stage `stage` is not a literal, so its value cannot be checked for a label',
  ]);
});

test('the tokenizer reads every multi-character operator whole', () => {
  const text = 'a >>>= b ... c === d !== e **= f <<= g >>= h >>> i &&= j ||= k ??= l => m == n != o <= p >= q && r || s ?? t ' +
    '?. u ++ v -- w += x -= y *= z %= a &= b |= c ^= d ** e << f >> g /= h = i < j > k ! l';
  assert.deepEqual(tokenize(text, 0).tokens.filter(token => token.kind === 'punct').map(token => token.text), ['>>>=', '...', '===',
    '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=',
    '-=', '*=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '/=', '=', '<', '>', '!']);
});

test('a file the tokenizer cannot read is a problem that names the file, not a blame on its forwarder', () => {
  // Valid JavaScript the tokenizer misreads: after a block's `}` it takes `/` for division, so the
  // regex's `)` closes nothing. The guard cannot read the file, and says so.
  const text = 'function step(stage) {\n  recordReviewStep(stage);\n}\nfunction probe(b) {}\n/\\)/.test(b);\nstep("composer_waiting");';
  assert.deepEqual(recordedStages(text, 'composer.js').problems, ['composer.js: could not be tokenized (unexpected )), so its recorder calls cannot be read']);
  // After the head of if, while, for or with, a `/` starts a regex: the file tokenizes and step() forwards.
  for (const head of ['if (a)', 'while (a)', 'for (;a;)', 'with (a)']) {
    const readable = `function step(stage) {\n  recordReviewStep(stage);\n}\nfunction probe(a, b) { ${head} /\\)/.test(b); }\nstep("composer_waiting");`;
    assert.deepEqual(recordedStages(readable, 'composer.js').problems, [], head);
  }
});

test('the tab-release (#82) stages have history labels and survive sanitize', () => {
  const stages = ['cancelled', 'cleanup_waiting_page', 'tab_preserved', 'tab_closed',
    ...declaredStages('preserve_')];
  assert.deepEqual(unlabelled(stages), []);
  assert.deepEqual(kept(stages, 'worker'), stages);
  assert.deepEqual(kept(['cancelled'], 'page'), ['cancelled'], '#82: the page records cancelled when its run is stopped');
});

test('tab_preserved points at a preserve cause only when the extension records one', () => {
  // These labels land before #82, and main records tab_preserved with no preserve_<cause> beside it: a
  // label that sends the reader to the cause would point at nothing. That relabel lands with #82.
  const {literals, templates} = guardedStages(extensionFiles());
  const recordsCause = [...literals, ...templates].some(stage => stage.startsWith('preserve_'));
  assert.ok(recordsCause || !/preserve cause/i.test(PROGRESS_LABELS.tab_preserved),
    `tab_preserved (${PROGRESS_LABELS.tab_preserved}) points at a preserve cause the extension never records`);
});

/** The stages the Tab Lease redesign (Phase 1+) records. Labelled before the extension ships them:
 * a stage recorded ahead of its label is dropped by sanitizeProgressEvents for good. */
const TAB_LEASE_STAGES = ['tab_lost', 'tab_rekeyed', 'user_touched', 'dom_drift', 'dom_evidence_without_touch',
  'lifecycle_diverged', 'group_expanded', 'preserve_user_input', 'preserve_user_moved', 'preserve_browser_restart',
  ...declaredStages('lease_expired_')];

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
