// One validity domain for every Settings field: the set of values the Settings screen accepts
// equals the set the Settings API accepts. For each field, valid, boundary and invalid samples run
// through BOTH:
//   UI     — the input's own constraint validation (min / max / step from settings-rules formAttrs,
//            for a field the screen renders as a number input) AND the page's check
//            (settingsProblem on the draft it would send, after the form-unit conversion);
//   server — the production route (/api/harbor action=settings) with the production validator.
// Any value one side takes and the other refuses is a domain mismatch and fails the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../../src/lib/settings-rules.ts';
import {DEFAULT_SETTINGS, FIX_AGENT_KNOBS, SECRET_MASK} from '../../src/lib/types.ts';
import {nativeValid, settingsHarness} from './settings-harness.mjs';

// The stored document the screen hydrates from (every reviewer usable, so a reviewer flag can flip).
const STORED = {reviewLocal: true, localLlmBaseUrl: 'http://127.0.0.1:1/v1', localLlmModel: 'm', webhookSecret: 'hook', localLlmApiKey: 'sk'};

function domains() {
  assert.equal(typeof rules.formAttrs, 'function', 'settings-rules derives the UI input domain (formAttrs)');
  assert.ok(rules.SETTINGS_INT_FIELDS, 'settings-rules owns every whole-number field domain (SETTINGS_INT_FIELDS)');
  return rules.SETTINGS_INT_FIELDS;
}

/** The screen: native input constraints (number inputs) + the page's shared check. */
function uiAccepts(draft, key, value) {
  const ints = domains();
  let v = value;
  if (key in ints && typeof value === 'number') {
    const attrs = rules.formAttrs(ints[key]);
    const shown = rules.toForm(attrs.unit, value);
    if (!nativeValid(attrs, shown)) return false;
    v = rules.fromForm(attrs.unit, shown);
  }
  if (key === 'fixAgent' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const f of rules.FIX_KNOB_FIELDS) {
      if (typeof value[f.key] !== 'number') continue;
      const attrs = rules.formAttrs(rules.fixKnobDomain(f.key));
      if (!nativeValid(attrs, rules.toForm(attrs.unit, value[f.key]))) return false;
    }
  }
  return rules.settingsProblem({...draft, [key]: v}) === null;
}

async function serverAccepts(key, value) {
  const h = settingsHarness(STORED);
  const before = structuredClone(h.state.settings);
  const res = await h.post({[key]: value});
  if (res.status !== 200) {
    assert.equal(res.status, 400, `${key}=${JSON.stringify(value)}: a rejection is a 400`);
    assert.deepEqual(h.state.settings, before, `${key}=${JSON.stringify(value)}: a rejection changes nothing`);
    return false;
  }
  return true;
}

const junk = [null, {}, [], 'x', 1, true];
function intSamples(d) {
  const mid = d.max === Number.MAX_SAFE_INTEGER ? d.min + 12345 : Math.floor((d.min + d.max) / 2);
  return [d.min, d.max, d.min + 1, mid, d.max - 1, d.min - 1, d.max + 1, d.min + 0.5, mid + 0.25, NaN, -1, String(d.min), null, true];
}
function samples(key) {
  const ints = domains();
  if (key in ints) return intSamples(ints[key]);
  const B = [true, false, 'true', 'false', 1, 0, null];
  const S = ['', ' ', 'value', ' padded ', 42, null, {}, ['x'], false];
  const byKey = {
    username: S,
    mention: [['@a'], ['@a', '/b'], [' @a '], [], [''], [' '], ['@a', ''], [42], '@a', null, {}],
    publishMinSeverity: ['P0', 'P1', 'P2', 'P3', 'p1', '', 1, null],
    requestChangesMin: ['P0', 'P1', 'P2', 'P9', 2, null],
    webhookSecret: [...S, SECRET_MASK],
    localLlmApiKey: [...S, SECRET_MASK],
    localLlmBaseUrl: S,
    localLlmModel: S,
    chatgptReasoning: ['instant', 'medium', 'high', 'extra_high', 'pro', 'bogus', '', 3, null],
    grokReasoning: ['auto', 'fast', 'expert', 'heavy', 'bogus', '', 3, null],
    localReviewMode: ['single', 'multiturn', 'auto', 'turbo', '', 1, null],
    reviewOrder: [['local', 'chatgpt', 'grok'], ['grok', 'chatgpt', 'local'], ['grok'], ['local', 'local', 'grok'], ['local', 'chatgpt', 'bing'],
      ['local', 'chatgpt', 'grok', 'grok'], [], 'local', null],
    fixAgent: fixAgentSamples(),
  };
  if (key in byKey) return byKey[key];
  if (typeof DEFAULT_SETTINGS[key] === 'boolean') return B;
  return junk;
}
function fixAgentSamples() {
  const base = {...DEFAULT_SETTINGS.fixAgent};
  const out = [null, false, 'off', [], 1, {...base, enabled: true, provider: 'grok'}, {...base, enabled: true}, {...base, enabled: 'true'},
    {...base, provider: 'coding-agent', delivery: 'coding-agent'}, {...base, provider: 'coding-agent', delivery: 'coding-agent', enabled: true},
    {...base, provider: 'local', delivery: 'chat-push'}, {...base, mode: 'yolo'}, {...base, provider: 'skynet'}];
  for (const [key, k] of Object.entries(FIX_AGENT_KNOBS)) {
    for (const v of [k.min, k.max, k.min + 1, k.max - 1, k.min - 1, k.max + 1, k.min + 0.5, 90_000, NaN, String(k.min), null]) out.push({...base, [key]: v});
  }
  return out;
}

test('every settings field: the UI accepts exactly the values the server accepts', async () => {
  domains();
  const keys = Object.keys(DEFAULT_SETTINGS);
  const draft = settingsHarness(STORED).state.settings;
  const mismatches = [];
  let checked = 0;
  for (const key of keys) {
    for (const value of samples(key)) {
      const ui = uiAccepts(draft, key, value);
      const server = await serverAccepts(key, value);
      checked++;
      if (ui !== server) mismatches.push(`${key}=${JSON.stringify(value)}: UI ${ui ? 'accepts' : 'rejects'}, server ${server ? 'accepts' : 'rejects'}`);
    }
  }
  assert.deepEqual(mismatches, [], `${mismatches.length} of ${checked} samples disagree`);
  assert.ok(checked > 250, `sampled ${checked} values`);
});

test('the numeric inputs the screen renders take their domain from settings-rules', () => {
  const ints = domains();
  const inline = rules.formAttrs(ints.maxInlineComments);
  assert.deepEqual(inline, {min: 0, max: 20, step: 1, unit: 'count'});
  for (const f of rules.FIX_KNOB_FIELDS) {
    const attrs = rules.formAttrs(rules.fixKnobDomain(f.key));
    assert.equal(attrs.step, f.unit === 'minutes' ? 'any' : 1, f.key);
  }
});
