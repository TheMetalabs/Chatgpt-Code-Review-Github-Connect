// Tab release (#82): once a leg's result is secured, or nobody wants it (cancelled / forgotten), its
// chat tab is closed unless the user positively took it over. These rows pin the worker side (vm
// harness) and the history diagnostics; the real-page scenarios are in tab-release.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {root, source} from './load-source.mjs';
import {PROGRESS_LABELS} from '../../src/lib/review-progress.ts';

/** The string-literal stages a progress call can record: literals of workerStep / recordReviewStep /
 * step arguments, including both arms of a conditional, but not the arguments of a nested call
 * (`reason?.includes("preserved")` is not a stage). */
function recordedStages(text) {
  const stages = new Set();
  for (const call of text.matchAll(/\b(?:workerStep|recordReviewStep|step)\(/g)) {
    const parens = [];
    for (let i = call.index + call[0].length - 1; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
        const literal = text.slice(i + 1, j);
        if (c === '"' && !parens.slice(1).includes('call') && /^[a-z][a-z0-9_]*$/.test(literal)) stages.add(literal);
        i = j;
      } else if (c === '(') {
        parens.push(!parens.length ? 'outer' : /[\w$)\]]/.test(text[i - 1]) ? 'call' : 'group');
      } else if (c === ')') {
        parens.pop();
        if (!parens.length) break;
      }
    }
  }
  return stages;
}

test('every stage the extension records has a history label (sanitizeProgressEvents drops unlabelled ones)', () => {
  const files = readdirSync(join(root, 'extension')).filter(name => name.endsWith('.js'));
  const stages = new Set(files.flatMap(name => [...recordedStages(source(`extension/${name}`))]));
  assert.ok(stages.has('tab_closed') && stages.has('generating') && stages.has('prompt_submitted'), 'sanity: the scan sees worker, page and composer stages');
  assert.equal(stages.has('preserved'), false, 'a nested call argument is not a stage');
  const unlabelled = [...stages].filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)).sort();
  assert.deepEqual(unlabelled, [], 'recorded stages without a PROGRESS_LABELS entry never reach review history');
});

test('the tab-release diagnostic stages have history labels', () => {
  const stages = ['cancelled', 'cleanup_waiting_page', 'tab_preserved', 'tab_closed',
    ...['navigated', 'user_turn', 'edited', 'draft', 'ownership_unknown', 'unreachable', 'other_binding', 'unknown'].map(cause => `preserve_${cause}`)];
  assert.deepEqual(stages.filter(stage => !Object.hasOwn(PROGRESS_LABELS, stage)), []);
});
