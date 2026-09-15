import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAshlar } from "@/lib/store";
import { DEFAULT_REVIEW_ORDER, PROVIDER_LABEL, normalizeReviewOrder } from "@/lib/types";
import type { GithubReady, ReviewProvider, Severity } from "@/lib/types";

export const Route = createFileRoute("/settings")({ component: Settings });

function Settings() {
  const settings = useAshlar((s) => s.settings);
  const setSettings = useAshlar((s) => s.setSettings);
  const resetDemo = useAshlar((s) => s.resetDemo);
  const github = useAshlar((s) => s.github);
  const enabledCount =
    Number(settings.reviewChatgpt) + Number(settings.reviewGrok) + Number(settings.reviewLocal);
  const order = normalizeReviewOrder(settings.reviewOrder);

  function toggle(key: "reviewChatgpt" | "reviewGrok" | "reviewLocal", on: boolean) {
    if (!on && enabledCount <= 1) return;
    setSettings({ [key]: on });
  }

  function moveOrder(index: number, dir: -1 | 1) {
    const next = [...order];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setSettings({ reviewOrder: next });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Settings</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Bot constitution</h1>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        YAML in the design, knobs here. This instance is the local bridge: GitHub talks to it, the Chrome
        extension talks to ChatGPT or Grok already signed in on this machine. Local LLM uses the OpenAI SDK
        against your endpoint.
      </p>

      <form className="mt-8 space-y-5" onSubmit={(e) => e.preventDefault()}>
        <Field label="bot.username">
          <input
            value={settings.username}
            onChange={(e) => setSettings({ username: e.target.value })}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="mentions">
          <input
            value={settings.mention.join(", ")}
            onChange={(e) =>
              setSettings({
                mention: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle label="skip_forks" checked={settings.skipForks} onChange={(v) => setSettings({ skipForks: v })} />
          <Toggle label="skip_drafts" checked={settings.skipDrafts} onChange={(v) => setSettings({ skipDrafts: v })} />
          <Toggle
            label="precision_over_recall"
            checked={settings.precisionOverRecall}
            onChange={(v) => setSettings({ precisionOverRecall: v })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Toggle label="review_chatgpt" checked={settings.reviewChatgpt} onChange={(v) => toggle("reviewChatgpt", v)} />
          <Toggle label="review_grok" checked={settings.reviewGrok} onChange={(v) => toggle("reviewGrok", v)} />
          <Toggle label="review_local" checked={settings.reviewLocal} onChange={(v) => toggle("reviewLocal", v)} />
        </div>
        <p className="-mt-2 text-[12px] text-fg-subtle">
          Up to three reviewers run the same snapshot in parallel. False-positive checks then run in the order
          below (default Local LLM → ChatGPT → Grok), not all-to-all.
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
              value={settings.localLlmBaseUrl}
              onChange={(e) => setSettings({ localLlmBaseUrl: e.target.value })}
              placeholder="http://127.0.0.1:11434/v1"
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
          <Field label="local_llm.model">
            <input
              value={settings.localLlmModel}
              onChange={(e) => setSettings({ localLlmModel: e.target.value })}
              placeholder="llama3.1"
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
        </div>
        <Field label="local_llm.api_key">
          <input
            type="password"
            autoComplete="off"
            value={settings.localLlmApiKey}
            onChange={(e) => setSettings({ localLlmApiKey: e.target.value })}
            placeholder="saved on the server — leave blank to keep"
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            OpenAI-compatible secret. Ollama and most local servers accept any string. Blank keeps the stored key.
          </p>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="publish_min_severity">
            <select
              value={settings.publishMinSeverity}
              onChange={(e) => setSettings({ publishMinSeverity: e.target.value as Severity })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            >
              <option>P0</option>
              <option>P1</option>
              <option>P2</option>
            </select>
          </Field>
          <Field label="request_changes_min">
            <select
              value={settings.requestChangesMin}
              onChange={(e) => setSettings({ requestChangesMin: e.target.value as Severity })}
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
              value={settings.maxInlineComments}
              onChange={(e) => setSettings({ maxInlineComments: Number(e.target.value) })}
              className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none"
            />
          </Field>
        </div>
        <Field label="github.webhook_secret (demo ping signer)">
          <input
            type="password"
            autoComplete="off"
            value={settings.webhookSecret}
            onChange={(e) => setSettings({ webhookSecret: e.target.value })}
            className="h-11 w-full rounded-md border border-line bg-bg-elevated px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <p className="mt-2 text-[12px] text-fg-subtle">
            Signs Inbox ping only. Live GitHub HMAC uses the GitHub App webhook secret above.
          </p>
        </Field>
      </form>

      <BridgePanel />
      <GitHubApp github={github} />

      <pre className="mt-8 overflow-x-auto rounded-xl border border-line bg-bg-elevated p-4 font-mono text-[12px] leading-6 text-fg-muted">{`bot:
  username: ${settings.username}
  mention: [${settings.mention.map((m) => `"${m}"`).join(", ")}]
limits:
  max_inline_comments: ${settings.maxInlineComments}
policy:
  precision_over_recall: ${settings.precisionOverRecall}
  publish_min_severity: ${settings.publishMinSeverity}
  request_changes_min: ${settings.requestChangesMin}
github:
  skip_forks: ${settings.skipForks}
  skip_drafts: ${settings.skipDrafts}
review:
  chatgpt: ${settings.reviewChatgpt}
  grok: ${settings.reviewGrok}
  local: ${settings.reviewLocal}
  order: [${order.join(", ")}]
local_llm:
  base_url: ${settings.localLlmBaseUrl || "—"}
  model: ${settings.localLlmModel || "—"}`}</pre>

      <Button
        variant="secondary"
        className="mt-6"
        onClick={() => {
          resetDemo();
          setSettings({ reviewOrder: DEFAULT_REVIEW_ORDER });
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
        paste.
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
  const [webhookSecret, setWebhookSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (github.appIdValue && !appId) setAppId(github.appIdValue);
  }, [github.appIdValue, appId]);

  const rows = [
    ["App ID", github.appId, github.from?.appId],
    ["Webhook secret", github.webhookSecret, github.from?.webhookSecret],
    ["Private key", github.privateKey, github.from?.privateKey],
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
          githubWebhookSecret: webhookSecret,
          githubPrivateKey: privateKey,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; github?: GithubReady };
      if (!json.ok) {
        setError(json.error ?? "could not save");
        return;
      }
      setWebhookSecret("");
      setPrivateKey("");
      setSaved(true);
      const snap = await fetch("/api/harbor");
      if (snap.ok) mergeRemote(await snap.json());
    } catch {
      setError("could not save");
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
      setWebhookSecret("");
      setPrivateKey("");
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
        Stored on this machine only, mode 0600, never sent back to the browser after save. Environment variables
        still work as fallback if a field is empty. Webhook URL is{" "}
        <span className="font-mono">{origin}/api/webhook</span>.
      </p>
      <ul className="mt-3 space-y-2 font-mono text-[12px]">
        {rows.map(([name, on, from]) => (
          <li key={name} className="flex items-center justify-between gap-3">
            <span className="text-fg-muted">{name}</span>
            <span className={on ? "text-ok" : "text-fg-subtle"}>
              {on ? `set${from && from !== "missing" ? ` (${from})` : ""}` : "missing"}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-4">
        <Field label="github.app_id">
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            autoComplete="off"
            placeholder="123456"
            className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="github.webhook_secret">
          <input
            type="password"
            autoComplete="new-password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder="leave blank to keep the stored secret"
            className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
        <Field label="github.app_private_key">
          <textarea
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="-----BEGIN PRIVATE KEY-----&#10;leave blank to keep the stored key"
            className="h-36 w-full rounded-md border border-line bg-bg px-3 py-3 font-mono text-[12px] outline-none focus:ring-2 focus:ring-accent/40"
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save GitHub credentials"}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={clearStored}>
          Clear stored
        </Button>
      </div>
      {saved ? <p className="mt-3 text-[12px] text-ok">Saved on the server. Secret fields were cleared from this page.</p> : null}
      {error ? <p className="mt-3 text-[12px] text-danger">{error}</p> : null}
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
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="flex h-11 items-center justify-between rounded-md border border-line bg-bg-elevated px-3 text-left text-sm"
    >
      <span className="font-mono text-[12px]">{label}</span>
      <span className={checked ? "text-ok" : "text-fg-subtle"}>{checked ? "true" : "false"}</span>
    </button>
  );
}
