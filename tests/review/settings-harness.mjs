// The production Settings route (/api/harbor action=settings) over an in-memory store. Only I/O is
// replaced: patchHarborSettings keeps its production contract — validate the patch with the shared
// rules (settings-rules validatedSettingsPatch), sanitize, persist (SettingsError 500 when the JSON
// store cannot be written), THEN swap the live settings.
import {loadTs, types} from './load-source.mjs';
import {sanitizeBotSettings} from '../../src/lib/settings.server.ts';
import {SettingsError, validatedSettingsPatch} from '../../src/lib/settings-rules.ts';
import {normalizeChatgptReasoning, normalizeGrokReasoning} from '../../src/lib/reasoning.ts';

export function settingsHarness(initial = {}) {
  const state = {settings: sanitizeBotSettings(initial), persistFails: false};
  const saves = [];
  const publicSettings = s => ({...s, webhookSecret: '', localLlmApiKey: ''});
  const {Route} = loadTs('src/routes/api/harbor.ts', {
    ...types,
    createFileRoute: () => config => config,
    getHarbor: () => ({...state, jobs: [], events: [], reviews: []}),
    patchHarborSettings: patch => {
      const next = sanitizeBotSettings(validatedSettingsPatch(state.settings, patch));
      if (state.persistFails) throw new SettingsError('could not save settings: .data/ashlar-settings.json is not writable (ENOTDIR); nothing was changed', 500);
      saves.push(next);
      state.settings = next;
      return next;
    },
    publicSettings, publicJobs: j => j, publicReviews: r => r,
    githubStatus: () => ({}), getBridgePublic: () => ({}), reviewHistory: () => ({health: () => ({ok: true})}),
    normalizeChatgptReasoning, normalizeGrokReasoning,
  });
  const post = body => Route.server.handlers.POST({request: new Request('http://ashlar.test/api/harbor', {
    method: 'POST', headers: {origin: 'http://ashlar.test', 'content-type': 'application/json'}, body: JSON.stringify({action: 'settings', ...body}),
  })});
  const get = async () => (await (await Route.server.handlers.GET()).json()).settings;
  return {state, saves, post, get};
}

/** The browser's constraint validation for <input type=number min max step> (HTML: step base = min). */
export function nativeValid(attrs, formValue) {
  if (!Number.isFinite(formValue)) return true; // an empty input has no range/step error; the page's check rejects NaN
  if (formValue < attrs.min || formValue > attrs.max) return false;
  if (attrs.step === 'any') return true;
  const steps = (formValue - attrs.min) / attrs.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}
