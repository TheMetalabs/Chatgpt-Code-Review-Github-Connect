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
const lineOf = (text, token) => text.slice(0, token.at).split('\n').length;
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
function stageValues(text, tokens, found, where, site) {
  const values = part => stageValues(text, part, found, where, site);
  if (tokens.length === 1 && tokens[0].kind === 'group' && tokens[0].open === '(') return values(tokens[0].tokens);
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
    values(tokens.slice(question + 1, colon));
    return values(tokens.slice(colon + 1));
  }
  const or = tokens.findIndex(token => isPunct(token, '||') || isPunct(token, '??'));
  if (or >= 0) {
    values(tokens.slice(0, or));
    return values(tokens.slice(or + 1));
  }
  const [only] = tokens;
  if (tokens.length === 1 && only.kind === 'tpl' && only.substs.length) {
    found.templates.add(only.value);
    return found.sites.push({...site, template: only.value, token: only});
  }
  if (tokens.length === 1 && (only.kind === 'str' || only.kind === 'tpl')) {
    if (STAGE_NAME.test(only.value)) return found.literals.add(only.value);
    return found.problems.push(`${where}: ${only.text} is not a stage name (${STAGE_NAME})`);
  }
  found.problems.push(`${where}: stage \`${expression}\` is not a literal, so its value cannot be checked for a label`);
}

/** Calls `visit(token, level, k, container, path)` for every token of `level` and of the groups and
 * template substitutions inside it; `container` is the group or template holding `level` (none for the
 * file) and `path` the enclosing levels, each as {tokens, index} of the token that holds the next one. */
function walkTokens(level, visit, container, path = []) {
  level.forEach((token, k) => {
    visit(token, level, k, container, path);
    for (const inner of token.kind === 'group' ? [token.tokens] : token.substs ?? []) {
      walkTokens(inner, visit, token, [...path, {tokens: level, index: k}]);
    }
  });
}

/** The frames from `level` down to `target`, {tokens, index} per level, or null when it is not there. */
function pathTo(level, target) {
  for (const [index, token] of level.entries()) {
    if (token === target) return [{tokens: level, index}];
    for (const inner of token.kind === 'group' ? [token.tokens] : token.substs ?? []) {
      const rest = pathTo(inner, target);
      if (rest) return [{tokens: level, index}, ...rest];
    }
  }
  return null;
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
  const found = {literals: new Set(), templates: new Set(), sites: [], problems: []};
  let tokens;
  try { ({tokens} = tokenize(text, 0)); } catch (error) {
    found.problems.push(`${file}: could not be tokenized (${error.message}), so its recorder calls cannot be read`);
    return found;
  }
  const bodies = recorderBodies(tokens);
  walkTokens(tokens, (token, level, k, container, path) => {
    if (token.kind !== 'word' || !Object.hasOwn(RECORDERS, token.text)) return;
    const group = recorderCall(level, k), before = level[k - 1];
    const where = `${file}:${lineOf(text, token)} ${token.text}`;
    if (!group) {
      if (before?.kind === 'word' && (before.text === 'function' || before.text === 'typeof')) return;
      return found.problems.push(level[k + 1]?.open === '('
        ? `${where}(...) {...}: a method named after a recorder, or a call followed by a block, is not read as a call`
        : `${where}: the recorder is used other than by a call, so the stages it records through that use cannot be checked`);
    }
    const arg = argumentsOf(group.tokens)[RECORDERS[token.text]] ?? [];
    const forwarded = arg.length === 1 && arg[0].kind === 'word' &&
      bodies.some(body => body.from < token.at && token.at < body.to && body.param === arg[0].text);
    if (!forwarded) stageValues(text, arg, found, `${where}()`, {text, where: `${where}()`, path, level});
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
  const literals = new Set(), templates = new Set(), sites = [], problems = [];
  for (const [name, text] of Object.entries(files)) {
    const found = recordedStages(text, name);
    found.literals.forEach(stage => literals.add(stage));
    found.templates.forEach(template => templates.add(template));
    sites.push(...found.sites);
    problems.push(...found.problems);
  }
  return {literals, templates, sites, problems};
}

/** Tokens as compact source: no comments or line breaks, a space only between two words. */
const render = tokens => tokens.map((token, k) => (token.kind === 'word' && tokens[k - 1]?.kind === 'word' ? ' ' : '') +
  (token.kind === 'group' ? `${token.open}${render(token.tokens)}${CLOSERS[token.open]}` : token.text)).join('');

/** The `const name = ...` a read at the end of `path` sees: the nearest one before it in a level that
 * encloses the read (a sibling block's declaration is out of scope), as {frame, at, init}, or null. The
 * initialiser runs to the `;`: a second declarator or a missing `;` makes it another expression. */
function constBefore(path, name) {
  for (let frame = path.length - 1; frame >= 0; frame -= 1) {
    const {tokens, index} = path[frame];
    for (let at = index - 1; at > 0; at -= 1) {
      if (tokens[at].kind !== 'word' || tokens[at].text !== name || tokens[at - 1].text !== 'const') continue;
      let end = at + 2; // after the `=`; a declaration without one fails its initialiser
      while (end < tokens.length && !isPunct(tokens[end], ';')) end += 1;
      return {frame, at, init: tokens.slice(at + 2, end)};
    }
  }
  return null;
}

/** Whether `tokens[k]` uses `name` other than as the object of a member read (`name.x` or `name?.x`,
 * not assigned, updated or deleted): a rebinding, an assignment, an argument or an alias can change what
 * `name.x` holds later. with, eval and arguments reach a binding without naming it. */
function misuses(tokens, k, name) {
  const token = tokens[k], before = tokens[k - 1], after = tokens[k + 3];
  if (token.kind !== 'word' || isPunct(before, '.') || isPunct(before, '?.')) return false;
  if (INDIRECT.has(token.text)) return true;
  if (token.text !== name) return false;
  const member = (isPunct(tokens[k + 1], '.') || isPunct(tokens[k + 1], '?.')) && tokens[k + 2]?.kind === 'word';
  const written = after?.kind === 'punct' && (ASSIGN.has(after.text) || after.text === '++' || after.text === '--');
  const prefixed = isPunct(before, '++') || isPunct(before, '--') || (before?.kind === 'word' && before.text === 'delete');
  return !member || written || prefixed;
}

/** The first token of `tokens[from..to)`, groups and template substitutions included, that misuses `name`. */
function firstMisuse(tokens, from, to, name) {
  for (let k = from; k < to; k += 1) {
    if (misuses(tokens, k, name)) return tokens[k];
    for (const inner of tokens[k].kind === 'group' ? [tokens[k].tokens] : tokens[k].substs ?? []) {
      const hit = firstMisuse(inner, 0, inner.length, name);
      if (hit) return hit;
    }
  }
  return null;
}

/** What could change or shadow `name` between its declaration `decl` and the read at the end of `path`:
 * the first misuse in the code between them (an earlier substitution of a template the read is in
 * included), or a function declaration of the name in a level the read sits in, hoisted over it. */
function changedBetween(path, decl, name) {
  let hit = firstMisuse(path[decl.frame].tokens, decl.at + 1, path[decl.frame].index, name);
  for (let frame = decl.frame + 1; frame < path.length; frame += 1) {
    const holder = path[frame - 1].tokens[path[frame - 1].index], level = path[frame].tokens;
    for (const prior of holder.kind === 'tpl' ? holder.substs.slice(0, holder.substs.indexOf(level)) : []) {
      hit ||= firstMisuse(prior, 0, prior.length, name);
    }
    hit ||= firstMisuse(level, 0, path[frame].index, name) ||
      level.find((token, k) => token.kind === 'word' && token.text === name && level[k - 1]?.text === 'function');
  }
  return hit;
}

/** The problem with a recorded template whose expression reads names bound as `bound` lists, if any.
 * Each name must be the nearest enclosing `const` before the read (for a later name, before the previous
 * name's declaration), initialised as listed, and neither changed nor shadowed up to the read. */
function boundProblems(site, bound) {
  const path = [...site.path, ...pathTo(site.level, site.token)];
  let from = path;
  for (const {name, init, is} of bound) {
    const decl = constBefore(from, name), read = `${site.where}: \`${site.template}\` reads ${name}`;
    if (!decl) return [`${read}, which no \`const ${name} = ...\` before it in an enclosing block declares, so its values are unknown`];
    if (!init.test(render(decl.init))) return [`${read} = \`${render(decl.init)}\`, not ${is}, so its values are unknown`];
    const changed = changedBetween(path, decl, name);
    if (changed) return [`${read}, which line ${lineOf(site.text, changed)} uses other than as a member read, so it may not hold ${is} there`];
    from = [...path.slice(0, decl.frame), {tokens: path[decl.frame].tokens, index: decl.at}];
  }
  return [];
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
 * is declared here with `values`, a reader of its value domain: the list the code draws that expression's
 * value from (null when it is not in source); `declared` holds values labelled ahead of the code. A
 * recorded template expands to both, so a value added only in the code still needs a label. A recorded
 * template whose prefix or expression is not declared here, or whose list is not found in source, fails
 * the guard. An expression's text alone does not say where its value comes from, so `bound` lists the
 * `const` declarations each recording of it must read (see boundProblems). */
const TEMPLATE_STAGES = {
  // background.js: `status` is the repair record of the bridge's reply to a repair request, and its
  // status is a RepairStatus.
  repair_: {declared: [], expressions: {'status.status': {values: () => unionMembers('src/lib/json-repair-types.ts', 'RepairStatus'),
    bound: [{name: 'status', init: /^response\.repair$/, is: 'response.repair'},
      {name: 'response', init: /^await api\("\/api\/bridge",(\{\.\.\.)?repairBody\(/, is: 'the bridge\'s reply to a repairBody() request'}]}}},
  // Tab release (#82): finishTabCleanup sets state.preserveCause to one of preserveCauses(), then records
  // preserve_${state.preserveCause}. Every write of .preserveCause must store one of them (writeProblems).
  preserve_: {expressions: {'state.preserveCause': {values: files => returnedList(files, 'preserveCauses'),
    written: {property: 'preserveCause', list: 'preserveCauses'}}},
    declared: ['navigated', 'user_turn', 'edited', 'draft', 'ownership_unknown', 'unreachable', 'other_binding', 'undelivered', 'unknown',
      // Tab Lease (Phase 1+): the takeover and restart causes of a preserved tab.
      'user_input', 'user_moved', 'browser_restart']},
  // Tab Lease (Phase 1+): a lease that runs out records lease_expired_<phase>. Nothing lists the phases in
  // code yet: when the extension records this template, its expression goes here with a reader of its phases.
  lease_expired_: {expressions: {}, declared: ['creating', 'opening', 'sending', 'generating', 'answered', 'releasing']},
};

const isLiteral = token => token?.kind === 'str' || (token?.kind === 'tpl' && !token.substs.length);

/** Why storing `init` (an initialiser's tokens) can put a value outside `values` into a property, or
 * null: it must be a string `list()` lists, or clamp a variable into them exactly as
 * `list().includes(x) ? x : "<listed>"` (x one name, read twice to the same value). */
function unclamped(init, list, values) {
  if (init.length === 1 && isLiteral(init[0])) return values.includes(init[0].value) ? null : `stores "${init[0].value}", which ${list}() does not list`;
  const clamp = new RegExp(`^${list}\\(\\)\\.includes\\(([\\w$]+)\\)\\?\\1:"([^"\\\\]*)"$`).exec(render(init));
  if (!clamp) return `stores \`${render(init)}\`, which is neither a string ${list}() lists nor \`${list}().includes(x) ? x : "<listed>"\``;
  return values.includes(clamp[2]) ? null : `falls back to "${clamp[2]}", which ${list}() does not list`;
}

/** The tokens of `level` from `from` up to the first punct in `stops`. */
function until(level, from, stops) {
  let end = from;
  while (end < level.length && !(level[end].kind === 'punct' && stops.includes(level[end].text))) end += 1;
  return level.slice(from, end);
}

/** Why `level[k]` writes `property` with a value that may be outside `values`, or null. A member write
 * (`x.property` or `x["property"]`) with =, ||=, ??= or &&= stores its right side; an object key
 * `property: v` stores v; each must pass unclamped(). Any other write is a problem: another compound
 * assignment, ++, --, delete, a shorthand `{property}`, or a method or accessor of that name. A
 * destructuring pattern (`{...}` followed by `=`) reads the property instead. */
function unlistedWrite(level, k, container, pattern, {property, list}, values) {
  const token = level[k], before = level[k - 1], after = level[k + 1];
  // An array literal ["p"] is never assigned, updated or deleted, so it passes the member checks below.
  const computed = token.open === '[' && token.tokens[0]?.value === property;
  if (computed || (token.kind === 'word' && token.text === property && (isPunct(before, '.') || isPunct(before, '?.')))) {
    if (after?.kind === 'punct' && ['=', '||=', '??=', '&&='].includes(after.text)) return unclamped(until(level, k + 2, [';', ',']), list, values);
    if (after?.kind === 'punct' && (ASSIGN.has(after.text) || after.text === '++' || after.text === '--')) return `is updated with ${after.text}`;
    let j = k - 1; // back over the member chain it ends, to what is applied to it
    for (; j >= 0 && (level[j].kind === 'word' || level[j].kind === 'group' || isPunct(level[j], '.') || isPunct(level[j], '?.')); j -= 1) {
      if (level[j].kind === 'word' && level[j].text === 'delete') return 'is deleted';
    }
    return isPunct(level[j], '++') || isPunct(level[j], '--') ? `is updated with ${level[j].text}` : null;
  }
  if ((token.kind === 'word' ? token.text : token.value) !== property || container?.open !== '{' || pattern) return null;
  if (after?.open === '(' && (k === 0 || isPunct(before, ',') || ['get', 'set', 'async'].includes(before?.text))) return 'is a method or accessor';
  if (k > 0 && !isPunct(before, ',')) return null;
  if (isPunct(after, ':')) return unclamped(until(level, k + 2, [',']), list, values);
  return !after || isPunct(after, ',') ? 'is written from a variable of the same name' : null;
}

/** The writes of `written.property` in `files` that can store a value outside `values`, as problems of
 * the recorded `template` that reads it. */
function writeProblems(files, written, values, template) {
  const problems = [];
  for (const [file, text] of Object.entries(files)) {
    let tokens;
    try { ({tokens} = tokenize(text, 0)); } catch { continue; } // recordedStages reports the file
    walkTokens(tokens, (token, level, k, container, path) => {
      const holder = path.at(-1), pattern = holder && isPunct(holder.tokens[holder.index + 1], '=');
      const why = unlistedWrite(level, k, container, pattern, written, values);
      if (why) problems.push(`${file}:${lineOf(text, token)} .${written.property} ${why}, so \`${template}\` may record a stage without a label`);
    });
  }
  return problems;
}

/** The declared prefix, labelled-ahead values and expression entry of a recorded template stage. */
function templateSpec(template) {
  const prefix = template.slice(0, template.indexOf('${'));
  assert.ok(Object.hasOwn(TEMPLATE_STAGES, prefix), `template stage \`${template}\` has no declared expansion in TEMPLATE_STAGES`);
  assert.match(template, /^[a-z_]+\$\{[^}]+\}$/, `template stage \`${template}\` is exactly <prefix>\${value}`);
  const {declared, expressions} = TEMPLATE_STAGES[prefix];
  const expression = template.slice(prefix.length + 2, -1).trim();
  assert.ok(Object.hasOwn(expressions, expression),
    `template stage \`${template}\`: \`${expression}\` is not a declared ${prefix} expression, so the values it can take are unknown`);
  return {prefix, declared, spec: expressions[expression]};
}

/** Every stage a recorded template can produce, given the extension's scripts. */
function expandTemplate(template, files) {
  const {prefix, declared, spec} = templateSpec(template);
  const values = spec.values(files);
  assert.ok(values, `template stage \`${template}\` is recorded, but the list of its values was not found in source`);
  return [...new Set([...declared, ...values])].map(value => prefix + value);
}

/** The stages labelled ahead of the code for a template prefix. */
const declaredStages = prefix => TEMPLATE_STAGES[prefix].declared.map(value => prefix + value);

/** Every stage `files` can record, and the stage arguments the guard could not read. */
function guardedStages(files) {
  const {literals, templates, sites, problems} = extensionStages(files);
  const stages = [...literals, ...[...templates].flatMap(template => expandTemplate(template, files))];
  for (const site of sites) problems.push(...boundProblems(site, templateSpec(site.template).spec.bound ?? []));
  for (const template of templates) {
    const {spec} = templateSpec(template);
    if (spec.written) problems.push(...writeProblems(files, spec.written, spec.values(files), template));
  }
  return {literals, templates, problems, stages};
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

/** background.js's repair reply: the bindings repair_${status.status} reads. */
const REPAIR_REPLY = 'const response = await api("/api/bridge", repairBody(job, provider, "repair-status", attempt), job.origin);\n' +
  'const status = response.repair;\n';

test('preserve_${state.preserveCause} records a listed cause only while every write of .preserveCause stores one', () => {
  const causes = 'function preserveCauses() {\n  return ["navigated", "draft", "unknown"];\n}\n';
  const record = 'workerStep(job, provider, `preserve_${state.preserveCause}`);';
  const problems = code => guardedStages({'background.js': `${causes}function finish(job, provider, state, cause, row) {\n  ${code}\n  ${record}\n}\n`}).problems;
  // #82's finishTabCleanup clamps the page's cause; a listed literal, a default of one and reads are fine.
  for (const code of [
    'state.preserveCause = preserveCauses().includes(cause) ? cause : "unknown";',
    'state.preserveCause = "draft";',
    'state.preserveCause = `draft`; row.list[0] = cause; row.list[""] = cause;',
    'state.preserveCause ||= "unknown";',
    'job.states[provider] = {...state, preserveCause: "draft", note: row.note};',
    'if (state.preserveCause === "draft") note({cause: state.preserveCause});',
    // A variable of that name is not the property.
    'note([preserveCause, cause]); note({cause: preserveCause}); if (ok) { preserveCause = cause; log(row); preserveCause(row); }',
    'job.states[provider] = {...state, "note": row.cause};',
    'const {preserveCause = "unknown"} = row;',
    // A destructuring pattern reads the property.
    'const {preserveCause} = state; const {preserveCause: kept, note} = row; ({preserveCause: row.cause} = state);',
  ]) assert.deepEqual(problems(code), [], code);
  const neither = init => `stores \`${init}\`, which is neither a string preserveCauses() lists nor \`preserveCauses().includes(x) ? x : "<listed>"\``;
  for (const [code, why] of [
    // An unclamped value, from the page or anywhere else, or a literal the list does not hold.
    ['state.preserveCause = cause || "unknown";', neither('cause||"unknown"')],
    ['state.preserveCause = cause;', neither('cause')],
    ['state.preserveCause = `${cause}`;', neither('`${cause}`')],
    ['state.preserveCause ??= row.cause;', neither('row.cause')],
    ['state["preserveCause"] = cause;', neither('cause')],
    ['state.preserveCause = "staged";', 'stores "staged", which preserveCauses() does not list'],
    ['job.states[provider] = {...state, preserveCause: cause};', neither('cause')],
    ['job.states[provider] = {...state, "preserveCause": row.cause};', neither('row.cause')],
    // A clamp is exactly preserveCauses().includes(x) ? x : "<listed>".
    ['state.preserveCause = preserveCauses().includes(cause) ? cause : "staged";', 'falls back to "staged", which preserveCauses() does not list'],
    ['state.preserveCause = otherCauses().includes(cause) ? cause : "unknown";', neither('otherCauses().includes(cause)?cause:"unknown"')],
    ['state.preserveCause = preserveCauses().includes(cause) ? row.cause : "unknown";', neither('preserveCauses().includes(cause)?row.cause:"unknown"')],
    ['state.preserveCause = preserveCauses().includes(next()) ? next() : "unknown";', neither('preserveCauses().includes(next())?next():"unknown"')],
    ['state.preserveCause = preserveCauses().includes(cause) ? cause : "unknown" + late;', neither('preserveCauses().includes(cause)?cause:"unknown"+late')],
    ['state.preserveCause = preserveCauses() + includes(cause) ? cause : "unknown";', neither('preserveCauses()+includes(cause)?cause:"unknown"')],
    ['state.preserveCause = preserveCauses().includes(cause || row.cause) ? cause : "unknown";', neither('preserveCauses().includes(cause||row.cause)?cause:"unknown"')],
    ['state.preserveCause = preserveCauses().includes((next())) ? (next()) : "unknown";', neither('preserveCauses().includes((next()))?(next()):"unknown"')],
    ['state.preserveCause = preserveCauses(row).includes(cause) ? cause : "unknown";', neither('preserveCauses(row).includes(cause)?cause:"unknown"')],
    // Any other write.
    ['state.preserveCause += "_late";', 'is updated with +='],
    ['state.preserveCause++;', 'is updated with ++'],
    ['state.preserveCause--;', 'is updated with --'],
    ['++job.states[provider].preserveCause;', 'is updated with ++'],
    ['--state.preserveCause;', 'is updated with --'],
    ['delete state.preserveCause;', 'is deleted'],
    ['delete job.states[provider].preserveCause;', 'is deleted'],
    ['delete state?.preserveCause;', 'is deleted'],
    ['delete state?.["preserveCause"];', 'is deleted'],
    ['job.states[provider] = {preserveCause, ...state};', 'is written from a variable of the same name'],
    ['job.states[provider] = {...state, preserveCause};', 'is written from a variable of the same name'],
    ['job.states[provider] = {preserveCause() { return cause; }};', 'is a method or accessor'],
    ['job.states[provider] = {...state, preserveCause() { return cause; }};', 'is a method or accessor'],
    ['job.states[provider] = {...state, get preserveCause() { return cause; }};', 'is a method or accessor'],
    ['job.states[provider] = {...state, set preserveCause(value) {}};', 'is a method or accessor'],
    ['job.states[provider] = {...state, async preserveCause() {}};', 'is a method or accessor'],
  ]) {
    assert.deepEqual(problems(code), [`background.js:5 .preserveCause ${why}, so \`preserve_\${state.preserveCause}\` may record a stage without a label`], code);
  }
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
  const {stages, problems} = guardedStages({'background.js': `${REPAIR_REPLY}workerStep(job, provider, \`repair_\${status.status}\`);`});
  assert.deepEqual(problems, []);
  assert.deepEqual(stages.sort(), unionMembers('src/lib/json-repair-types.ts', 'RepairStatus').map(value => `repair_${value}`).sort());
});

test('repair_${status.status} takes the RepairStatus values only where status is the bridge\'s repair reply', () => {
  const record = 'workerStep(job, provider, `repair_${status.status}`)';
  const problems = body => guardedStages({'background.js': `async function poll(job, provider, attempt) {\n${body}\n}`}).problems;
  // background.js's two shapes: the reply read in the same block, and read in an if block below it.
  assert.deepEqual(problems(`${REPAIR_REPLY}if (status?.id !== attempt.id) return;\nattempt.status = status.status;\n${record};`), []);
  // Member reads, other names' properties and an unrelated function in the block are not changes.
  assert.deepEqual(problems(`${REPAIR_REPLY}if (typeof status.id !== "string" || row?.status) return;\nif (ok) {\n  ${record};\n  function helper() {}\n}`), []);
  assert.deepEqual(problems('const response = await api("/api/bridge", {...repairBody(job, provider, "repair", attempt), source}, job.origin);\n' +
    `const status = response.repair;\nif (status?.id && status.runId === attempt.runId) {\n  attempt.id = status.id;\n  ${record};\n}`), []);
  const reply = REPAIR_REPLY;
  for (const [body, problem] of [
    // Another binding named status, or none.
    [`const status = {status: "stalled"};\n${record};`, 'reads status = `{status:"stalled"}`, not response.repair'],
    [`${record};`, 'reads status, which no `const status = ...` before it in an enclosing block declares'],
    [`${reply.replace('const status', 'let status')}${record};`, 'reads status, which no `const status = ...`'],
    // The initialiser runs to its `;`: a second declarator, or none and a line break, is another expression.
    [`${reply.replace('response.repair;', 'response.repair, late = true;')}${record};`, 'reads status = `response.repair,late=true`'],
    [`${reply.replace('response.repair;', 'response.repair')}${record}`, 'reads status = `response.repair workerStep(job,provider,'],
    [`${reply.replace('const status = response.repair;', '')}if (ok) { const status = response.repair; }\n${record};`, 'reads status, which no `const status = ...`'],
    [`${reply}if (ok) {\n  const status = {status: "stalled"};\n  ${record};\n}`, 'reads status = `{status:"stalled"}`'],
    // A response that is not the bridge's repair reply.
    [`const response = {repair: {status: "stalled"}};\nconst status = response.repair;\n${record};`,
      'reads response = `{repair:{status:"stalled"}}`, not the bridge\'s reply to a repairBody() request'],
    [`const response = await api("/api/bridge", {action: "status"}, job.origin);\nconst status = response.repair;\n${record};`,
      'reads response = `await api("/api/bridge",{action:"status"},job.origin)`, not the bridge\'s reply'],
    // Between the declaration and the read: a write, an alias, a shadow or a hoisted function.
    [`${reply}status.status = "stalled";\n${record};`, 'reads status, which line 4 uses other than as a member read'],
    [`${reply}status.status += "_late";\n${record};`, 'line 4 uses'],
    [`${reply}status.status++;\n${record};`, 'line 4 uses'],
    [`${reply}++status.status;\n${record};`, 'line 4 uses'],
    [`${reply}status.status--;\n${record};`, 'line 4 uses'],
    [`${reply}--status.status;\n${record};`, 'line 4 uses'],
    [`${reply}status?.(patch);\n${record};`, 'line 4 uses'],
    [`${reply}delete status.status;\n${record};`, 'line 4 uses'],
    [`${reply}normalize(status);\n${record};`, 'line 4 uses'],
    [`${reply}const copy = status;\n${record};`, 'line 4 uses'],
    [`${reply}status[key] = "stalled";\n${record};`, 'line 4 uses'],
    [`${reply}tweak(response);\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}rows.forEach(status => ${record});`, 'line 4 uses'],
    [`${reply}if (ok) {\n  ${record};\n  function status() {}\n}`, 'line 6 uses'],
    [`${reply}with (row) ${record};`, 'line 4 uses'],
    [`${reply}eval(patch);\n${record};`, 'line 4 uses'],
    [`${reply}log(\`\${status.status = "stalled"} \${${record}}\`);`, 'line 4 uses'],
  ]) {
    const found = problems(body);
    assert.equal(found.length, 1, `${body}\n: ${found.join('\n')}`);
    assert.match(found[0], /^background\.js:\d+ workerStep\(\): `repair_\$\{status\.status\}` reads /, body);
    assert.ok(found[0].includes(problem), `${body}\n: ${found[0]}`);
  }
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
