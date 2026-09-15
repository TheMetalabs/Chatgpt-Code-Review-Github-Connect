import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FindingCard } from "@/components/finding-card";
import { chatStartUrl } from "@/lib/chat-prompt";
import { SAMPLE_PRS } from "@/lib/samples";
import type { Finding } from "@/lib/types";

export const Route = createFileRoute("/playground")({ component: Playground });

const DEFAULT_DIFF = SAMPLE_PRS["pay-412"].diff;

function Playground() {
  const [diff, setDiff] = useState(DEFAULT_DIFF);
  const [extra, setExtra] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    findings: Finding[];
    mergeRecommendation: string;
    highestRisk: string;
    dropped: string[];
  } | null>(null);

  async function openLocal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "local", extra }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; raw?: string };
      if (!json.ok || !json.raw) setError(json.error ?? "local LLM failed");
      else setRaw(json.raw);
    } catch {
      setError("local LLM failed");
    } finally {
      setBusy(false);
    }
  }

  async function openChat(provider: "chatgpt" | "grok") {
    const sample = { ...SAMPLE_PRS["pay-412"], diff, body: extra };
    const { buildChatPrompt } = await import("@/lib/chat-prompt");
    const prompt = buildChatPrompt({ sample, extra });
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      /* ignore */
    }
    window.open(chatStartUrl(provider, prompt), "_blank", "noopener,noreferrer");
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", raw }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        result?: { findings: Finding[]; mergeRecommendation: string; highestRisk: string; dropped: string[] };
      };
      if (!json.ok || !json.result) setError(json.error ?? "poster refused");
      else setResult(json.result);
    } catch {
      setError("preview failed");
    } finally {
      setBusy(false);
    }
  }

  const findings: Finding[] = result?.findings ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Playground</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Chat review loop</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
        Runs against the pinned #412 snapshot in ChatGPT or Grok chat — the tab you are already signed into. No Codex,
        no Grok Build API. Poster still drops hedges, phantom lines, and APPROVE-with-findings.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Diff (untrusted)</label>
          <textarea
            value={diff}
            onChange={(e) => setDiff(e.target.value)}
            className="mt-2 h-48 w-full rounded-lg border border-line bg-bg-elevated px-3 py-3 font-mono text-[12px] leading-5 outline-none focus:ring-2 focus:ring-accent/40 md:h-72"
          />
          <label className="mt-4 block font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            Untrusted user line
          </label>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="optional — treated as untrusted"
            className="mt-2 h-11 w-full rounded-md border border-line bg-bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => openChat("chatgpt")}>Ask ChatGPT</Button>
            <Button variant="secondary" onClick={() => openChat("grok")}>
              Ask Grok
            </Button>
            <Button variant="secondary" disabled={busy} onClick={openLocal}>
              {busy ? "Local LLM…" : "Ask local LLM"}
            </Button>
          </div>
          <label className="mt-6 block font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            Paste JSON reply
          </label>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className="mt-2 h-36 w-full rounded-lg border border-line bg-bg-elevated px-3 py-3 font-mono text-[12px] outline-none focus:ring-2 focus:ring-accent/40"
          />
          <Button className="mt-4" disabled={busy || !raw.trim()} onClick={run}>
            {busy ? "Checking poster…" : "Run poster"}
          </Button>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        </div>
        <div>
          {result ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-line bg-bg-elevated p-4 text-sm">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">poster gate</div>
                <p className="mt-1">{result.mergeRecommendation}</p>
                {result.highestRisk ? <p className="mt-1 text-fg-muted">{result.highestRisk}</p> : null}
                {result.dropped.length ? (
                  <p className="mt-2 text-[12px] text-warn">{result.dropped.length} candidate(s) dropped by policy</p>
                ) : null}
              </div>
              {findings.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">Ask ChatGPT or Grok, then paste JSON to see the poster gate.</p>
          )}
        </div>
      </div>
    </div>
  );
}
