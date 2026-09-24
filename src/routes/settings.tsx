import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAshlar } from "@/lib/store";
import {
  DEFAULT_SETTINGS,
  FIX_AGENT_KNOBS,
  FIX_MODES,
  PROVIDER_LABEL,
  SECRET_MASK,
  SECRET_MASK_PEM,
  isMaskedSecret,
  normalizeReviewOrder,
  providersFromSettings,
} from "@/lib/types";
import {
  FIX_KNOB_FIELDS,
  WIRED_FIX_DELIVERIES,
  WIRED_FIX_PROVIDERS,
  fixAgentProblem,
  fixLoopOn,
  fromFormUnit,
  settingsProblem,
  toFormUnit,
} from "@/lib/settings-rules";
import type {
  BotSettings,
  FixAgentKnob,
  FixAgentProvider,
  FixAgentSettings,
  FixDelivery,
  FixMode,
  GithubReady,
  ReviewProvider,
  Severity,
} from "@/lib/types";
import {
  CHATGPT_REASONING,
  CHATGPT_REASONING_LABEL,
  GROK_REASONING,
  GROK_REASONING_LABEL,
  type ChatgptReasoning,
  type GrokReasoning,
} from "@/lib/reasoning";

export const Route = createFileRoute("/settings")({ component: Settings });

function hydrateDraft(saved: BotSettings): BotSettings {
  return {
    ...saved,
    fixAgent: { ...DEFAULT_SETTINGS.fixAgent, ...saved.fixAgent },
    localJsonRepairEnabled: saved.localJsonRepairEnabled ?? true,
    localLlmApiKey: saved.localLlmApiKeySet ? SECRET_MASK : "",
    webhookSecret: saved.webhookSecretSet ? SECRET_MASK : saved.webhookSecret,
  };
}

/** Hints for the numeric fix-agent fields; labels, units and bounds come from settings-rules. */
const FIX_KNOB_HINT: Record<FixAgentKnob, string> = {
  parallelPrs: "PRs fixed at once (shares the chat bridge with reviews)",
  roundCap: "review→fix rounds before a human decides",
  attempts: "tries per round for an unusable reply",
  timeoutMs: "Local LLM generation deadline, from first output",
  queueMaxMs: "Local LLM: give up on a fix still queued this long",
  chatTimeoutMs: "ChatGPT/Grok fix deadline, queue + generation",
  chatMaxPromptChars: "bigger ChatGPT/Grok fix prompts fail at once (use Local)",
};

const FIX_PROVIDER_LABEL: Record<FixAgentProvider, string> = {
  chatgpt: "ChatGPT (Chrome bridge)",
  grok: "Grok (Chrome bridge)",
  local: "Local LLM",
  "coding-agent": "coding-agent (not wired)",
};


function replaceMasked(current: string, next: string): string {
  if (!isMaskedSecret(current)) return next;
  if (next.startsWith(current)) return next.slice(current.length);
  return next.replace(/•/g, "");
}

export function Settings() {
  const saved = useAshlar((s) => s.settings);
  const setSettings = useAshlar((s) => s.setSettings);
  const resetDemo = useAshlar((s) => s.resetDemo);
  const github = useAshlar((s) => s.github);
  const [draft, setDraft] = useState(() => hydrateDraft(saved));
  const [mentionText, setMentionText] = useState(saved.mention.join(", "));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const order = normalizeReviewOrder(draft.reviewOrder);
  const savedFixKey = JSON.stringify(saved.fixAgent);

  const secretDirty =
    (!isMaskedSecret(draft.localLlmApiKey) && Boolean(draft.localLlmApiKey.trim())) ||
    (!isMaskedSecret(draft.webhookSecret) && Boolean(draft.webhookSecret.trim()));

  const dirty =
    touched &&
    (JSON.stringify({ ...saved, localLlmApiKey: "", webhookSecret: "", localLlmApiKeySet: false, webhookSecretSet: false }) !==
      JSON.stringify({ ...draft, localLlmApiKey: "", webhookSecret: "", localLlmApiKeySet: false, webhookSecretSet: false }) ||
      mentionText !== saved.mention.join(", ") ||
      secretDirty);

  useEffect(() => {
    if (touched) return;
    setDraft(hydrateDraft(saved));
    setMentionText(saved.mention.join(", "));
  }, [
    touched,
    saved.username,
    saved.mention.join(","),
    saved.skipForks,
    saved.skipDrafts,
    saved.precisionOverRecall,
    saved.maxInlineComments,
    saved.publishMinSeverity,
    saved.requestChangesMin,
    saved.reviewChatgpt,
    saved.reviewGrok,
    saved.reviewLocal,
    saved.localJsonRepairEnabled,
    saved.localLlmBaseUrl,
    saved.localLlmModel,
    saved.localLlmApiKeySet,
    saved.webhookSecretSet,
    saved.reviewOrder.join(","),
    saved.chatgptReasoning,
    saved.grokReasoning,
    savedFixKey,
  ]);

  function patch(p: Partial<typeof draft>) {
    setNotice(null);
    setTouched(true);
    setDraft((d) => ({ ...d, ...p }));
  }

  function patchFix(p: Partial<FixAgentSettings>) {
    setNotice(null);
    setTouched(true);
    setDraft((d) => ({ ...d, fixAgent: { ...d.fixAgent, ...p } }));
  }

  function toggle(key: "reviewChatgpt" | "reviewGrok" | "reviewLocal", on: boolean) {
    const next = { ...draft, [key]: on };
    if (!on && providersFromSettings(next).length === 0) return;
    patch({ [key]: on });
  }

  function moveOrder(index: number, dir: -1 | 1) {
    const next = [...order];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    patch({ reviewOrder: next });
  }

  async function save(e?: { preventDefault?: () => void }) {
    e?.preventDefault?.();
    const mention = mentionText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!mention.length) {
      setNotice("mentions cannot be empty");
      return;
    }
    // The server's own rules (settings-rules): what the page accepts, the server accepts.
    const problem = settingsProblem(draft);
    if (problem) {
      setNotice(problem);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await setSettings({
        ...draft,
        mention,
        reviewOrder: order,
        localLlmApiKey: isMaskedSecret(draft.localLlmApiKey) ? "" : draft.localLlmApiKey,
        webhookSecret: isMaskedSecret(draft.webhookSecret) ? "" : draft.webhookSecret,
      });
      setTouched(false);
      setMentionText(mention.join(", "));
      setNotice("Saved");
    } catch (e) {
      setNotice(e instanceof Error && e.message ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setTouched(false);
    setDraft(hydrateDraft(saved));
    setMentionText(saved.mention.join(", "));
    setNotice(null);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Settings</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Bot constitution</h1>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        YAML in the design, knobs here. This instance is the local bridge: GitHub talks to it, the Chrome
        extension talks to ChatGPT or Grok already signed in on this machine. Local LLM uses the OpenAI SDK
        against your endpoint. Changes apply when you save.
      </p>

      <form className="mt-8 space-y-5" onSubmit={save}>
        <Field label="bot.username">
          <input
            value={draft.username}
            onChange={(e) => patch({ username: e.target.value })}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="mentions">
          <input
            value={mentionText}
            onChange={(e) => {
              setNotice(null);
              setTouched(true);
              setMentionText(e.target.value);
            }}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle label="skip_forks" checked={draft.skipForks} onChange={(v) => patch({ skipForks: v })} />
          <Toggle label="skip_drafts" checked={draft.skipDrafts} onChange={(v) => patch({ skipDrafts: v })} />
          <Toggle
            label="precision_over_recall"
            checked={draft.precisionOverRecall}
            onChange={(v) => patch({ precisionOverRecall: v })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Toggle label="review_chatgpt" checked={draft.reviewChatgpt} onChange={(v) => toggle("reviewChatgpt", v)} />
          <Toggle label="review_grok" checked={draft.reviewGrok} onChange={(v) => toggle("reviewGrok", v)} />
          <Toggle label="review_local" checked={draft.reviewLocal} onChange={(v) => toggle("reviewLocal", v)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="chatgpt_reasoning">
            <select
              value={draft.chatgptReasoning}
              onChange={(e) => patch({ chatgptReasoning: e.target.value as ChatgptReasoning })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            >
              {CHATGPT_REASONING.map((k) => (
                <option key={k} value={k}>
                  {CHATGPT_REASONING_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="grok_reasoning">
            <select
              value={draft.grokReasoning}
              onChange={(e) => patch({ grokReasoning: e.target.value as GrokReasoning })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            >
              {GROK_REASONING.map((k) => (
                <option key={k} value={k}>
                  {GROK_REASONING_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="-mt-2 text-[12px] text-fg-subtle">
          Temporary ChatGPT opens Instant; Grok often sits on Fast (빠른). Default is the highest available: 6 Pro and
          Heavy. The bridge clicks those composer pills before sending the review prompt.
        </p>
        <p className="-mt-2 text-[12px] text-fg-subtle">
          Up to three reviewers run the same snapshot in parallel. False-positive checks then run in the order
          below (default Local LLM → ChatGPT → Grok), not all-to-all. Save settings writes gitignored
          <code>.env</code> on this machine so a PM2 restart keeps Local LLM and reviewer toggles.
        </p>
        <Field label="false_positive_check_order">
          <ol className="mt-2 space-y-2">
            {order.map((p, i) => (
              <li
                key={p}
                className="flex h-11 items-center justify-between rounded-md border border-line bg-bg-elevated px-3"
              >
                <span className="font-mono text-[12px]">
                  {i + 1}. {PROVIDER_LABEL[p]}
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-0.5 text-[11px] disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => moveOrder(i, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-0.5 text-[11px] disabled:opacity-30"
                    disabled={i === order.length - 1}
                    onClick={() => moveOrder(i, 1)}
                  >
                    Down
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="local_llm.base_url">
            <input
              value={draft.localLlmBaseUrl}
              onChange={(e) => patch({ localLlmBaseUrl: e.target.value })}
              placeholder="http://127.0.0.1:11434/v1"
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
          <Field label="local_llm.model">
            <input
              value={draft.localLlmModel}
              onChange={(e) => patch({ localLlmModel: e.target.value })}
              placeholder="llama3.1"
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
        </div>
        <Field label="Local JSON repair fallback">
          <Toggle label="파싱 실패 시 Local LLM으로 JSON 복구 (기본 켜짐)" checked={draft.localJsonRepairEnabled}
            onChange={(value) => patch({localJsonRepairEnabled: value})} />
          <p className="mt-2 text-[12px] text-fg-subtle">
            Uses the configured Local endpoint/model only after a completed response fails JSON/schema validation.
            Works even when review_local is OFF and never enables Local code review.
            Only this fallback switch controls format repair. Turning it OFF and saving stops new repairs and prevents applying
            in-flight candidates; normal reviews and original responses are preserved.
          </p>
        </Field>
        <Field label="local_llm.api_key">
          <input
            type="password"
            autoComplete="off"
            value={draft.localLlmApiKey}
            onFocus={() => {
              if (isMaskedSecret(draft.localLlmApiKey)) patch({ localLlmApiKey: "" });
            }}
            onChange={(e) => patch({ localLlmApiKey: replaceMasked(draft.localLlmApiKey, e.target.value) })}
            placeholder={draft.localLlmApiKeySet ? SECRET_MASK : "not set"}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            OpenAI-compatible secret. Masked if already saved. Type a new value to replace. Blank keeps the stored key.
          </p>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="publish_min_severity">
            <select
              value={draft.publishMinSeverity}
              onChange={(e) => patch({ publishMinSeverity: e.target.value as Severity })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            >
              <option>P0</option>
              <option>P1</option>
              <option>P2</option>
            </select>
          </Field>
          <Field label="request_changes_min">
            <select
              value={draft.requestChangesMin}
              onChange={(e) => patch({ requestChangesMin: e.target.value as Severity })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            >
              <option>P0</option>
              <option>P1</option>
              <option>P2</option>
            </select>
          </Field>
          <Field label="max_inline_comments">
            <input
              type="number"
              min={0}
              max={20}
              value={draft.maxInlineComments}
              onChange={(e) => patch({ maxInlineComments: Number(e.target.value) })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            />
          </Field>
        </div>
        <Field label="github.webhook_secret (demo ping signer)">
          <input
            type="password"
            autoComplete="off"
            value={draft.webhookSecret}
            onFocus={() => {
              if (isMaskedSecret(draft.webhookSecret)) patch({ webhookSecret: "" });
            }}
            onChange={(e) => patch({ webhookSecret: replaceMasked(draft.webhookSecret, e.target.value) })}
            placeholder={saved.webhookSecretSet ? SECRET_MASK : "not set"}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            Signs Inbox ping only. Live GitHub HMAC uses the GitHub App webhook secret below. Masked if already saved.
          </p>
        </Field>
        <FixAgentSection fix={draft.fixAgent} onChange={patchFix} />
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-bg/95 p-3 backdrop-blur">
          <Button type="submit" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy || !dirty} onClick={discard}>
            Discard
          </Button>
          {notice ? (
            <span className={notice === "Saved" ? "text-[12px] text-ok" : "text-[12px] text-danger"}>{notice}</span>
          ) : dirty ? (
            <span className="text-[12px] text-fg-subtle">Unsaved changes</span>
          ) : null}
        </div>
      </form>

      <BridgePanel />
      <GitHubApp github={github} />

      <pre className="mt-8 overflow-x-auto rounded-xl border border-line bg-bg-elevated p-4 font-mono text-[12px] leading-6 text-fg-muted">{`bot:
  username: ${draft.username}
  mention: [${mentionText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => `"${m}"`)
    .join(", ")}]
limits:
  max_inline_comments: ${draft.maxInlineComments}
policy:
  precision_over_recall: ${draft.precisionOverRecall}
  publish_min_severity: ${draft.publishMinSeverity}
  request_changes_min: ${draft.requestChangesMin}
github:
  skip_forks: ${draft.skipForks}
  skip_drafts: ${draft.skipDrafts}
review:
  chatgpt: ${draft.reviewChatgpt}
  grok: ${draft.reviewGrok}
  local: ${draft.reviewLocal}
  chatgpt_reasoning: ${draft.chatgptReasoning}
  grok_reasoning: ${draft.grokReasoning}
  order: [${order.join(", ")}]
local_llm:
  base_url: ${draft.localLlmBaseUrl || "—"}
  model: ${draft.localLlmModel || "—"}
  json_repair_enabled: ${draft.localJsonRepairEnabled}
fix_agent:  # review loop (experimental)
  enabled: ${draft.fixAgent.enabled}
  provider: ${draft.fixAgent.provider ?? "—"}
  mode: ${draft.fixAgent.mode}
  delivery: ${draft.fixAgent.delivery}
  parallel_prs: ${draft.fixAgent.parallelPrs}
  round_cap: ${draft.fixAgent.roundCap}`}</pre>

      <Button
        variant="secondary"
        className="mt-6"
        onClick={() => {
          resetDemo();
          setNotice(null);
        }}
      >
        Reset demo tape
      </Button>
    </div>
  );
}

function BridgePanel() {
  const bridge = useAshlar((s) => s.bridge);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const [token, setToken] = useState("");

  useEffect(() => {
    void fetch("/api/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reveal" }),
    })
      .then((r) => r.json())
      .then((j: { token?: string }) => {
        if (!j.token) return;
        setToken(j.token);
        localStorage.setItem("ashlar-bridge-token", j.token);
      })
      .catch(() => {
        /* reveal is same-origin only */
      });
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }

  async function rotate() {
    const res = await fetch("/api/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rotate", token }),
    });
    const json = (await res.json()) as { token?: string };
    if (json.token) {
      setToken(json.token);
      localStorage.setItem("ashlar-bridge-token", json.token);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-line bg-bg-elevated p-4">
      <h2 className="text-sm font-medium">Local chat bridge</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
        Download the unpacked Chrome extension, load it in the same profile where ChatGPT or Grok is signed in, then
        paste origin + token into the extension popup. After that, a PR webhook runs the review without Send or
        paste. The token is stored in <code>.env</code> (<code>ASHLAR_BRIDGE_TOKEN</code>) so a PM2 restart keeps
        it. Rotate only when you want to mint a new one — then paste it into the popup again.
      </p>
      <dl className="mt-3 space-y-2 font-mono text-[12px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-fg-muted">status</span>
          <span className={bridge.connected ? "text-ok" : "text-fg-subtle"}>
            {bridge.connected ? "connected" : "waiting for extension"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-fg-muted">origin</span>
          <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => copy(origin)}>
            {origin || "—"}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-fg-muted">token</span>
          <button
            type="button"
            className="max-w-[60%] truncate text-fg underline-offset-2 hover:underline"
            onClick={() => copy(token)}
          >
            {token || "…"}
          </button>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href="/api/bridge-pack">Download extension</a>
        </Button>
        <Button size="sm" variant="secondary" onClick={rotate}>
          Rotate token
        </Button>
      </div>
      {bridge.lastError ? <p className="mt-3 text-[12px] text-warn">{bridge.lastError}</p> : null}
    </section>
  );
}

function GitHubApp({ github }: { github: GithubReady }) {
  const mergeRemote = useAshlar((s) => s.mergeRemote);
  const [appId, setAppId] = useState(github.appIdValue ?? "");
  const [clientId, setClientId] = useState(github.clientIdValue ?? "");
  const [webhookSecret, setWebhookSecret] = useState(github.webhookSecret ? SECRET_MASK : "");
  const [privateKey, setPrivateKey] = useState(github.privateKey ? SECRET_MASK_PEM : "");
  const [appIdDirty, setAppIdDirty] = useState(false);
  const [clientIdDirty, setClientIdDirty] = useState(false);
  const [secretDirty, setSecretDirty] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);

  useEffect(() => {
    if (!appIdDirty) setAppId(github.appIdValue ?? "");
  }, [github.appIdValue, appIdDirty]);
  useEffect(() => {
    if (!clientIdDirty) setClientId(github.clientIdValue ?? "");
  }, [github.clientIdValue, clientIdDirty]);
  useEffect(() => {
    if (!secretDirty) setWebhookSecret(github.webhookSecret ? SECRET_MASK : "");
  }, [github.webhookSecret, secretDirty]);
  useEffect(() => {
    if (!keyDirty) setPrivateKey(github.privateKey ? SECRET_MASK_PEM : "");
  }, [github.privateKey, keyDirty]);

  const rows = [
    ["App ID", github.appId, github.from?.appId, github.appIdValue || ""],
    ["Client ID", Boolean(github.clientId), github.from?.clientId, github.clientIdValue || ""],
    ["JWT iss", Boolean(github.jwtIssuer && github.jwtIssuer !== "missing"), github.jwtIssuer, github.jwtIssuer === "client_id" ? "client_id (preferred)" : github.jwtIssuer === "app_id" ? "app_id" : ""],
    ["Webhook secret", github.webhookSecret, github.from?.webhookSecret, github.webhookSecret ? SECRET_MASK : ""],
    ["Private key", github.privateKey, github.from?.privateKey, github.privateKey ? SECRET_MASK : ""],
  ] as const;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "github",
          githubAppId: appId,
          githubClientId: clientId,
          githubWebhookSecret: isMaskedSecret(webhookSecret) ? "" : webhookSecret,
          githubPrivateKey: isMaskedSecret(privateKey) ? "" : privateKey,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; github?: GithubReady };
      if (!json.ok) {
        setError(json.error ?? "could not save");
        return;
      }
      setAppIdDirty(false);
      setClientIdDirty(false);
      setSecretDirty(false);
      setKeyDirty(false);
      setWebhookSecret(SECRET_MASK);
      setPrivateKey(SECRET_MASK_PEM);
      setSaved(true);
      const snap = await fetch("/api/harbor");
      if (snap.ok) mergeRemote(await snap.json());
    } catch {
      setError("could not save");
    } finally {
      setBusy(false);
    }
  }

  async function testGithub() {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "github-test" }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        probe?: { ok?: boolean; jwtIssuer?: string; app?: { slug?: string; name?: string; id?: number }; installation?: { id: number }; error?: string };
      };
      if (!json.ok) {
        setError(json.probe?.error ?? json.error ?? "GitHub API probe failed");
        setProbe(
          json.probe
            ? `iss ${json.probe.jwtIssuer ?? "?"} · ${json.probe.error ?? "failed"}`
            : json.error ?? "failed",
        );
        return;
      }
      const app = json.probe?.app;
      const inst = json.probe?.installation;
      setProbe(
        `ok · ${app?.name ?? app?.slug ?? "app"} · iss ${json.probe?.jwtIssuer ?? "?"}${inst ? ` · installation ${inst.id}` : ""}`,
      );
    } catch {
      setError("GitHub API probe failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearStored() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "github-clear" }),
      });
      if (!res.ok) {
        setError("could not clear");
        return;
      }
      setAppId("");
      setClientId("");
      setWebhookSecret("");
      setPrivateKey("");
      setAppIdDirty(false);
      setClientIdDirty(false);
      setSecretDirty(false);
      setKeyDirty(false);
      const snap = await fetch("/api/harbor");
      if (snap.ok) mergeRemote(await snap.json());
    } catch {
      setError("could not clear");
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <section className="mt-8 rounded-xl border border-line bg-bg-elevated p-4">
      <h2 className="text-sm font-medium">GitHub App</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
        Stored on this machine only, mode 0600. Secrets come back masked, not empty. Environment variables still
        work as fallback if a field is empty. Webhook URL is{" "}
        <span className="font-mono">{origin}/api/webhook</span>.
      </p>
      <ul className="mt-3 space-y-2 font-mono text-[12px]">
        {rows.map(([name, on, from, shown]) => (
          <li key={name} className="flex items-center justify-between gap-3">
            <span className="text-fg-muted">{name}</span>
            <span className={on ? "text-ok" : "text-fg-subtle"}>
              {on ? `${shown}${from && from !== "missing" ? ` · ${from}` : ""}` : "not set"}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-4">
        {github.webhookUrl ? (
          <p className="rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px] text-fg-muted">
            GitHub App Webhook URL (from <code>ASHLAR_PUBLIC_HOST</code>): {github.webhookUrl}
          </p>
        ) : (
          <p className="text-[12px] text-fg-subtle">
            터널 호스트는 <code>.env</code>의 <code>ASHLAR_PUBLIC_HOST</code>에만 둡니다. git에 올리지 마세요.
          </p>
        )}
        <Field label="github.app_id">
          <input
            value={appId}
            onChange={(e) => {
              setAppIdDirty(true);
              setAppId(e.target.value);
            }}
            autoComplete="off"
            placeholder="not set"
            className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="github.client_id">
          <input
            value={clientId}
            onChange={(e) => {
              setClientIdDirty(true);
              setClientId(e.target.value);
            }}
            autoComplete="off"
            placeholder="Iv23…"
            className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            Public. JWT issuer prefers Client ID, then App ID. Not the client secret. Webhooks still use the
            webhook secret, not this.
          </p>
        </Field>
        <Field label="github.webhook_secret">
          <input
            type="password"
            autoComplete="new-password"
            value={webhookSecret}
            onFocus={() => {
              if (isMaskedSecret(webhookSecret)) {
                setSecretDirty(true);
                setWebhookSecret("");
              }
            }}
            onChange={(e) => {
              setSecretDirty(true);
              setWebhookSecret(replaceMasked(webhookSecret, e.target.value));
            }}
            placeholder={github.webhookSecret ? SECRET_MASK : "not set"}
            className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="github.app_private_key">
          <textarea
            value={privateKey}
            onFocus={() => {
              if (isMaskedSecret(privateKey)) {
                setKeyDirty(true);
                setPrivateKey("");
              }
            }}
            onChange={(e) => {
              setKeyDirty(true);
              setPrivateKey(replaceMasked(privateKey, e.target.value));
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={github.privateKey ? SECRET_MASK_PEM : "not set"}
            className="h-36 w-full rounded-md border border-line bg-bg px-3 py-3 font-mono text-[12px] outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save GitHub credentials"}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={testGithub}>
          Test GitHub API
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={clearStored}>
          Clear stored
        </Button>
      </div>
      {saved ? <p className="mt-3 text-[12px] text-ok">Saved. Secrets stay masked on this page.</p> : null}
      {probe ? <p className={`mt-3 text-[12px] ${error ? "text-danger" : "text-ok"}`}>{probe}</p> : null}
      {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}
    </section>
  );
}

function FixAgentSection({ fix, onChange }: { fix: FixAgentSettings; onChange: (p: Partial<FixAgentSettings>) => void }) {
  // Offer what the loop can execute; a stored value outside that set stays visible (not silently
  // rewritten) so the operator sees it and can pick a wired one.
  const providers = WIRED_FIX_PROVIDERS.includes(fix.provider as FixAgentProvider) || fix.provider == null
    ? WIRED_FIX_PROVIDERS
    : [...WIRED_FIX_PROVIDERS, fix.provider];
  const deliveries = WIRED_FIX_DELIVERIES.includes(fix.delivery) ? WIRED_FIX_DELIVERIES : [...WIRED_FIX_DELIVERIES, fix.delivery];
  const active = fixLoopOn(fix);
  const blocked = fix.enabled && !active ? fixAgentProblem(fix) : null;
  return (
    <section aria-label="Fix agent / review loop" className="space-y-4 rounded-xl border border-line bg-bg-elevated p-4">
      <div>
        <h2 className="text-sm font-medium">Fix agent / review loop</h2>
        <p role="note" className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-fg-muted">
          Experimental. When ON, a <code>/review-loop</code> request makes Ashlar fix its own findings and re-review, up to
          the round budget. <code>apply</code> commits and pushes to the PR branch (the starter needs write access);
          <code> suggest</code> only posts the proposed change. Saved changes apply to the next loop step — no restart.
        </p>
      </div>
      <Toggle label="fix_agent.enabled" checked={fix.enabled} onChange={(v) => onChange({ enabled: v })} />
      <p className="-mt-2 text-[12px] text-fg-subtle">
        {active
          ? `Loop ON: ${FIX_PROVIDER_LABEL[fix.provider as FixAgentProvider]} fixes, mode ${fix.mode}.`
          : fix.enabled
            ? `Loop stays OFF: ${blocked ?? "choose a wired provider and delivery"}.`
            : "Loop OFF (default): no loop step and no fix request, ever."}
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="fix_agent.provider">
          <select
            value={fix.provider ?? ""}
            onChange={(e) => onChange({ provider: (e.target.value || null) as FixAgentProvider | null })}
            className="h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none"
          >
            <option value="">none</option>
            {providers.map((p) => (
              <option key={p} value={p} disabled={!WIRED_FIX_PROVIDERS.includes(p)}>
                {FIX_PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="fix_agent.mode">
          <select
            value={fix.mode}
            onChange={(e) => onChange({ mode: e.target.value as FixMode })}
            className="h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none"
          >
            {FIX_MODES.map((m) => (
              <option key={m} value={m}>
                {m === "apply" ? "apply (auto-push)" : "suggest (no push)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="fix_agent.delivery">
          <select
            value={fix.delivery}
            onChange={(e) => onChange({ delivery: e.target.value as FixDelivery })}
            className="h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none"
          >
            {deliveries.map((d) => (
              <option key={d} value={d} disabled={!WIRED_FIX_DELIVERIES.includes(d)}>
                {d}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIX_KNOB_FIELDS.map((f) => {
          const k = FIX_AGENT_KNOBS[f.key];
          return (
            <Field key={f.key} label={f.label}>
              <input
                type="number"
                min={toFormUnit(f.key, k.min)}
                max={toFormUnit(f.key, k.max)}
                step={1}
                value={toFormUnit(f.key, fix[f.key])}
                onChange={(e) => onChange({ [f.key]: fromFormUnit(f.key, e.target.valueAsNumber) })}
                className="h-11 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none"
              />
              <span className="mt-1 block text-[11px] text-fg-subtle">
                {FIX_KNOB_HINT[f.key]} ({toFormUnit(f.key, k.min)}–{toFormUnit(f.key, k.max)}, default {toFormUnit(f.key, k.def)})
              </span>
            </Field>
          );
        })}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="flex h-11 items-center justify-between rounded-md border border-line bg-bg-elevated px-3 text-left text-sm"
    >
      <span className="font-mono text-[12px]">{label}</span>
      <span className={checked ? "text-ok" : "text-fg-subtle"}>{checked ? "true" : "false"}</span>
    </button>
  );
}
