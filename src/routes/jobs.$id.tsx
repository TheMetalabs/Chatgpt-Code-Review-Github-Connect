import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/diff-view";
import { FindingCard } from "@/components/finding-card";
import { Pipeline } from "@/components/pipeline";
import { ReviewerLanes } from "@/components/reviewer-lanes";
import { MergePill, StatusPill } from "@/components/status-pill";
import { chatStartUrl } from "@/lib/chat-prompt";
import { CODE_REVIEW_MD, PAYMENT_AGENTS_MD, ROOT_AGENTS_MD } from "@/lib/policy";
import { SAMPLE_PRS } from "@/lib/samples";
import { useAshlar } from "@/lib/store";
import { LIVE_INFLIGHT_STATUSES, BRIDGE_CLAIM_MS, isChatProvider, providersFromSettings } from "@/lib/types";
import { buildReviewerLanes } from "@/lib/reviewer-progress";
import type { ReviewProvider } from "@/lib/types";
import { formatMs, shortSha } from "@/lib/utils";

export const Route = createFileRoute("/jobs/$id")({ component: JobPage });

function JobPage() {
  const { id } = Route.useParams();
  const job = useAshlar((s) => s.jobs.find((j) => j.id === id));
  const review = useAshlar((s) => s.reviews.find((r) => r.jobId === id));
  const settings = useAshlar((s) => s.settings);
  const fire = useAshlar((s) => s.fire);
  const cancel = useAshlar((s) => s.cancel);
  const resetDemo = useAshlar((s) => s.resetDemo);

  if (!job) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16 text-center text-fg-muted">
        <p>This id is not in the current demo tape. Fired jobs live in this tab until Reset.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button asChild variant="secondary">
            <Link to="/">Back to Operations</Link>
          </Button>
          <Button variant="ghost" onClick={resetDemo}>
            Reset demo tape
          </Button>
        </div>
      </div>
    );
  }

  const sample = SAMPLE_PRS[job.sampleKey ?? ""];
  const files = (sample?.files ?? []).map((f) => {
    if (f.path === "AGENTS.md") return { ...f, content: ROOT_AGENTS_MD };
    if (f.path === "code_review.md") return { ...f, content: CODE_REVIEW_MD };
    if (f.path === "src/payment/AGENTS.md") return { ...f, content: PAYMENT_AGENTS_MD };
    return f;
  });
  const primary = files.find((f) => f.path === job.findings[0]?.file) ?? files.find((f) => f.path.endsWith(".ts"));
  const live = LIVE_INFLIGHT_STATUSES.includes(job.status);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Job {job.id}</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-medium tracking-tight">
            {job.owner}/{job.repo}#{job.pr}
          </h1>
          <p className="mt-1 text-sm text-fg-muted">{job.title}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={job.status} />
          <MergePill event={job.mergeRecommendation} />
          {job.origin === "github" ? (
            <span className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-muted">
              github
            </span>
          ) : null}
          {live ? (
            <Button variant="secondary" size="sm" onClick={() => cancel(job.id)}>
              Cancel
            </Button>
          ) : job.sampleKey ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fire({ sampleKey: job.sampleKey!, trigger: job.trigger, thread: job.thread })}
            >
              Replay
            </Button>
          ) : null}
        </div>
      </div>

      {job.status === "cancelled" ? (
        <p className="mt-4 rounded-xl border border-warn/30 bg-bg-elevated px-4 py-3 text-sm text-warn">
          Cancelled — {job.skipReason ?? "newer delivery for the same PR took the worker."}
        </p>
      ) : null}
      {job.status === "dlq" ? (
        <p className="mt-4 rounded-xl border border-danger/30 bg-bg-elevated px-4 py-3 text-sm text-danger">
          Dead letter. {job.skipReason ?? "Validator failed."} Replay to put it back on the worker.
        </p>
      ) : null}
      {job.status === "awaiting_chat" ? (
        <ChatHandoff
          jobId={job.id}
          prompt={job.chatPrompt ?? ""}
          prompts={job.chatPromptByProvider}
          claimed={Boolean(job.bridgeClaimedAt && Date.now() - job.bridgeClaimedAt < BRIDGE_CLAIM_MS)}
          providers={(
            job.fpProviders?.length
              ? job.fpProviders
              : job.reviewProviders?.length
                ? job.reviewProviders
                : providersFromSettings(settings)
          ).filter(isChatProvider)}
          fpRound={Boolean(job.chatFpRound)}
        />
      ) : null}
      {job.status === "skipped" && job.skipReason ? (
        <p className="mt-4 rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm text-fg-muted">
          {job.skipReason}
        </p>
      ) : null}
      {job.postedToGithub ? (
        <p className="mt-4 rounded-xl border border-ok/30 bg-bg-elevated px-4 py-3 text-sm text-fg-muted">
          Posted to GitHub Reviews API{job.githubError ? "" : "."}
        </p>
      ) : null}
      {job.githubError ? (
        <p className="mt-4 rounded-xl border border-warn/30 bg-bg-elevated px-4 py-3 text-sm text-warn">
          GitHub: {job.githubError}
        </p>
      ) : null}

      <dl className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Meta k="head" v={shortSha(job.headSha)} />
        <Meta k="trigger" v={job.trigger} />
        <Meta k="ingress" v={formatMs(job.ingressMs)} />
        <Meta k="sender" v={job.sender} />
      </dl>

      <div className="mt-8">
        <Pipeline status={job.status} />
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-fg-muted">Reviewers</h2>
        <div className="mt-3">
          <ReviewerLanes
            lanes={
              job.reviewerLanes?.length
                ? job.reviewerLanes
                : buildReviewerLanes(job, { enabled: providersFromSettings(settings) })
            }
          />
        </div>
      </section>

      {job.thread ? (
        <div className="mt-6 rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Mention extra</div>
          <p className="mt-1 text-fg">{job.thread.userText}</p>
          <p className="mt-1 text-fg-subtle">Prior findings + this line only. Full chat log is not re-injected.</p>
        </div>
      ) : null}

      {job.plan ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-fg-muted">Explorer plan</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg">{job.plan}</p>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-fg-muted">Tool loop</h2>
        <ol className="mt-3 overflow-hidden rounded-xl border border-line">
          {job.traces.length === 0 ? (
            <li className="px-4 py-6 text-sm text-fg-subtle">
              {live ? "Waiting on the worker." : "No tool calls — ingress skipped the worker."}
            </li>
          ) : (
            job.traces.map((t) => (
              <li key={t.id} className="grid gap-1 border-t border-line px-4 py-3 first:border-t-0 md:grid-cols-[7rem_9rem_1fr_1fr]">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-subtle">{t.pass}</span>
                <span className="font-mono text-[12px] text-accent">{t.tool}</span>
                <span className="font-mono text-[12px] text-fg-muted">{t.args}</span>
                <span className="text-[12px] text-fg-muted">{t.result}</span>
              </li>
            ))
          )}
        </ol>
      </section>

      {job.investigatedSafe.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-fg-muted">Investigated safe</h2>
          <ul className="mt-2 list-disc pl-5 text-sm text-fg-muted">
            {job.investigatedSafe.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-fg-muted">Findings</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {[...job.findings, ...job.candidates.filter((c) => c.status === "dropped")].map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
          {job.findings.length === 0 && job.candidates.length === 0 && (job.status === "posted" || job.status === "skipped") ? (
            <p className="text-sm text-fg-muted">No concrete failure. Poster skipped the review.</p>
          ) : null}
        </div>
      </section>

      {primary ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-fg-muted">Head snapshot · {primary.path}</h2>
          <div className="mt-3">
            <DiffView
              path={primary.path}
              content={primary.content}
              findings={job.findings}
              caption="Head snapshot. Highlight = accepted finding line."
            />
          </div>
        </section>
      ) : null}

      {review ? (
        <p className="mt-8 text-sm text-fg-muted">
          Posted as {review.event}. See the{" "}
          <Link to="/reviews" className="text-fg underline">
            review thread
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">{k}</div>
      <div className="mt-1 font-mono text-[13px]">{v}</div>
    </div>
  );
}

function ChatHandoff({
  jobId,
  prompt,
  prompts,
  claimed,
  providers,
  fpRound,
}: {
  jobId: string;
  prompt: string;
  prompts?: Partial<Record<ReviewProvider, string>>;
  claimed: boolean;
  providers: Array<"chatgpt" | "grok">;
  fpRound: boolean;
}) {
  const mergeRemote = useAshlar((s) => s.mergeRemote);
  const [raws, setRaws] = useState<Record<ReviewProvider, string>>({ chatgpt: "", grok: "", local: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptText, setPromptText] = useState(prompt);
  const [promptBy, setPromptBy] = useState<Partial<Record<ReviewProvider, string>>>(prompts ?? {});
  const dual = providers.length > 1;
  const ready = providers.every((p) => raws[p]?.trim());

  useEffect(() => {
    if (prompt) {
      setPromptText(prompt);
      if (prompts) setPromptBy(prompts);
      return;
    }
    const token = localStorage.getItem("ashlar-bridge-token");
    if (!token) return;
    void fetch(`/api/bridge?jobId=${encodeURIComponent(jobId)}`, {
      headers: { "x-ashlar-bridge-token": token },
    })
      .then((r) => r.json())
      .then((j: { prompt?: string; prompts?: Partial<Record<ReviewProvider, string>> }) => {
        if (j.prompt) setPromptText(j.prompt);
        if (j.prompts) setPromptBy(j.prompts);
      })
      .catch(() => {
        /* prompt fetch is best-effort */
      });
  }, [jobId, prompt, prompts]);

  async function openChat(provider: "chatgpt" | "grok") {
    const text = promptBy[provider] || promptText;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be denied */
    }
    window.open(chatStartUrl(provider, text), "_blank", "noopener,noreferrer");
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const token = localStorage.getItem("ashlar-bridge-token") ?? "";
      const results = providers.map((p) => ({ provider: p, raw: raws[p] }));
      const res = await fetch("/api/harbor", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ashlar-bridge-token": token },
        body: JSON.stringify({ action: "chat", jobId, raw: results[0]?.raw ?? "", results, token }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? "poster refused the paste");
        return;
      }
      const snap = await fetch("/api/harbor");
      if (snap.ok) mergeRemote(await snap.json());
    } catch {
      setError("could not submit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-accent/30 bg-bg-elevated px-4 py-4">
      <h2 className="text-sm font-medium">Review in your chat</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
        {claimed
          ? dual
            ? `The Chrome bridge is running ${providers.join(" and ")} in parallel.`
            : providers[0]
              ? `The Chrome bridge claimed this job and is running ${providers[0]}.`
              : "The Chrome bridge claimed this job."
          : fpRound
            ? "False-positive check in review order. This step is one reviewer, not a full cross-check."
            : dual
              ? "Enabled reviewers run the same snapshot in parallel. One-sided findings are checked in the order from Settings."
              : "If the Ashlar Chrome bridge is loaded, it picks this job up. Manual paste is the fallback."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {providers.map((p) => (
          <Button key={p} size="sm" variant={p === providers[0] ? "primary" : "secondary"} onClick={() => openChat(p)}>
            {p === "grok" ? "Ask Grok" : "Ask ChatGPT"}
          </Button>
        ))}
      </div>
      {providers.map((p) => (
        <textarea
          key={p}
          value={raws[p]}
          onChange={(e) => setRaws((s) => ({ ...s, [p]: e.target.value }))}
          placeholder={
            dual
              ? `${p === "grok" ? "Grok" : "ChatGPT"} JSON`
              : '{"merge_recommendation":"REQUEST_CHANGES","findings":[...]}'
          }
          className="mt-3 h-36 w-full rounded-lg border border-line bg-bg px-3 py-3 font-mono text-[12px] outline-none focus:ring-2 focus:ring-accent/40"
        />
      ))}
      <Button className="mt-3" disabled={busy || claimed || !ready} onClick={submit}>
        {claimed ? "Bridge running" : busy ? "Posting…" : dual ? "Merge and post" : "Run poster"}
      </Button>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
    </section>
  );
}
