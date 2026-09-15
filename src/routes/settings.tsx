import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAshlar } from "@/lib/store";
import { DEFAULT_SETTINGS, PROVIDER_LABEL, SECRET_MASK, SECRET_MASK_PEM, isMaskedSecret, normalizeReviewOrder } from "@/lib/types";
import type { BotSettings, GithubReady, ReviewProvider, Severity } from "@/lib/types";

export const Route = createFileRoute("/settings")({ component: Settings });

function hydrateDraft(saved: BotSettings): BotSettings {
  return {
    ...saved,
    localLlmApiKey: saved.localLlmApiKeySet ? SECRET_MASK : "",
    webhookSecret: saved.webhookSecretSet ? SECRET_MASK : saved.webhookSecret,
  };
}

function replaceMasked(current: string, next: string): string {
  if (!isMaskedSecret(current)) return next;
  if (next.startsWith(current)) return next.slice(current.length);
  return next.replace(/•/g, "");
}

function Settings() {
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
  const enabledCount =
    Number(draft.reviewChatgpt) + Number(draft.reviewGrok) + Number(draft.reviewLocal);

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
    saved.localLlmBaseUrl,
    saved.localLlmModel,
    saved.localLlmApiKeySet,
    saved.webhookSecretSet,
    saved.reviewOrder.join(","),
  ]);

  function patch(p: Partial<typeof draft>) {
    setNotice(null);
    setTouched(true);
    setDraft((d) => ({ ...d, ...p }));
  }

  function toggle(key: "reviewChatgpt" | "reviewGrok" | "reviewLocal", on: boolean) {
    if (!on && enabledCount <= 1) return;
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
    } catch {
      setNotice("could not save");
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
  order: [${order.join(", ")}]
local_llm:
  base_url: ${draft.localLlmBaseUrl || "—"}
  model: ${draft.localLlmModel || "—"}`}</pre>

      <Button
        variant="secondary"
        className="mt-6"
        onClick={() => {
          resetDemo();
          setTouched(false);
          setDraft(hydrateDraft(DEFAULT_SETTINGS));
          setMentionText(DEFAULT_SETTINGS.mention.join(", "));
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
