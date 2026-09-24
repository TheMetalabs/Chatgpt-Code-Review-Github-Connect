// Every ms fix-agent knob has ONE validity domain — an integer number of ms in [min, max] — at
// every boundary: the env seed, load, the API save and the UI save. The Settings screen edits these
// in minutes; its input (min / max / step, derived from settings-rules) must represent every
// server-valid value, e.g. 90000 ms = 1.5 min (a step=1 minutes input failed the browser's
// stepMismatch on it and blocked every save).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../../src/lib/settings-rules.ts';
import {overlayEnv, sanitizeBotSettings} from '../../src/lib/settings.server.ts';
import {DEFAULT_SETTINGS, FIX_AGENT_KNOBS} from '../../src/lib/types.ts';
import {settingsHarness} from './settings-harness.mjs';

const MS_KNOBS = ['timeoutMs', 'queueMaxMs', 'chatTimeoutMs'];

/** The browser's constraint validation for <input type=number min max step> (HTML: step base = min). */
export function nativeValid(attrs, formValue) {
  if (!Number.isFinite(formValue)) return true; // an empty input has no range/step error; the page's check rejects NaN
  if (formValue < attrs.min || formValue > attrs.max) return false;
  if (attrs.step === 'any') return true;
  const steps = (formValue - attrs.min) / attrs.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** What the Settings screen accepts for one fix-agent knob, given the value the operator typed. */
function uiAccepts(key, formValue) {
  assert.equal(typeof rules.formAttrs, 'function', 'the UI input domain is derived from settings-rules (formAttrs)');
  const attrs = rules.formAttrs(rules.fixKnobDomain(key));
  if (!nativeValid(attrs, formValue)) return false;
  const fixAgent = {...DEFAULT_SETTINGS.fixAgent, [key]: rules.fromForm(attrs.unit, formValue)};
  return rules.settingsProblem({...DEFAULT_SETTINGS, fixAgent}) === null;
}

function samples(key) {
  const {min, max} = FIX_AGENT_KNOBS[key];
  return {
    valid: [min, max, min + 1, max - 1, min + 30_000, 90_000, 60_001, Math.round((min + max) / 2) + 7].filter(v => v >= min && v <= max),
    invalid: [min - 1, max + 1, min + 0.5, 90_000.25, 0, -60_000],
  };
}

for (const key of MS_KNOBS) {
  test(`${key}: the UI represents every server-valid ms value exactly (step "any", exact minutes<->ms)`, () => {
    assert.equal(typeof rules.formAttrs, 'function', 'formAttrs is exported by settings-rules');
    const attrs = rules.formAttrs(rules.fixKnobDomain(key));
    assert.equal(attrs.unit, 'minutes');
    assert.equal(attrs.step, 'any', 'a minutes input must not step by whole minutes');
    assert.equal(attrs.min, FIX_AGENT_KNOBS[key].min / 60_000);
    assert.equal(attrs.max, FIX_AGENT_KNOBS[key].max / 60_000);
    const {valid, invalid} = samples(key);
    for (const ms of valid) {
      const shown = rules.toForm(attrs.unit, ms);
      assert.equal(rules.fromForm(attrs.unit, shown), ms, `${ms} ms round-trips through the form (${shown} min)`);
      assert.equal(uiAccepts(key, shown), true, `UI accepts ${ms} ms (${shown} min)`);
      assert.equal(rules.fixAgentProblem({[key]: ms}), null, `server accepts ${ms} ms`);
    }
    for (const ms of invalid) {
      assert.equal(uiAccepts(key, rules.toForm(attrs.unit, ms)), false, `UI rejects ${ms} ms`);
      assert.match(rules.fixAgentProblem({[key]: ms}) ?? '', /must be a whole number of milliseconds/, `server rejects ${ms} ms`);
    }
    // A typed minutes value that is not a whole number of ms: native-valid (step any), the page rejects it.
    assert.equal(uiAccepts(key, attrs.min + 0.00001), false);
    // An emptied input is rejected by the page, as the server rejects a non-number.
    assert.equal(uiAccepts(key, NaN), false);
  });

  test(`${key}: what the env seed and load keep, the UI shows and accepts unchanged`, (t) => {
    const env = FIX_AGENT_KNOBS[key].env;
    const prev = process.env[env];
    t.after(() => { if (prev === undefined) delete process.env[env]; else process.env[env] = prev; });
    for (const ms of samples(key).valid) {
      process.env[env] = String(ms);
      const seeded = sanitizeBotSettings(overlayEnv({}));
      assert.equal(seeded.fixAgent[key], ms, `env ${env}=${ms} seeds exactly`);
      assert.equal(rules.settingsProblem(seeded), null, 'what env seeds, a save accepts');
      const loaded = sanitizeBotSettings({fixAgent: {[key]: ms}}).fixAgent[key];
      assert.equal(loaded, ms, 'load keeps it');
      assert.equal(uiAccepts(key, rules.toFormUnit(key, loaded)), true, `the Settings screen accepts the loaded ${ms} ms as shown`);
    }
  });

  test(`${key}: API save accepts every whole-ms value in range and rejects the rest (400, nothing changes)`, async () => {
    const h = settingsHarness();
    const {valid, invalid} = samples(key);
    for (const ms of valid) {
      const res = await h.post({fixAgent: {[key]: ms}});
      assert.equal(res.status, 200, `${ms}`);
      assert.equal(h.state.settings.fixAgent[key], ms);
    }
    const before = structuredClone(h.state.settings);
    for (const ms of invalid) {
      const res = await h.post({fixAgent: {[key]: ms}});
      assert.equal(res.status, 400, `${ms}`);
      assert.match((await res.json()).error, /must be a whole number of milliseconds/);
    }
    assert.deepEqual(h.state.settings, before);
  });
}

test('90000 ms stored for both deadlines: an unrelated save keeps them (the UI check passes on the loaded draft)', async () => {
  const h = settingsHarness({fixAgent: {timeoutMs: 90_000, chatTimeoutMs: 90_000}});
  assert.equal(h.state.settings.fixAgent.timeoutMs, 90_000);
  for (const key of ['timeoutMs', 'chatTimeoutMs']) assert.equal(uiAccepts(key, 1.5), true, `${key}: 1.5 min`);
  const res = await h.post({skipForks: false, fixAgent: h.state.settings.fixAgent});
  assert.equal(res.status, 200);
  assert.equal(h.state.settings.fixAgent.timeoutMs, 90_000);
  assert.equal(h.state.settings.fixAgent.chatTimeoutMs, 90_000);
  assert.equal(h.state.settings.skipForks, false);
});
