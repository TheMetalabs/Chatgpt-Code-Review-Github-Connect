// sanitizeProgressEvents keeps only stages that are PROGRESS_LABELS keys, so a stage the extension
// records without a label never reaches review history or the live reviewer status. These rows pin
// that every stage the extension can record is labelled — including the ones built from a template.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {root, source} from './load-source.mjs';
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

test('salvaged_no_repair (worker: raw reply delivered with Local JSON repair off) reaches history', () => {
  assert.deepEqual(kept(['salvaged_no_repair']), ['salvaged_no_repair']);
});

test('a template stage without a declared expansion fails the guard instead of passing unchecked', () => {
  assert.throws(() => expandTemplate('lease_expired_${phase}'), /no declared expansion/);
  assert.throws(() => expandTemplate('repair_${status.status}_late'), /exactly <prefix>/);
  const {templates} = recordedStages('workerStep(job, provider, `repair_${status.status}`);');
  assert.deepEqual([...templates], ['repair_${status.status}']);
});
