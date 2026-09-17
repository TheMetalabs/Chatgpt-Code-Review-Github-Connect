import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HistoryBrowser } from "@/components/history-browser";
import { DiffView } from "@/components/diff-view";
import { MergePill } from "@/components/status-pill";
import { CODE_REVIEW_MD, PAYMENT_AGENTS_MD, ROOT_AGENTS_MD } from "@/lib/policy";
import { SAMPLE_PRS } from "@/lib/samples";
import { useAshlar } from "@/lib/store";
import { formatWhen, shortSha } from "@/lib/utils";

export const Route = createFileRoute("/reviews")({ component: Reviews });

function Reviews() {
  const sync = useAshlar(s => s.sync);
  const reviews = useAshlar((s) => s.reviews);
  const jobs = useAshlar((s) => s.jobs);
  const fire = useAshlar((s) => s.fire);
  const [mention, setMention] = useState("@ashlar-bot focus on fulfillOrder replay");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastFire, setLastFire] = useState<string | null>(null);
  const fallback = reviews.find((r) => !r.dismissed) ?? reviews[0];
  const active = reviews.find((r) => r.id === selectedId) ?? fallback;
  const job = jobs.find((j) => j.id === active?.jobId);
  const sample = job?.origin === "tape" && job.sampleKey ? SAMPLE_PRS[job.sampleKey] : undefined;

  const file = useMemo(() => {
    if (!sample) return null;
    const path = active?.comments[0]?.file ?? sample.changedPaths[0];
    const raw = sample.files.find((f) => f.path === path);
    if (!raw) return null;
    let content = raw.content;
    if (raw.path === "AGENTS.md") content = ROOT_AGENTS_MD;
    if (raw.path === "code_review.md") content = CODE_REVIEW_MD;
    if (raw.path === "src/payment/AGENTS.md") content = PAYMENT_AGENTS_MD;
    return { ...raw, content };
  }, [sample, active]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Reviews</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Review History</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
        Recent results from the current runtime appear here. Use the private archive below for reviews from earlier server sessions and their complete job timelines.
      </p>

      {!active ? (
        <p className="mt-10 text-sm text-fg-muted">{sync.status === "loading" ? "Loading reviews…" : sync.status === "error" ? "Current reviews could not be refreshed. Check the connection warning above or open the private archive." : "No reviews in this runtime snapshot. Earlier results may be available in the private archive below."}</p>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-medium">
                {active.owner}/{active.repo}#{active.pr}
              </h2>
              <MergePill event={active.event} />
              {active.dismissed ? <Badge tone="muted">older local record</Badge> : <Badge tone="ok">current</Badge>}
            </div>
            <p className="mt-1 font-mono text-[12px] text-fg-subtle">
              {shortSha(active.headSha)} · {formatWhen(active.at)}
            </p>
            <div className="mt-4 whitespace-pre-wrap rounded-xl border border-line bg-bg-elevated px-4 py-3 text-sm leading-relaxed text-fg-muted">
              {active.body}
            </div>

            {file ? (
              <div className="mt-6">
                <DiffView
                  path={file.path}
                  content={file.content}
                  findings={job?.findings ?? []}
                  caption="Head snapshot. Highlight = accepted finding line — not a unified diff."
                />
              </div>
            ) : null}

            <ol className="mt-6 space-y-3">
              {active.comments.map((c) => (
                <li key={c.id} className="rounded-xl border border-line bg-bg-elevated p-4">
                  <div className="font-mono text-[11px] text-fg-subtle">
                    {c.file}:{c.line} · {c.side}
                  </div>
                  <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{c.body}</div>
                </li>
              ))}
            </ol>
          </div>

          <aside className="space-y-4">
            {!active.dismissed && job?.origin === "tape" ? (
              <div className="rounded-xl border border-line bg-bg-elevated p-4">
                <h3 className="text-sm font-medium">Demo mention — not sent to GitHub</h3>
                <p className="mt-1 text-[12px] text-fg-muted">
                  Comment text must include a mention token from Settings. Prior findings + this one line only.
                </p>
                <textarea
                  value={mention}
                  onChange={(e) => setMention(e.target.value)}
                  className="mt-3 h-24 w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/40"
                />
                <Button
                  className="mt-3 w-full"
                  onClick={async () => {
                    const out = await fire({
                      sampleKey: job?.sampleKey ?? "pay-412",
                      trigger: "issue_comment.mention",
                      thread: { kind: "mention", commentId: 91, userText: mention },
                    });
                    setLastFire(
                      out.httpStatus === 403
                        ? `403 · ${out.reject}`
                        : out.skip
                          ? `202 skip · ${out.skip}`
                          : `202 queued · ${out.jobId}`,
                    );
                  }}
                >
                  @ashlar-bot
                </Button>
                {lastFire ? <p className="mt-2 font-mono text-[11px] text-fg-muted">{lastFire}</p> : null}
              </div>
            ) : (
              <div className="rounded-xl border border-line p-4 text-sm text-fg-muted">
                <a className="text-accent underline" href={`https://github.com/${active.owner}/${active.repo}/pull/${active.pr}`} target="_blank" rel="noreferrer">Open the actual PR to request another review</a>
                <p className="mt-2">A new explicit mention creates a separate job; this screen does not send model requests.</p>
              </div>
            )}
            <div className="rounded-xl border border-line p-4">
              <h3 className="text-sm font-medium">Current runtime</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {reviews.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-fg-muted hover:bg-bg-hover hover:text-fg"
                    >
                      <span>
                        #{r.pr} {shortSha(r.headSha)}
                      </span>
                      {r.dismissed ? <Badge tone="muted">old</Badge> : <Badge tone="ok">live</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      )}
      <div className="mt-12 border-t border-line pt-6"><h2 className="mb-4 text-xl font-semibold">Persisted review archive</h2><HistoryBrowser initialKind="reviews" /></div>
    </div>
  );
}
