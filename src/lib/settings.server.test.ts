import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDotenvLoadedForTests } from "./dotenv-file.server.ts";
import {
  botSettingsToEnv,
  diskFixAgentWins,
  diskReviewerFlagsWin,
  loadBotSettings,
  overlayEnv,
  persistableSettings,
  sanitizeBotSettings,
  saveBotSettings,
} from "./settings.server.ts";
import { SettingsError, fixAgentProblem, fixLoopOn, settingsProblem } from "./settings-rules.ts";
import { DEFAULT_SETTINGS, FIX_AGENT_KNOBS, providersFromSettings, type BotSettings, type FixAgentKnob, type FixAgentSettings } from "./types.ts";

describe("sanitizeBotSettings", () => {
  it("keeps local LLM fields from a saved document", () => {
    const s = sanitizeBotSettings({
      reviewLocal: true,
      reviewChatgpt: false,
      reviewGrok: false,
      localLlmBaseUrl: "http://127.0.0.1:1234/v1",
      localLlmModel: "qwen2.5-coder",
      localLlmApiKey: "sk-local",
    });
    assert.equal(s.reviewLocal, true);
    assert.equal(s.reviewChatgpt, false);
    assert.equal(s.localLlmModel, "qwen2.5-coder");
    assert.equal(s.localLlmApiKey, "sk-local");
    assert.equal(s.localLlmBaseUrl, "http://127.0.0.1:1234/v1");
  });

  it("falls back to defaults and refuses zero reviewers", () => {
    const s = sanitizeBotSettings({ reviewChatgpt: false, reviewGrok: false, reviewLocal: false });
    assert.equal(s.reviewChatgpt, true);
    assert.equal(s.username, DEFAULT_SETTINGS.username);
  });

  it("round-trips reviewer flags into env keys", () => {
    const env = botSettingsToEnv({
      ...DEFAULT_SETTINGS,
      reviewLocal: true,
      reviewChatgpt: false,
      reviewGrok: true,
      localLlmModel: "qwen",
    });
    assert.equal(env.ASHLAR_REVIEW_LOCAL, "true");
    assert.equal(env.ASHLAR_REVIEW_CHATGPT, "false");
    assert.equal(env.ASHLAR_LOCAL_LLM_MODEL, "qwen");
    const defaults = botSettingsToEnv(DEFAULT_SETTINGS);
    assert.equal(defaults.ASHLAR_CHATGPT_REASONING, "pro");
    assert.equal(defaults.ASHLAR_GROK_REASONING, "heavy");
  });

  it("persists skip/severity policy fields", () => {
    const s = sanitizeBotSettings({
      skipForks: false,
      skipDrafts: false,
      precisionOverRecall: false,
      maxInlineComments: 3,
      publishMinSeverity: "P0",
      requestChangesMin: "P0",
    });
    assert.equal(s.skipForks, false);
    assert.equal(s.maxInlineComments, 3);
    assert.equal(s.publishMinSeverity, "P0");
  });

  it("keeps at least one reviewer if env disables local on a local-only disk", () => {
    const s = sanitizeBotSettings({
      reviewChatgpt: false,
      reviewGrok: false,
      reviewLocal: false,
      localLlmBaseUrl: "http://127.0.0.1:8000/v1",
      localLlmModel: "qwen",
    });
    assert.ok(providersFromSettings(s).length >= 1);
    assert.equal(s.reviewChatgpt, true);
  });

  it("does not copy an env-only API key onto disk", () => {
    const runtime = sanitizeBotSettings({
      ...DEFAULT_SETTINGS,
      localLlmApiKey: "env-secret",
    });
    const disk = persistableSettings(runtime, { ASHLAR_LOCAL_LLM_API_KEY: "env-secret" }, {});
    assert.equal(disk.localLlmApiKey, "");
  });

  it("keeps the disk key when env is rotated, without treating rotation as a UI save", () => {
    const runtime = sanitizeBotSettings({ ...DEFAULT_SETTINGS, localLlmApiKey: "rotated-B" });
    const disk = persistableSettings(runtime, { ASHLAR_LOCAL_LLM_API_KEY: "rotated-B" }, { localLlmApiKey: "old-A" });
    assert.equal(disk.localLlmApiKey, "old-A");
  });

  it("keeps Settings reviewer toggles over env overlays", () => {
    const merged = diskReviewerFlagsWin(
      { reviewGrok: false, reviewChatgpt: true, reviewLocal: true },
      { reviewGrok: true, reviewChatgpt: true, reviewLocal: true },
    );
    assert.equal(merged.reviewGrok, false);
    assert.equal(merged.reviewChatgpt, true);
  });

  it("defaults the fix agent to disabled (no auto-fix) with safe delivery/mode", () => {
    const s = sanitizeBotSettings({});
    assert.equal(s.fixAgent.enabled, false);
    assert.equal(s.fixAgent.provider, null);
    assert.equal(s.fixAgent.delivery, "script-apply");
    assert.equal(s.fixAgent.mode, "suggest");
    assert.ok(s.fixAgent.parallelPrs >= 1);
  });

  it("normalizes fix agent config and rejects unknown values", () => {
    const ok = sanitizeBotSettings({ fixAgent: { provider: "local", delivery: "script-apply", mode: "apply", parallelPrs: 5 } });
    assert.deepEqual(ok.fixAgent, { ...DEFAULT_SETTINGS.fixAgent, provider: "local", delivery: "script-apply", mode: "apply", parallelPrs: 5 });
    const bad = sanitizeBotSettings({ fixAgent: { provider: "bogus", delivery: "diff", mode: "yolo", parallelPrs: 999 } });
    assert.equal(bad.fixAgent.provider, null); // unknown provider -> default (disabled)
    assert.equal(bad.fixAgent.delivery, "script-apply");
    assert.equal(bad.fixAgent.mode, "suggest");
    assert.equal(bad.fixAgent.parallelPrs, 20); // clamped
  });

  it("never mirrors fixAgent into env: the settings JSON is its only durable store", () => {
    const s = sanitizeBotSettings({ fixAgent: { enabled: true, provider: "chatgpt", delivery: "chat-push", mode: "apply", parallelPrs: 4 } });
    const env = botSettingsToEnv(s);
    assert.deepEqual(Object.keys(env).filter((k) => /^ASHLAR_(FIX|LOOP)_/.test(k)), []);
    // An explicit empty ASHLAR_FIX_PROVIDER still SEEDS "no provider" (J2/J8) for a never-saved field.
    const prev = process.env.ASHLAR_FIX_PROVIDER;
    try {
      process.env.ASHLAR_FIX_PROVIDER = "";
      const base = sanitizeBotSettings({ fixAgent: { provider: "chatgpt", delivery: "chat-push", mode: "suggest", parallelPrs: 3 } }) as unknown as Record<string, unknown>;
      assert.equal(sanitizeBotSettings(overlayEnv(base)).fixAgent.provider, null, "empty env provider seeds no provider");
    } finally {
      if (prev === undefined) delete process.env.ASHLAR_FIX_PROVIDER; else process.env.ASHLAR_FIX_PROVIDER = prev;
    }
  });

  it("fixAgent round-trips every Settings field unchanged", () => {
    const full = {
      enabled: true,
      provider: "chatgpt",
      delivery: "script-apply",
      mode: "apply",
      parallelPrs: 4,
      roundCap: 7,
      attempts: 3,
      timeoutMs: 45 * 60_000,
      queueMaxMs: 2 * 60 * 60_000,
      chatTimeoutMs: 20 * 60_000,
      chatMaxPromptChars: 250_000,
    };
    const once = sanitizeBotSettings({ fixAgent: full });
    assert.deepEqual(once.fixAgent, full);
    assert.deepEqual(sanitizeBotSettings(JSON.parse(JSON.stringify(once))).fixAgent, full, "saved JSON → load is lossless");
  });

  it("rejects or normalizes invalid fixAgent values (switch fails closed, numbers clamped)", () => {
    for (const v of ["true", 1, "on", null, undefined, {}]) {
      assert.equal(sanitizeBotSettings({ fixAgent: { enabled: v, provider: "local" } }).fixAgent.enabled, false, JSON.stringify(v));
    }
    const low = sanitizeBotSettings({ fixAgent: { parallelPrs: 0, roundCap: -3, attempts: 0, timeoutMs: 5, queueMaxMs: 1, chatTimeoutMs: 1, chatMaxPromptChars: 10 } }).fixAgent;
    const high = sanitizeBotSettings({ fixAgent: { parallelPrs: 1e9, roundCap: 1e9, attempts: 99, timeoutMs: 1e12, queueMaxMs: 1e12, chatTimeoutMs: 1e12, chatMaxPromptChars: 1e12 } }).fixAgent;
    const junk = sanitizeBotSettings({ fixAgent: { parallelPrs: "7", roundCap: NaN, attempts: "x", timeoutMs: null, queueMaxMs: Infinity, chatTimeoutMs: [], chatMaxPromptChars: {} } }).fixAgent;
    for (const [key, knob] of Object.entries(FIX_AGENT_KNOBS)) {
      assert.equal((low as unknown as Record<string, number>)[key], knob.min, `${key} low`);
      assert.equal((high as unknown as Record<string, number>)[key], knob.max, `${key} high`);
      assert.equal((junk as unknown as Record<string, number>)[key], knob.def, `${key} junk`);
    }
    assert.equal(sanitizeBotSettings({ fixAgent: { roundCap: 2.9 } }).fixAgent.roundCap, 2, "whole rounds");
  });

  it("env seeds the fix agent only until Settings saved it; the switch has no env var", () => {
    const keys = ["ASHLAR_FIX_PROVIDER", "ASHLAR_LOOP_ROUND_CAP", "ASHLAR_FIX_CHAT_TIMEOUT_MS", "ASHLAR_FIX_AGENT"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, { ASHLAR_FIX_PROVIDER: "grok", ASHLAR_LOOP_ROUND_CAP: "7", ASHLAR_FIX_CHAT_TIMEOUT_MS: "120000", ASHLAR_FIX_AGENT: "1" });
      const seeded = sanitizeBotSettings(overlayEnv({})).fixAgent;
      assert.deepEqual([seeded.enabled, seeded.provider, seeded.roundCap, seeded.chatTimeoutMs], [false, "grok", 7, 120_000]);
      const disk = { fixAgent: sanitizeBotSettings({ fixAgent: { enabled: true, provider: "local", roundCap: 3 } }).fixAgent };
      const loaded = sanitizeBotSettings(diskFixAgentWins(disk, overlayEnv(disk))).fixAgent;
      assert.deepEqual([loaded.enabled, loaded.provider, loaded.roundCap, loaded.chatTimeoutMs], [true, "local", 3, DEFAULT_SETTINGS.fixAgent.chatTimeoutMs]);
      assert.equal("ASHLAR_FIX_ENABLED" in botSettingsToEnv(sanitizeBotSettings(disk)), false);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("a saved fix agent survives a process restart even when the startup env says otherwise", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "fix-agent-settings-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const module = new URL("./settings.server.ts", import.meta.url).href;
    const env = { PATH: process.env.PATH, HOME: cwd, ASHLAR_FIX_PROVIDER: "", ASHLAR_LOOP_ROUND_CAP: "9", ASHLAR_FIX_AGENT: "0" };
    const run = (code: string) =>
      spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import * as settings from ${JSON.stringify(module)};${code}`], { cwd, env, encoding: "utf8" });
    const fresh = run("console.log(JSON.stringify(settings.loadBotSettings().fixAgent))");
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout).enabled, false);
    const saved = run('settings.saveBotSettings(settings.sanitizeBotSettings({fixAgent:{enabled:true,provider:"chatgpt",roundCap:2}}));');
    assert.equal(saved.status, 0, saved.stderr);
    const restored = run("console.log(JSON.stringify(settings.loadBotSettings().fixAgent))");
    assert.equal(restored.status, 0, restored.stderr);
    const fix = JSON.parse(restored.stdout);
    assert.deepEqual([fix.enabled, fix.provider, fix.roundCap], [true, "chatgpt", 2]);
  });

  it("enforces the provider→delivery matrix, disabling incompatible pairs (F7)", () => {
    // chatgpt/grok support script-apply | chat-push
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "chatgpt", delivery: "chat-push" } }).fixAgent.provider, "chatgpt");
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "grok", delivery: "script-apply" } }).fixAgent.provider, "grok");
    // local => script-apply only; chat-push is invalid => disabled
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "local", delivery: "chat-push" } }).fixAgent.provider, null);
    // coding-agent => coding-agent only; script-apply is invalid => disabled
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "coding-agent", delivery: "script-apply" } }).fixAgent.provider, null);
    assert.equal(sanitizeBotSettings({ fixAgent: { provider: "coding-agent", delivery: "coding-agent" } }).fixAgent.provider, "coding-agent");
  });
});

describe("prompt budgets", () => {
  it("applies budget defaults and honors validated overrides", () => {
    assert.equal(sanitizeBotSettings({}).promptDiffMaxChars, DEFAULT_SETTINGS.promptDiffMaxChars);
    const s = sanitizeBotSettings({ promptDiffMaxChars: 123456, contextPadLines: 5 });
    assert.equal(s.promptDiffMaxChars, 123456);
    assert.equal(s.contextPadLines, 5);
    assert.equal(sanitizeBotSettings({ promptContextMaxChars: -1 }).promptContextMaxChars, 0);
  });

  it("round-trips prompt budgets into env keys", () => {
    const env = botSettingsToEnv(DEFAULT_SETTINGS);
    assert.equal(env.ASHLAR_PROMPT_DIFF_MAX_CHARS, "300000");
    assert.equal(env.ASHLAR_CONTEXT_PAD_LINES, "20");
  });
});

// ── Every fixAgent field: validated by the ONE rule set (settings-rules, the same function the
// Settings screen calls), durable ONLY through the settings JSON. Scenarios per field: UI
// validation, save path, env seed only, restart/load, and a save while the JSON store is unusable
// (.data broken, .env writable) — that save must FAIL and a restart must load the last good save.
type FixRow = { key: keyof FixAgentSettings; base?: Partial<FixAgentSettings>; good: unknown; next: unknown; bad: unknown; label: RegExp; env?: { name: string; raw: string; seeded: unknown } };
const K = FIX_AGENT_KNOBS;
const FIX_ROWS: FixRow[] = [
  { key: "enabled", base: { provider: "chatgpt" }, good: true, next: false, bad: "true", label: /fix_agent\.enabled/ },
  { key: "provider", good: "local", next: "grok", bad: "skynet", label: /fix_agent\.provider/, env: { name: "ASHLAR_FIX_PROVIDER", raw: "grok", seeded: "grok" } },
  { key: "delivery", base: { provider: "chatgpt" }, good: "chat-push", next: "script-apply", bad: "teleport", label: /fix_agent\.delivery/, env: { name: "ASHLAR_FIX_DELIVERY", raw: "chat-push", seeded: "chat-push" } },
  { key: "mode", good: "apply", next: "suggest", bad: "yolo", label: /fix_agent\.mode/, env: { name: "ASHLAR_FIX_MODE", raw: "apply", seeded: "apply" } },
  ...(Object.keys(K) as FixAgentKnob[]).map((key): FixRow => ({
    key,
    good: K[key].min,
    next: K[key].max,
    bad: K[key].max + 1,
    label: /must be a whole number/,
    env: { name: K[key].env, raw: String(K[key].max), seeded: K[key].max },
  })),
];

function sandbox(t: { after: (fn: () => void) => void }) {
  const cwd = mkdtempSync(join(tmpdir(), "fix-agent-json-"));
  const prevCwd = process.cwd();
  const prevEnv = { ...process.env };
  const clean = () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("ASHLAR_")) delete process.env[k];
    resetDotenvLoadedForTests();
  };
  process.chdir(cwd);
  clean();
  t.after(() => {
    process.chdir(prevCwd);
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    resetDotenvLoadedForTests();
    rmSync(cwd, { recursive: true, force: true });
  });
  const doc = (fix: Partial<FixAgentSettings>): BotSettings => ({ ...DEFAULT_SETTINGS, fixAgent: { ...DEFAULT_SETTINGS.fixAgent, ...fix } });
  return {
    cwd,
    doc,
    /** A new process: the startup env (no ASHLAR_* in it), .env re-read on load. */
    restart: () => {
      clean();
      return loadBotSettings();
    },
    /** .data unusable (a plain file where the directory should be), .env still writable. */
    breakJson: () => {
      renameSync(join(cwd, ".data"), join(cwd, ".data.bak"));
      writeFileSync(join(cwd, ".data"), "not a directory");
    },
    repairJson: () => {
      rmSync(join(cwd, ".data"), { force: true });
      renameSync(join(cwd, ".data.bak"), join(cwd, ".data"));
    },
    envText: () => (existsSync(join(cwd, ".env")) ? readFileSync(join(cwd, ".env"), "utf8") : ""),
  };
}

const saveError = (fn: () => unknown): SettingsError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SettingsError, `SettingsError, got ${String(e)}`);
    return e;
  }
  assert.fail("the save did not fail");
};

describe("fixAgent: one validator, durable only via the settings JSON (every field)", () => {
  for (const row of FIX_ROWS) {
    const fix = (v: unknown) => ({ ...(row.base ?? {}), [row.key]: v }) as Partial<FixAgentSettings>;

    it(`${row.key}: UI validation — the screen's rule (settings-rules) accepts the good value, rejects the bad one`, () => {
      assert.equal(fixAgentProblem({ ...DEFAULT_SETTINGS.fixAgent, ...fix(row.good) }), null);
      assert.equal(settingsProblem({ ...DEFAULT_SETTINGS, fixAgent: { ...DEFAULT_SETTINGS.fixAgent, ...fix(row.good) } }), null);
      assert.match(fixAgentProblem({ ...DEFAULT_SETTINGS.fixAgent, ...fix(row.bad) }) ?? "", row.label);
    });

    it(`${row.key}: save — the bad value is rejected (400) and nothing is written; the good one is saved as typed`, (t) => {
      const box = sandbox(t);
      const err = saveError(() => saveBotSettings(box.doc(fix(row.bad))));
      assert.equal(err.status, 400);
      assert.match(err.message, row.label);
      assert.equal(existsSync(join(box.cwd, ".data")), false, "no JSON written");
      assert.equal(box.envText(), "", "no .env written");
      assert.deepEqual(saveBotSettings(box.doc(fix(row.good))).fixAgent[row.key], row.good);
    });

    it(`${row.key}: env only seeds a never-saved field; a saved value wins`, (t) => {
      const box = sandbox(t);
      if (!row.env) {
        // The switch has no env var at all.
        Object.assign(process.env, { ASHLAR_FIX_AGENT: "1", ASHLAR_FIX_ENABLED: "true", ASHLAR_FIX_PROVIDER: "grok" });
        assert.equal(loadBotSettings().fixAgent.enabled, false);
        return;
      }
      process.env[row.env.name] = row.env.raw;
      assert.deepEqual(loadBotSettings().fixAgent[row.key], row.env.seeded, "seeded");
      saveBotSettings(box.doc(fix(row.good)));
      box.restart();
      process.env[row.env.name] = row.env.raw;
      resetDotenvLoadedForTests();
      assert.deepEqual(loadBotSettings().fixAgent[row.key], row.good, "the saved value wins over the env seed");
    });

    it(`${row.key}: restart — load returns the saved value`, (t) => {
      const box = sandbox(t);
      saveBotSettings(box.doc(fix(row.good)));
      assert.deepEqual(box.restart().fixAgent[row.key], row.good);
    });

    it(`${row.key}: JSON store unusable (.env writable) — the save fails, .env untouched, restart loads the last good save`, (t) => {
      const box = sandbox(t);
      saveBotSettings(box.doc(fix(row.good)));
      const envBefore = box.envText();
      box.breakJson();
      const err = saveError(() => saveBotSettings(box.doc(fix(row.next))));
      assert.equal(err.status, 500);
      assert.match(err.message, /could not save settings/);
      assert.equal(box.envText(), envBefore, "the supplemental .env patch is not written when the JSON is not");
      box.repairJson();
      assert.deepEqual(box.restart().fixAgent[row.key], row.good, "the last successful save");
    });
  }

  it("enabled on a legacy delivery (chat-push, coding-agent) is rejected by the screen rule and the save; the runtime stays off", (t) => {
    const box = sandbox(t);
    const legacy: Partial<FixAgentSettings>[] = [
      { provider: "chatgpt", delivery: "chat-push" },
      { provider: "grok", delivery: "chat-push" },
      { provider: "coding-agent", delivery: "coding-agent" },
    ];
    for (const pair of legacy) {
      const enabled = { ...DEFAULT_SETTINGS.fixAgent, ...pair, enabled: true };
      assert.match(fixAgentProblem(enabled) ?? "", /not wired yet|is not supported as a fix provider yet/, JSON.stringify(pair));
      assert.equal(saveError(() => saveBotSettings(box.doc(enabled))).status, 400);
      assert.equal(fixLoopOn(enabled), false, "the runtime rule fails closed on the same pair");
      // Stored while OFF is fine (the screen keeps showing it); switching it on is not.
      assert.equal(fixAgentProblem({ ...enabled, enabled: false }), null);
    }
    assert.equal(existsSync(join(box.cwd, ".data", "ashlar-settings.json")), false);
  });

  it("grok is not a fix provider: enabling the fix agent with it is refused by the screen rule, the save and the runtime", (t) => {
    const box = sandbox(t);
    const grok = { ...DEFAULT_SETTINGS.fixAgent, provider: "grok" as const, delivery: "script-apply" as const, enabled: true };
    assert.equal(fixAgentProblem(grok), "grok is not supported as a fix provider yet: choose chatgpt, local to enable the review loop");
    const err = saveError(() => saveBotSettings(box.doc(grok)));
    assert.equal(err.status, 400);
    assert.match(err.message, /^grok is not supported as a fix provider yet/);
    assert.equal(fixLoopOn(grok), false, "the runtime rule refuses it too");
    assert.equal(existsSync(join(box.cwd, ".data", "ashlar-settings.json")), false, "nothing written");
    // Grok reviews are unaffected: a grok reviewer with the fix agent on chatgpt saves.
    assert.equal(saveBotSettings({ ...box.doc({ ...grok, provider: "chatgpt" }), reviewGrok: true }).reviewGrok, true);
  });

  it("a saved legacy {provider: grok, enabled: true} loads OFF (the provider stays visible), like any non-runnable pair", (t) => {
    const box = sandbox(t);
    mkdirSync(join(box.cwd, ".data"), { recursive: true });
    writeFileSync(join(box.cwd, ".data", "ashlar-settings.json"), JSON.stringify({ fixAgent: { enabled: true, provider: "grok", delivery: "script-apply", mode: "apply" } }));
    const loaded = box.restart().fixAgent;
    assert.deepEqual([loaded.enabled, loaded.provider, loaded.delivery], [false, "grok", "script-apply"]);
    assert.equal(fixLoopOn(loaded), false);
    assert.equal(sanitizeBotSettings({ fixAgent: { enabled: true, provider: "grok", delivery: "script-apply" } }).fixAgent.enabled, false);
    // an unrelated save of the loaded document is accepted (the loaded switch is off)
    assert.equal(saveBotSettings({ ...box.restart(), maxTurns: 3 }).maxTurns, 3);
  });

  // A real process restart, both directions: before the fix, a failed JSON write with a working
  // .env counted as saved, and the restart restored the stale switch from the JSON.
  for (const [from, to] of [[false, true], [true, false]] as const) {
    it(`real restart: ${from ? "disable" : "enable"} while the JSON store is unusable fails, and the restart keeps enabled=${from}`, (t) => {
      const cwd = mkdtempSync(join(tmpdir(), "fix-agent-restart-"));
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      const module = new URL("./settings.server.ts", import.meta.url).href;
      const env = { PATH: process.env.PATH, HOME: cwd };
      const run = (code: string) =>
        spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import * as settings from ${JSON.stringify(module)};${code}`], { cwd, env, encoding: "utf8" });
      const save = (enabled: boolean) =>
        run(`try{settings.saveBotSettings(settings.sanitizeBotSettings({fixAgent:{enabled:${enabled},provider:"chatgpt"}}));console.log("saved")}catch(e){console.log("failed",e.status)}`);
      assert.equal(save(from).stdout.trim(), "saved");
      renameSync(join(cwd, ".data"), join(cwd, ".data.bak"));
      writeFileSync(join(cwd, ".data"), "not a directory");
      assert.equal(save(to).stdout.trim(), "failed 500", "the save reports failure");
      rmSync(join(cwd, ".data"));
      renameSync(join(cwd, ".data.bak"), join(cwd, ".data"));
      const loaded = run("console.log(JSON.stringify(settings.loadBotSettings().fixAgent))");
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.equal(JSON.parse(loaded.stdout).enabled, from, "load after restart = the last successful save");
    });
  }
});
