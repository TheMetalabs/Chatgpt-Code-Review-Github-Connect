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

const SINGLE_ESCAPES = {b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v'};

/** A string literal's value from its source between the quotes: `"workerSt\x65p"` is "workerStep". */
function stringValue(raw) {
  return raw.replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/gi,
    (_, braced, four, two, octal, other) => (braced ?? four ?? two) ? String.fromCodePoint(parseInt(braced ?? four ?? two, 16))
      : octal ? String.fromCharCode(parseInt(octal, 8)) : /^[\r\n\u2028\u2029]/.test(other) ? '' : SINGLE_ESCAPES[other] ?? other);
}

/** The value of a string literal or a template literal without substitutions, else undefined. */
const literalValue = token => token?.kind === 'str' || (token?.kind === 'tpl' && !token.substs.length) ? stringValue(token.value) : undefined;

/** Names whose value is the global object. A recorder declared at the top of a script is a property of it. */
const GLOBAL_NAMES = new Set(['globalThis', 'self', 'window', 'frames', 'top', 'parent', 'this']);

/** Whether the `[` group at `level[k]` is a computed member (`x[k]`, `f()[k]`, `x?.[k]`) rather than an
 * array literal: it follows `?.` or the end of an operand. */
function computedMember(level, k) {
  const token = level[k], before = level[k - 1];
  if (token?.open !== '[' || !before) return false;
  if (before.kind === 'punct') return before.text === '?.';
  if (before.kind === 'word') return !REGEX_AFTER.has(before.text) && !['const', 'let', 'var'].includes(before.text);
  if (before.kind === 'group') return before.open === '[' || (before.open === '(' && !HEADED.has(level[k - 2]?.text));
  return true; // after a string, a template or a regex
}

/** The key of a computed member's `[...]` when the guard can read it: a string, a template without
 * substitutions, or a number (never a recorder's name). Otherwise undefined. */
function memberKey(group) {
  const [only, ...rest] = group.tokens;
  if (rest.length) return undefined;
  return only?.kind === 'word' && /^\d/.test(only.text) ? only.text : literalValue(only);
}

/** The property name `level[k]` spells, or undefined: a word after `.` or `?.`, a computed member's
 * readable key (`x["defaultView"]`), or an object key or pattern key (`{defaultView}`, `{"defaultView": v}`,
 * `{["defaultView"]: v}`, a method's name). */
function propertyName(level, k, container) {
  const token = level[k], before = level[k - 1], after = level[k + 1];
  if (computedMember(level, k)) return memberKey(token);
  if (isPunct(before, '.') || isPunct(before, '?.')) return token.kind === 'word' ? token.text : undefined;
  if (container?.open !== '{' || (k > 0 && !isPunct(before, ','))) return undefined;
  if (token.kind === 'word') return !after || isPunct(after, ':') || isPunct(after, ',') || isPunct(after, '=') || after.open === '(' ? token.text : undefined;
  const keyed = isPunct(after, ':') || after?.open === '(';
  return !keyed ? undefined : token.open === '[' ? memberKey(token) : literalValue(token);
}

/** The names a binding target binds: a name, or each name in a destructuring pattern or a parameter
 * list (`a, {b, c: [d]}, e = 1, ...f`): an element up to its default value, the value after a key's `:`,
 * a rest element. */
function bindingNames(target) {
  if (target?.kind === 'word') return [target.text];
  if (!['{', '[', '('].includes(target?.open)) return [];
  return argumentsOf(target.tokens).flatMap(element => {
    let part = isPunct(element[0], '...') ? element.slice(1) : element;
    const colon = part.findIndex(token => isPunct(token, ':')), eq = part.findIndex(token => isPunct(token, '='));
    if (colon >= 0 && (eq < 0 || colon < eq)) part = part.slice(colon + 1);
    return bindingNames(part[0]);
  });
}

/** The names `tokens` declares at its own level: each const, let or var declarator's name or pattern,
 * and a function or class declaration's name (an expression's name binds only inside it). */
function declaredNames(tokens) {
  return tokens.flatMap((token, k) => {
    const before = tokens[k - 1];
    if (token.kind !== 'word' || isPunct(before, '.') || isPunct(before, '?.')) return [];
    if (['const', 'let', 'var'].includes(token.text)) return argumentsOf(until(tokens, k + 1, [';'])).flatMap(([target]) => bindingNames(target));
    if (token.text !== 'function' && token.text !== 'class') return [];
    const lead = isWord(before, 'async') ? tokens[k - 2] : before, name = tokens[k + (isPunct(tokens[k + 1], '*') ? 2 : 1)];
    const declaration = !lead || isPunct(lead, ';') || lead.kind === 'group' || isWord(lead, 'export') || isWord(lead, 'default');
    return declaration && name?.kind === 'word' && name.text !== 'extends' ? [name.text] : [];
  });
}

/** Where the statement at `tokens[from]` ends: after its block when it is one, else after its `;` (an
 * if's else arm included), else at the end of the level. */
function statementEnd(tokens, from) {
  if (tokens[from]?.open === '{') return from + 1;
  for (let j = from; j < tokens.length; j += 1) if (isPunct(tokens[j], ';') && !isWord(tokens[j + 1], 'else')) return j + 1;
  return tokens.length;
}

/** The names bound inside the group at `tokens[index]` by the head in front of it: a function's,
 * method's or catch's parameters (and a function expression's own name) for its body, and for the
 * parameter list itself. The head of an if, while, with, switch or for binds none there. */
function headNames(tokens, index) {
  const group = tokens[index];
  const head = group.open === '{' && tokens[index - 1]?.open === '(' ? index - 1 : group.open === '(' && tokens[index + 1]?.open === '{' ? index : -1;
  if (head < 0 || ['if', 'while', 'with', 'switch', 'for', 'await'].includes(tokens[head - 1]?.text)) return [];
  return [...(isWord(tokens[head - 2], 'function') ? bindingNames(tokens[head - 1]) : []), ...bindingNames(tokens[head])];
}

/** The parameters of the arrows in `tokens` that `tokens[index]` is a parameter of or in the body of: an
 * arrow before it whose body runs to it without a `,` or `;` between. */
function arrowNames(tokens, index) {
  const names = [];
  for (let a = isPunct(tokens[index + 1], '=>') ? index + 1 : index - 1; a > 0 && !isPunct(tokens[a], ',') && !isPunct(tokens[a], ';'); a -= 1) {
    if (isPunct(tokens[a], '=>')) names.push(...bindingNames(tokens[a - 1]));
  }
  return names;
}

/** The names the for heads in `tokens` declare for the loop statements that hold `tokens[index]`. */
function forNames(tokens, index) {
  return tokens.slice(0, index).flatMap((token, j) => {
    const head = isWord(tokens[j + 1], 'await') ? j + 2 : j + 1;
    return isWord(token, 'for') && tokens[head]?.open === '(' && index < statementEnd(tokens, head + 1) ? declaredNames(tokens[head].tokens) : [];
  });
}

/** Whether the word `name` at `level[k]`, inside the levels `path`, is bound by the code rather than
 * being the global object's: declared in a level that holds it, a parameter of a function, method, arrow
 * or catch whose head or body holds it, or declared by a for head over it. A binding site binds itself. */
function boundLocally(path, level, k, name) {
  const frames = [...path, {tokens: level, index: k}];
  return frames.some(({tokens, index}, f) => [...declaredNames(tokens), ...arrowNames(tokens, index), ...forNames(tokens, index),
    ...(f < frames.length - 1 ? headNames(tokens, index) : [])].includes(name));
}

/** Whether the `{` group at `tokens[index]` is a class body: `class`, a name and an extends clause before it. */
function classBody(tokens, index) {
  let j = index - 1;
  while (j >= 0 && !isWord(tokens[j], 'class') && (tokens[j].kind === 'word' || isPunct(tokens[j], '.') || tokens[j].open === '(' || tokens[j].open === '[')) j -= 1;
  return tokens[index]?.open === '{' && isWord(tokens[j], 'class');
}

/** Whether `level[k]` (inside the levels `path`) refers to the global object: one of GLOBAL_NAMES that is
 * not a property name, an object key or a method's name, nor bound by the code where it stands (a
 * declaration, a parameter or a catch binding of that name makes it a local), with `this` anywhere but in
 * a class body (strict code, whose `this` is never the global object); or a `defaultView` property (a
 * document's window) however its name is spelled. */
function globalReference(level, k, container, path) {
  const token = level[k], before = level[k - 1];
  if (propertyName(level, k, container) === 'defaultView') return true;
  if (token.kind !== 'word' || !GLOBAL_NAMES.has(token.text) || isPunct(before, '.') || isPunct(before, '?.')) return false;
  const key = container?.open === '{' && (k === 0 || isPunct(before, ',')) && isPunct(level[k + 1], ':');
  if (key || (level[k + 1]?.open === '(' && level[k + 2]?.open === '{')) return false;
  if (token.text === 'this') return !path.some(({tokens, index}) => classBody(tokens, index));
  return !boundLocally(path, level, k, token.text);
}

/** Whether the global object at `level[k]` is read only by a static member name (`globalThis.x`,
 * `window?.["x"]`, on through `.window`, `.self` and the like) or by typeof. A computed name can be any
 * recorder's, and the object as a value (an alias, an argument, a destructuring source) can be searched
 * for one. */
function staticGlobalRead(level, k) {
  for (let j = k + 1; ; ) {
    const dot = isPunct(level[j], '.') || isPunct(level[j], '?.'), member = dot ? level[j + 1] : level[j];
    const computed = member?.open === '[';
    const name = computed ? memberKey(member) : dot && member?.kind === 'word' ? member.text : undefined;
    if (name === undefined) return !computed && level[k - 1]?.text === 'typeof';
    if (!GLOBAL_NAMES.has(name) || name === 'this') return true;
    j += dot ? 2 : 1;
  }
}

/** Names of the calls that call the function they are handed first (`Reflect.apply(f, ...)`,
 * `Function.prototype.call.call(f, ...)`), and of the methods that call or bind the function they are on. */
const APPLIERS = new Set(['apply', 'call', 'bind', 'construct']);

/** Whether `new` applies to the member chain that ends at `level[k]` (`new x.y[k]`, not `new f()[k]`). */
function constructed(level, k) {
  let j = k;
  for (;;) {
    if (computedMember(level, j)) j -= isPunct(level[j - 1], '?.') ? 2 : 1;
    else if (level[j]?.kind === 'word' && (isPunct(level[j - 1], '.') || isPunct(level[j - 1], '?.'))) j -= 2;
    else return isWord(level[j - 1], 'new');
  }
}

/** Whether the `(` group at `tokens[i]` is a parenthesised expression, whose value is one of its operands:
 * not a call's arguments, a function's or an arrow's parameters, or the head of a statement. */
function parenthesised(tokens, i) {
  const before = tokens[i - 1];
  if (isPunct(tokens[i + 1], '=>')) return false;
  if (!before || before.kind === 'punct') return true;
  if (before.kind === 'word') return REGEX_AFTER.has(before.text);
  return before.open === '{';
}

/** Whether the value that ends at `level[k]` is called: `(...)`, `?.(...)` or a template after it, `new`
 * on its chain, a .call, .apply or .bind on it, or handed first to a call of an APPLIERS name; the same
 * for a parenthesised expression it ends an operand of (`(x[k])()`, `(0, x[k])()`), whose value it can be.
 * `path` holds `level`. */
function calledAt(level, k, path) {
  const next = isPunct(level[k + 1], '?.') ? level[k + 2] : level[k + 1];
  if (next?.open === '(' || level[k + 1]?.kind === 'tpl' || constructed(level, k)) return true;
  if ((isPunct(level[k + 1], '.') || isPunct(level[k + 1], '?.')) && APPLIERS.has(level[k + 2]?.text)) return true;
  const holder = path.at(-1), group = holder?.tokens[holder.index], callee = holder?.tokens[holder.index - 1];
  if (group?.open !== '(') return false;
  if (parenthesised(holder.tokens, holder.index)) {
    const ends = !level[k + 1] || (level[k + 1].kind === 'punct' && !isPunct(level[k + 1], '.') && !isPunct(level[k + 1], '?.'));
    return ends && calledAt(holder.tokens, holder.index, path.slice(0, -1));
  }
  const first = level.findIndex(token => isPunct(token, ','));
  return callee?.kind === 'word' && APPLIERS.has(callee.text) && (first < 0 ? level.length : first) === k + 1;
}

/** The equality operators: a string compared by one (`kind === "step"`) yields a boolean, not a key. */
const EQUALITY = new Set(['===', '!==', '==', '!=']);

/** Whether the string at `level[k]` is only compared: an operand of an equality or a `case` label. */
const compared = (level, k) => isWord(level[k - 1], 'case') ||
  [level[k - 1], level[k + 1]].some(token => token?.kind === 'punct' && EQUALITY.has(token.text));

/** Why `level[k]` reaches a recorder by a name the tokens never spell as one, or null: a string whose
 * value is a recorder's name and that is not only compared (`globalThis["workerStep"]`,
 * `Reflect.get(self, "step")`, an argument or a stored value that may reach such a lookup), a call through a
 * computed member whose name the guard cannot read, on any object (`e.currentTarget[name](...)`: the
 * global object can arrive as any value), or the global object read other than by a static member name
 * (`globalThis[name]`). */
function reachedByName(level, k, container, path) {
  const token = level[k], value = literalValue(token);
  if (value !== undefined && Object.hasOwn(RECORDERS, value) && !compared(level, k)) {
    return 'a string naming a recorder can reach it through a computed member or a lookup, so the stages it records there cannot be checked';
  }
  if (computedMember(level, k) && memberKey(token) === undefined && calledAt(level, k, path)) {
    return 'a call through a computed member whose name the guard cannot read can call a recorder on any object that holds one (the global object holds them all), so the stage it records cannot be checked';
  }
  if (staticGlobalRead(level, k) || !globalReference(level, k, container, path)) return null;
  return 'the global object, which holds every recorder declared at the top of a script, is read other than by a static member name, so a recorder reached there records stages that cannot be checked';
}

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
 * a value, aliased, or called through .call or .apply records a stage no call here shows. So is a way to
 * reach a recorder without its name as a word (reachedByName): a string that names it, a call through
 * a computed member the guard cannot read, or a computed read of the global object. */
function recordedStages(text, file = 'source') {
  const found = {literals: new Set(), templates: new Set(), sites: [], problems: []};
  let tokens;
  try { ({tokens} = tokenize(text, 0)); } catch (error) {
    found.problems.push(`${file}: could not be tokenized (${error.message}), so its recorder calls cannot be read`);
    return found;
  }
  const bodies = recorderBodies(tokens);
  walkTokens(tokens, (token, level, k, container, path) => {
    const reached = reachedByName(level, k, container, path);
    if (reached) return found.problems.push(`${file}:${lineOf(text, token)} ${token.text}: ${reached}`);
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

const MISUSE = 'uses other than as a member read';

const isWord = (token, text) => token?.kind === 'word' && token.text === text;

/** Whether an expression followed by `after` is a target: of an assignment, of a for-of head, or of a
 * for-in head when it starts one (`head`; elsewhere `in` is an operator). */
const assignedBy = (after, head) => (after?.kind === 'punct' && ASSIGN.has(after.text)) || isWord(after, 'of') || (head && isWord(after, 'in'));

/** Whether an expression between `before` and `after` is written: a target, updated or deleted. */
const written = (before, after, head) => assignedBy(after, head) || isPunct(after, '++') || isPunct(after, '--') ||
  isPunct(before, '++') || isPunct(before, '--') || isWord(before, 'delete');

/** What surrounds the tokens inside the group `tokens[k]`, given `ctx` around `tokens`: whether they are
 * a for head; through parentheses, the tokens around the whole parenthesised run (`(a.b) = x` assigns
 * a.b); and whether they are in an assignment pattern (`[a.b] = x`, `for ({v: a.b} of rows)`), where any
 * member chain can be a target. */
function innerContext(tokens, k, ctx) {
  const group = tokens[k], head = ctx.forHead && k === 0;
  if (group.open !== '(') return {pattern: ctx.pattern || assignedBy(tokens[k + 1], head)};
  const forHead = isWord(tokens[k - 1], 'for') || (isWord(tokens[k - 1], 'await') && isWord(tokens[k - 2], 'for'));
  return {forHead, pattern: ctx.pattern, around: tokens.length === 1 && ctx.around ? ctx.around : {before: tokens[k - 1], after: tokens[k + 1], head}};
}

/** The member chain after the name at `tokens[k]` (`.a`, `?.a`, `[k]`, calls and tags) up to `end`, and
 * `handed`: the static member names up to the object that `holds` says still holds what the binding does
 * ([] for the name itself) when that object is handed on — as the chain's value, or to a call, a tag or
 * a computed member applied to it — else null. A call or a tag receives the object its function is read from. */
function memberChain(tokens, k, holds) {
  const names = [];
  let j = k + 1, handed = null, broken = false;
  for (;;) {
    const dot = isPunct(tokens[j], '.') || isPunct(tokens[j], '?.'), next = dot ? tokens[j + 1] : tokens[j];
    if (dot && next?.kind === 'word') {
      if (!broken) names.push(next.text);
    } else if (next?.open === '(' || next?.open === '[' || (next?.kind === 'tpl' && !dot)) {
      const object = next.open === '[' ? names : names.slice(0, -1);
      if (!broken && holds(object)) handed ??= object;
      broken = true;
    } else return {end: j, handed: handed ?? (!broken && holds(names) ? names : null)};
    j += dot ? 2 : 1;
  }
}

/** Why `tokens[k]` may change what `name.x` holds from then on, or null. `name` may appear only as the
 * object of a member chain that is read, not written: a write anywhere along it (assigned, updated,
 * deleted, a pattern or for-in/of target, through parentheses) changes what it reaches. Nor may what the
 * binding holds be handed on: the name itself as a value, or a call, a tag or a computed member on it. For
 * `aliases` of `name` (`const status = response.repair`: the object at `response.repair` is status's), the
 * members down to the aliased object are the binding's too, save in the alias's own initialiser (`skip`).
 * with, eval and arguments reach a binding without naming it. */
function misuses(tokens, k, name, aliases, ctx) {
  const token = tokens[k];
  if (token.kind !== 'word' || isPunct(tokens[k - 1], '.') || isPunct(tokens[k - 1], '?.')) return null;
  if (INDIRECT.has(token.text)) return MISUSE;
  if (token.text !== name) return null;
  const below = names => aliases.find(({path}) => names.length <= path.length && names.every((part, i) => part === path[i]));
  const {end, handed} = memberChain(tokens, k, names => !names.length || Boolean(below(names)));
  const {before, after, head} = k === 0 && end === tokens.length && ctx.around ? ctx.around : {before: tokens[k - 1], after: tokens[end], head: ctx.forHead && k === 0};
  if (ctx.pattern || written(before, after, head)) return MISUSE;
  if (!handed || aliases.some(alias => alias.skip === token)) return null;
  return handed.length ? `${MISUSE} (${[name, ...handed].join('.')} holds what ${below(handed).by} aliases)` : MISUSE;
}

/** The first token of `tokens[from..to)`, groups and template substitutions included, that misuses
 * `name`, as {token, why}, or null. `ctx` is what surrounds `tokens` (innerContext). */
function firstMisuse(tokens, from, to, name, aliases, ctx = {}) {
  for (let k = from; k < to; k += 1) {
    const why = misuses(tokens, k, name, aliases, ctx);
    if (why) return {token: tokens[k], why};
    const token = tokens[k];
    for (const inner of token.kind === 'group' ? [token.tokens] : token.substs ?? []) {
      const hit = firstMisuse(inner, 0, inner.length, name, aliases, token.kind === 'group' ? innerContext(tokens, k, ctx) : {});
      if (hit) return hit;
    }
  }
  return null;
}

/** Words whose parenthesised head is followed by a block that runs where it stands. */
const STATEMENT_HEADS = new Set(['if', 'for', 'while', 'with', 'switch', 'catch', 'await']);

/** The range of `tokens` that a function or class starting at `tokens[k]` spans, as {from, to}, or null:
 * a `(...)` and the `{...}` after it (a function declaration or expression, or a method, but not an if,
 * for, while, with, switch or catch), an arrow's parameters and body (an expression body runs to the
 * next `,` or `;`), or a class body. Its code runs when it is called, not where it stands. */
function functionAt(tokens, k) {
  const token = tokens[k];
  if (isPunct(token, '=>')) {
    let to = k + 2;
    if (tokens[k + 1]?.open !== '{') for (to = k + 1; to < tokens.length && !isPunct(tokens[to], ',') && !isPunct(tokens[to], ';'); to += 1);
    return {from: k - 1, to};
  }
  if (token.open !== '{') return null;
  if (tokens[k - 1]?.open === '(' && !STATEMENT_HEADS.has(tokens[k - 2]?.text)) return {from: k - 1, to: k + 1};
  return classBody(tokens, k) ? {from: k, to: k + 1} : null;
}

/** The functions and classes anywhere in `level` (functionAt), as {tokens, from, to}. */
function functionRanges(level) {
  const ranges = [];
  walkTokens(level, (token, tokens, k) => {
    const range = functionAt(tokens, k);
    if (range) ranges.push({tokens, ...range});
  });
  return ranges;
}

/** The loop at or after `tokens[start]` whose statement holds `tokens[index]`, as {from, to}, or null: a
 * for, while or do loop with its head (a for's update runs between passes) and its body. */
function loopAround(tokens, index, start) {
  for (let j = start; j < index; j += 1) {
    let to = -1;
    if (isWord(tokens[j], 'do')) {
      to = statementEnd(tokens, j + 1);
      if (isWord(tokens[to], 'while')) to += 2;
    } else if (isWord(tokens[j], 'for') || isWord(tokens[j], 'while')) {
      const head = isWord(tokens[j + 1], 'await') ? j + 2 : j + 1;
      if (tokens[head]?.open === '(') to = statementEnd(tokens, head + 1);
    }
    if (index < to) return {from: j, to};
  }
  return null;
}

/** The first misuse of `name` in code of the block that declares it (`decl`) that can run between the
 * declaration and the read at the end of `path` without standing between them: a function anywhere in
 * the block, called at any time (before the declaration or after the read as well); a loop in the block
 * around the read, whose next pass runs its whole statement before the read again; and, when the read is
 * itself in a function there, the rest of the block after the declaration. `contexts` is what surrounds
 * each level of `path` (innerContext). */
function runsLater(path, decl, name, aliases, contexts) {
  const block = path[decl.frame].tokens;
  let hit = null, deferred = false;
  for (let frame = decl.frame; frame < path.length; frame += 1) {
    const {tokens, index} = path[frame], loop = loopAround(tokens, index, frame === decl.frame ? decl.at + 1 : 0);
    if (loop) hit ||= firstMisuse(tokens, loop.from, loop.to, name, aliases, contexts[frame]);
    deferred ||= tokens.some((token, k) => { const range = functionAt(tokens, k); return Boolean(range) && range.from <= index && index < range.to; });
  }
  if (deferred) hit ||= firstMisuse(block, decl.at + 1, block.length, name, aliases, contexts[decl.frame]);
  for (const range of functionRanges(block)) hit ||= firstMisuse(range.tokens, range.from, range.to, name, aliases);
  return hit;
}

/** What could change or shadow `name` between its declaration `decl` and the read at the end of `path`:
 * the first misuse in the code between them (an earlier substitution of a template the read is in
 * included), or in code that runs between them from elsewhere (runsLater), or a function declaration of
 * the name in a level the read sits in, hoisted over it. */
function changedBetween(path, decl, name, aliases) {
  const contexts = [{}];
  for (let frame = 1; frame < path.length; frame += 1) {
    const {tokens, index} = path[frame - 1];
    contexts.push(tokens[index].kind === 'group' ? innerContext(tokens, index, contexts[frame - 1]) : {});
  }
  let hit = firstMisuse(path[decl.frame].tokens, decl.at + 1, path[decl.frame].index, name, aliases, contexts[decl.frame]);
  for (let frame = decl.frame + 1; frame < path.length; frame += 1) {
    const holder = path[frame - 1].tokens[path[frame - 1].index], level = path[frame].tokens;
    for (const prior of holder.kind === 'tpl' ? holder.substs.slice(0, holder.substs.indexOf(level)) : []) {
      hit ||= firstMisuse(prior, 0, prior.length, name, aliases);
    }
    const hoisted = level.find((token, k) => token.kind === 'word' && token.text === name && level[k - 1]?.text === 'function');
    hit ||= firstMisuse(level, 0, path[frame].index, name, aliases, contexts[frame]) || (hoisted && {token: hoisted, why: MISUSE});
  }
  return hit || runsLater(path, decl, name, aliases, contexts);
}

/** What a `const` declared by `by` with initialiser `init` aliases: the object its leading member chain
 * reaches (`response.repair` for `const status = response.repair`), as {root, path, by, skip}; `skip` is
 * that chain's root token, the alias itself rather than a use of the root. */
function aliasOf(init, by) {
  const [root] = init, path = [];
  for (let j = 1; (isPunct(init[j], '.') || isPunct(init[j], '?.')) && init[j + 1]?.kind === 'word'; j += 2) path.push(init[j + 1].text);
  return {root: root?.kind === 'word' ? root.text : null, path, by, skip: root};
}

/** The problem with a recorded template whose expression reads names bound as `bound` lists, if any.
 * Each name must be the nearest enclosing `const` before the read (for a later name, before the previous
 * name's declaration), initialised as listed, and neither changed nor shadowed up to the read, nor may
 * what an earlier name aliases through it (`status` is `response.repair`) be. */
function boundProblems(site, bound) {
  const path = [...site.path, ...pathTo(site.level, site.token)], aliases = [];
  let from = path;
  for (const {name, init, is} of bound) {
    const decl = constBefore(from, name), read = `${site.where}: \`${site.template}\` reads ${name}`;
    if (!decl) return [`${read}, which no \`const ${name} = ...\` before it in an enclosing block declares, so its values are unknown`];
    if (!init.test(render(decl.init))) return [`${read} = \`${render(decl.init)}\`, not ${is}, so its values are unknown`];
    const changed = changedBetween(path, decl, name, aliases.filter(alias => alias.root === name));
    if (changed) return [`${read}, which line ${lineOf(site.text, changed.token)} ${changed.why}, so it may not hold ${is} there`];
    aliases.push(aliasOf(decl.init, name));
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
  // Reading values below either name, a method of such a value, and writes elsewhere change neither.
  assert.deepEqual(problems(`${REPAIR_REPLY}note(response.repair.id, response?.repair?.runId, response.ok, status.status.trim(), [status.id], status.id in row);\n` +
    `attempt.status = response.repair.status; attempt.repair = {detail: status.status}; row.response.repair = null;\n${record};`), []);
  // Code after the read runs after it unless a loop or a function brings it back: a write after the read,
  // a loop after it, functions that only read either name and another block's own status change nothing.
  assert.deepEqual(problems(`${REPAIR_REPLY}${record};\nstatus.status = "late";\nfor (const row of rows) response.repair.status = row;\n` +
    'const peek = () => status.status;\nfunction later() { return response.repair.id; }\nif (ok) { const status = {}; status.status = "x"; }'), []);
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
    // A write anywhere along a chain from the name, the same through parentheses, a pattern or a for head.
    [`${reply}status.detail.status = "stalled";\n${record};`, 'reads status, which line 4 uses other than as a member read'],
    [`${reply}(status.status) = "stalled";\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}delete ((status.status));\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}[status.status] = ["stalled"];\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}({late: status.status} = patch);\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}for (status.status of ["stalled"]) break;\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}for (status.status in row) break;\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}for await ((status.status) of rows) break;\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}for ((status.status) in row) break;\n${record};`, 'reads status, which line 4 uses'],
    [`${reply}for ([status.status] in row) break;\n${record};`, 'reads status, which line 4 uses'],
    // status is the object at response.repair, so a write through that source changes status.status too,
    // before status is declared as well as after.
    [`${reply}response.repair.status = "stalled";\n${record};`, 'reads response, which line 4 uses other than as a member read, so it may not hold the bridge'],
    [`${reply}response.repair.status += "_late";\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}++response.repair.status;\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}response?.repair.status--;\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}delete response.repair.status;\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}response.repair.status ??= "stalled";\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}response.repair = patch;\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}response.repair[key] = "stalled";\n${record};`, 'reads response, which line 4 uses'],
    [`${reply}[response.repair.status] = ["stalled"];\n${record};`, 'reads response, which line 4 uses'],
    [reply.replace('\nconst status', '\nresponse.repair.status = "stalled";\nconst status') + `${record};`, 'reads response, which line 3 uses'],
    // Handing that object on lets other code write it: an argument, an alias, a method call on it.
    [`${reply}Object.assign(response.repair, patch);\n${record};`,
      'reads response, which line 4 uses other than as a member read (response.repair holds what status aliases), so it may not hold the bridge'],
    [`${reply}const alias = response.repair;\nalias.status = "stalled";\n${record};`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [`${reply}normalize(response?.repair);\n${record};`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [`${reply}response.repair.reset();\n${record};`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [`${reply}(response.repair).status = "stalled";\n${record};`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [reply.replace('\nconst status', '\nObject.assign(response.repair, patch);\nconst status') + `${record};`,
      'line 3 uses other than as a member read (response.repair holds what status aliases)'],
    // A tag receives the object its function is read from; an earlier substitution of the read's own
    // template runs first; a pattern around the read makes the member before it a target.
    [`${reply}status.fmt\`x\`;\n${record};`, 'reads status, which line 4 uses other than as a member read'],
    [`${reply}response.repair.fmt\`x\`;\n${record};`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [`${reply}log(\`\${Object.assign(response.repair, patch)} \${${record}}\`);`, 'line 4 uses other than as a member read (response.repair holds what status aliases)'],
    [`${reply}[status.status, row[${record}]] = ["stalled", 0];`, 'reads status, which line 4 uses'],
    // Code that runs between them without standing between them: a function anywhere in the block, called
    // at any time (declared after the read and hoisted, or before the declarations); a loop around the
    // read, whose next pass runs its whole statement first; and the rest of the block when the read is
    // itself in a function.
    [`${reply}mutate();\n${record};\nfunction mutate() { status.status = "stalled"; }`, 'reads status, which line 6 uses'],
    [`${reply}mutate();\n${record};\nfunction mutate(late = status.status = "stalled") {}`, 'reads status, which line 6 uses'],
    [`function mutate() { response.repair.status = "stalled"; }\n${reply}mutate();\n${record};`, 'reads response, which line 2 uses'],
    [`const mutate = () => response.repair.status = "stalled";\n${reply}mutate();\n${record};`, 'reads response, which line 2 uses'],
    [`const hooks = {reset() { response.repair = null; }};\n${reply}hooks.reset();\n${record};`, 'reads response, which line 2 uses'],
    [`class Hooks { static reset() { status.status = "stalled"; } }\n${reply}Hooks.reset();\n${record};`, 'reads status, which line 2 uses'],
    [`${reply}for (const row of rows) {\n  ${record};\n  response.repair.status = "stalled";\n}`, 'reads response, which line 6 uses'],
    [`${reply}for (const row of rows) {\n  ${record};\n  status.status = row;\n}`, 'reads status, which line 6 uses'],
    [`${reply}for (let i = 0; i < 2; status.status = "stalled", i += 1) ${record};`, 'reads status, which line 4 uses'],
    [`${reply}while (next()) ${record}, status.status = "stalled";`, 'reads status, which line 4 uses'],
    [`${reply}do {\n  if (ok) ${record};\n  response.repair = patch;\n} while (next());`, 'reads response, which line 6 uses'],
    [`${reply}setTimeout(() => ${record});\nstatus.status = "stalled";`, 'reads status, which line 5 uses'],
    [`${reply}const later = () => {\n  ${record};\n};\nresponse.repair = patch;\nlater();`, 'reads response, which line 7 uses'],
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
    ['const {recordReviewStep: record} = api;\nrecord("unlabelled_alias");', 1, 'recordReviewStep'],
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

test('a recorder is reached only by its name: a string naming one, a call through a computed member it cannot read or a computed read of the global object is a problem', () => {
  const problems = text => recordedStages(text, 'fixture.js').problems;
  const named = (line, token) => `fixture.js:${line} ${token}: a string naming a recorder can reach it through a computed member or a lookup, so the stages it records there cannot be checked`;
  const global = (line, token) => `fixture.js:${line} ${token}: the global object, which holds every recorder declared at the top of a script, is read other than by a static member name, so a recorder reached there records stages that cannot be checked`;
  const called = (line, token) => `fixture.js:${line} ${token}: a call through a computed member whose name the guard cannot read can call a recorder on any object that holds one (the global object holds them all), so the stage it records cannot be checked`;
  // Every recorder is a top-level function declaration, so a property of the global object: a computed
  // member reaches it with no recorder-name word, and its stage would go unchecked.
  for (const [text, ...expected] of [
    ['globalThis["recordReviewStep"]("unlabelled_computed");', named(1, '"recordReviewStep"')],
    ['globalThis["workerStep"](job, provider, "unlabelled_computed");', named(1, '"workerStep"')],
    ['self[`step`]("unlabelled_computed");', named(1, '`step`')],
    ['window?.[\'workerSt\\x65p\'](job, provider, "unlabelled_computed");', named(1, '\'workerSt\\x65p\'')],
    ['const record = Reflect.get(api, "recordReviewStep");\nrecord("unlabelled_lookup");', named(1, '"recordReviewStep"')],
    ['const recorders = {"workerStep": note};', named(1, '"workerStep"')],
    ['log(`${"st\\u0065p"}`);', named(1, '"st\\u0065p"')],
    // A line continuation and a legacy octal escape spell a recorder's name too.
    ['globalThis[\'workerStep\\\n\'](job, provider, "unlabelled_computed");', named(1, '\'workerStep\\\n\'')],
    ['globalThis["workerSte\\160"](job, provider, "unlabelled_computed");', named(1, '"workerSte\\160"')],
    // Passed or stored, a recorder's name may reach a lookup the guard cannot see.
    ['note("step");', named(1, '"step"')],
    ['const kinds = ["workerStep"];', named(1, '"workerStep"')],
    // A name the guard cannot read fails closed.
    ['globalThis[name]("unlabelled_computed");', global(1, 'globalThis'), called(1, '[name]')],
    ['\nglobalThis?.[name]?.(job, provider, "unlabelled_computed");', global(2, 'globalThis'), called(2, '[name]')],
    ['globalThis[`record${kind}`]("unlabelled_computed");', global(1, 'globalThis'), called(1, '[`record${kind}`]')],
    ['globalThis["record" + kind]("unlabelled_computed");', global(1, 'globalThis'), called(1, '["record" + kind]')],
    ['window.self[name]("unlabelled_computed");', global(1, 'window'), called(1, '[name]')],
    ['globalThis["window"][name]("unlabelled_computed");', global(1, 'globalThis'), called(1, '[name]')],
    ['top[name]("unlabelled_computed");', global(1, 'top'), called(1, '[name]')],
    ['this[name]("unlabelled_computed");', global(1, 'this'), called(1, '[name]')],
    ['document.defaultView[name]("unlabelled_computed");', global(1, 'defaultView'), called(1, '[name]')],
    // A document's window however its name is spelled: a string key or a destructured key.
    ['document["defaultView"][name]("unlabelled_view");', global(1, '["defaultView"]'), called(1, '[name]')],
    ['const w = document?.[`defaultView`];', global(1, '[`defaultView`]')],
    ['const {defaultView} = document;\ndefaultView[name](job, provider, "unlabelled_view");', global(1, 'defaultView'), called(2, '[name]')],
    ['const {defaultView: w} = document;\nw[name]("unlabelled_view");', global(1, 'defaultView'), called(2, '[name]')],
    ['const {"defaultView": w} = document;', global(1, '"defaultView"')],
    ['const {["defaultView"]: w} = document;', global(1, '["defaultView"]')],
    // The global object as a value can be searched for a recorder by any name.
    ['const g = globalThis;\ng[name]("unlabelled_alias");', global(1, 'globalThis'), called(2, '[name]')],
    ['Reflect.get(self, name)("unlabelled_lookup");', global(1, 'self')],
    ['Object.values(window).forEach(record => record("unlabelled_each"));', global(1, 'window')],
    ['const {[name]: record} = globalThis;', global(1, 'globalThis')],
    ['const current = globalThis.window;', global(1, 'globalThis')],
    // A global name is a local only where the code binds it: not past an arrow's body, outside a sibling
    // block, a function's parameters or a function expression. A shorthand key reads the name too, and
    // `this` outside a class body is the global object when its function is called plainly.
    ['note({parent, id});', global(1, 'parent')],
    ['rows.map(parent => 0), note(parent);', global(1, 'parent')],
    ['if (ok) { const top = 1; }\nnote(top);', global(2, 'top')],
    ['function f(top) {}\nnote(top);', global(2, 'top')],
    ['const f = function top() {};\nnote(top);', global(2, 'top')],
    ['function pick(key) {\n  return note(this);\n}', global(2, 'this')],
    // The global object arrives as other values too (a method that returns its receiver, an event's
    // target), so a call through a computed member the guard cannot read fails on any object.
    ['const name = ["worker", "Step"].join("");\nglobalThis.valueOf()[name](job, provider, "unlabelled_valueof");', called(2, '[name]')],
    ['self.addEventListener("message", e => e.currentTarget[e.data.fn](job, provider, "unlabelled_event"));', called(1, '[e.data.fn]')],
    ['e.view[name]?.("unlabelled_event");', called(1, '[name]')],
    ['e.source?.[name].call(null, "unlabelled_event");', called(1, '[name]')],
    ['handlers[kind].apply(null, ["unlabelled_apply"]);', called(1, '[kind]')],
    ['const record = handlers[kind].bind(null);\nrecord("unlabelled_bind");', called(1, '[kind]')],
    ['Reflect.apply(e.source[name], null, ["unlabelled_reflect"]);', called(1, '[name]')],
    ['Function.prototype.call.call(handlers[kind], null, "unlabelled_call");', called(1, '[kind]')],
    ['handlers[kind]`unlabelled_tag`;', called(1, '[kind]')],
    ['new handlers[kind]("unlabelled_new");', called(1, '[kind]')],
    ['f()[i](job, provider, "unlabelled_result");', called(1, '[i]')],
    // Through parentheses, whose value the member can be, and through new, which calls what it constructs.
    ['(e.view[name])("unlabelled_paren");', called(1, '[name]')],
    ['(0, e.view[name])("unlabelled_comma");', called(1, '[name]')],
    ['(e.view[name] || note)("unlabelled_either");', called(1, '[name]')],
    ['Reflect.apply((e.view[name]), null, ["unlabelled_reflect"]);', called(1, '[name]')],
    ['new e.view[name];', called(1, '[name]')],
    ['new (e.view?.[name]);', called(1, '[name]')],
  ]) assert.deepEqual(problems(text), expected, text);
  assert.deepEqual(problems('const {recordReviewStep: record} = globalThis;'), [
    'fixture.js:1 recordReviewStep: the recorder is used other than by a call, so the stages it records through that use cannot be checked',
    global(1, 'globalThis')]);
  // Static member names, typeof, an object key and another object's properties reach no recorder.
  assert.deepEqual(problems('window.getComputedStyle(node); globalThis.__ashlarRunnerState = state; globalThis.window?.getComputedStyle(el);\n' +
    'const saved = globalThis["__ashlarRunnerState"]; if (typeof window === "undefined") note(self.location?.href);\n' +
    'const box = {top: rect.top, window: 1}; node.parent[key] = rect.top + 1; const view = document.defaultView.innerWidth;\n' +
    'globalThis.recordReviewStep?.("optional_call"); const doc = "workerStep(job, provider, stage)"; note("steps", "Step");\n' +
    'note(window.this);'), []);
  // A local of a global name is not the global object: a declaration (a pattern's too), a parameter (an
  // arrow's, a catch's, a function expression's own name), a for head's declaration, a method's name or
  // an object key; nor is `this` in a class body.
  assert.deepEqual(problems('const {top, left} = rect; const frames = []; note(frames, top, left);\n' +
    'function f(parent) { return parent.id + note(parent); }\nfunction g(parent, id) { return {parent, id}; }\n' +
    'rows.map(self => note(self)); rows.map((window, i) => note(window, i)); rows.map(({top}) => note(top));\n' +
    'try { run(); } catch (window) { note(window); }\nfor (const top of rows) note(top);\nfor (const [parent] of rows) { note(parent); }\n' +
    'class A { m(key) { return note(this[key]); } static n() { return this; } }\nconst o = {top() { return 1; }, parent(x) { return x; }};\n' +
    'const pick = function self(n) { return n ? self(n - 1) : note(self); };'), []);
  // A recorder's name only compared is a boolean's operand, never a key.
  assert.deepEqual(problems('if (kind === "step") go(); if ("workerStep" !== row.kind) skip(); ok = kind == `step`;\n' +
    'switch (kind) { case "recordReviewStep": break; }'), []);
  // A computed member the guard can read, one that is not called, or an array literal calls no recorder
  // by a hidden name.
  assert.deepEqual(problems('handlers["open"](row); rows[0](); const state = job.states[provider]; job.states[provider].runId = id;\n' +
    'note(job.states[provider], rows[i]); if (ok) [a, b].forEach(note); Reflect.apply(note, null, [rows[i]]); return [a](b);\n' +
    'const state = (job.states[provider]); note((rows[i]).id, (0, rows[i])); f(a)(rows[i]); new Row(rows[i]); new f()[i];'), []);
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
