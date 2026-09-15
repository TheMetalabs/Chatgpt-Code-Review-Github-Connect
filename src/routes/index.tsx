import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pipeline } from "@/components/pipeline";
import { MergePill, StatusPill } from "@/components/status-pill";
import { useAshlar } from "@/lib/store";
import { formatMs, formatWhen, shortSha } from "@/lib/utils";
import { LIVE_INFLIGHT_STATUSES } from "@/lib/types";
import type { Job, JobStatus, Trigger } from "@/lib/types";

export const Route = createFileRoute("/")({ component: Home });

const TAPES: {
  label: string;
  sampleKey: string;
  trigger: Trigger;
  hmacOk?: boolean;
  forceDlq?: boolean;
  mention?: boolean;
}[] = [
  { label: "Sync #412 (post)", sampleKey: "pay-412", trigger: "pull_request.synchronize" },
  { label: "Open #418 (no publish)", sampleKey: "pay-418", trigger: "pull_request.opened" },
  { label: "@ashlar on #412", sampleKey: "pay-412", trigger: "issue_comment.mention", mention: true },
  { label: "Fork #421", sampleKey: "pay-421", trigger: "pull_request.opened" },
  { label: "Draft #430 (skip)", sampleKey: "pay-430", trigger: "pull_request.opened" },
  { label: "HMAC fail", sampleKey: "pay-418", trigger: "pull_request.opened", hmacOk: false },
  { label: "Worker crash (DLQ)", sampleKey: "pay-418", trigger: "pull_request.reopened", forceDlq: true },
];

function Home() {
  const jobs = useAshlar((s) => s.jobs);
  const events = useAshlar((s) => s.events);
  const reviews = useAshlar((s) => s.reviews);
  const fire = useAshlar((s) => s.fire);
  const settings = useAshlar((s) => s.settings);
  const [lastFire, setLastFire] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);

  const liveJobs = jobs.filter((j) => LIVE_INFLIGHT_STATUSES.includes(j.status));
  const live = liveJobs[0];
  const posted = jobs.filter((j) => j.status === "posted" && j.postedReviewId).length;
  const skipped = jobs.filter((j) => j.status === "skipped").length;
  const rejected = events.filter((e) => e.httpStatus === 403).length;
  const p95 = percentile(
    jobs.map((j) => j.ingressMs).filter(Boolean),
    0.95,
  );

  async function runTape(t: (typeof TAPES)[number]) {
    setFiring(true);
    try {
      const out = await fire({
        sampleKey: t.sampleKey,
        trigger: t.trigger,
        hmacOk: t.hmacOk,
        forceDlq: t.forceDlq,
        thread: t.mention
          ? { kind: "mention", commentId: 88, userText: "@ashlar-bot focus on fulfillOrder replay" }
          : undefined,
      });
      setLastFire(
        out.httpStatus === 403
          ? `403 · ${out.reject ?? "rejected"}`
          : out.skip
            ? `202 skip · ${out.skip}`
            : `202 queued · ${out.jobId}`,
      );
    } finally {
      setFiring(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8 md:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Operations</p>
          <h1 className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">Review harbor</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-fg-muted">
            Codex loop on the worker. Cody-style webhook that closes in milliseconds. Poster is a script — no model on
            the write path. GitHub App deliveries enqueue on the server and land in this table.
          </p>
        </div>
        <Button
          disabled={firing}
          onClick={() => runTape({ label: "", sampleKey: "pay-412", trigger: "pull_request.synchronize" })}
        >
          <Play className="size-4" strokeWidth={1.6} />
          Fire #412 sync
        </Button>
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Ingress p95" value={p95 ? formatMs(p95) : "—"} hint="HMAC + 202" />
        <Stat label="Posted" value={String(posted)} hint="Reviews API only" />
        <Stat label="Skipped" value={String(skipped)} hint="fork / draft / poster" />
        <Stat label="Rejected" value={String(rejected)} hint="HMAC 403" />
        <Stat label="Live" value={String(reviews.filter((r) => !r.dismissed).length)} hint="current reviews" />
      </dl>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-fg-muted">Live pipeline</h2>
        <div className="mt-3" aria-busy={Boolean(live)}>
          <Pipeline status={live?.status as JobStatus | undefined} />
        </div>
        {liveJobs.length > 1 ? (
          <p className="mt-3 font-mono text-[12px] text-fg-muted">{liveJobs.length} live · showing newest</p>
        ) : null}
        {live ? (
          <p className="mt-3 font-mono text-[12px] text-fg-muted">
            {live.owner}/{live.repo}#{live.pr} · {live.status} · {shortSha(live.headSha)}
          </p>
        ) : (
          <p className="mt-3 text-sm text-fg-subtle">Idle. Ingress is still accepting.</p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-fg-muted">Event tapes</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {TAPES.map((t) => (
            <Button
              key={t.label}
              variant="secondary"
              size="sm"
              disabled={firing}
              onClick={() => runTape(t)}
            >
              {t.sampleKey === "pay-421" && !settings.skipForks ? "Fork #421 (injection)" : t.label}
            </Button>
          ))}
        </div>
        {lastFire ? <p className="mt-3 font-mono text-[12px] text-fg-muted">{lastFire}</p> : null}
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Recent ingress</h2>
          <span className="font-mono text-[11px] text-fg-subtle">{events.length} events</span>
        </div>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm" aria-label="Recent webhook events">
            <thead className="bg-bg-elevated font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 6).map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-4 py-3 font-mono text-[12px] tabular-nums text-fg-muted">{formatWhen(e.at)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={e.httpStatus === 202 ? "ok" : "danger"}>{e.httpStatus}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div>{e.summary}</div>
                    {e.skipReason ? <div className="text-[12px] text-fg-subtle">{e.skipReason}</div> : null}
                    {e.rejectReason ? <div className="text-[12px] text-danger">{e.rejectReason}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-fg-muted">Jobs</h2>
          <span className="font-mono text-[11px] tabular-nums text-fg-subtle">{jobs.length} total</span>
        </div>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm" aria-label="Review jobs">
            <thead className="bg-bg-elevated font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">PR</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Trigger</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Ingress</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 12).map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function JobRow({ job: j }: { job: Job }) {
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3">
        <div className="font-medium">
          {j.owner}/{j.repo}#{j.pr}
          {j.origin === "github" ? (
            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">github</span>
          ) : null}
        </div>
        <div className="text-fg-subtle">{j.title}</div>
      </td>
      <td className="hidden px-4 py-3 font-mono text-[12px] text-fg-muted md:table-cell">{j.trigger}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={j.status} />
          <MergePill event={j.mergeRecommendation} />
        </div>
        {j.skipReason ? <div className="mt-1 text-[12px] text-fg-subtle">{j.skipReason}</div> : null}
      </td>
      <td className="hidden px-4 py-3 font-mono text-[12px] tabular-nums text-fg-muted sm:table-cell">
        {formatMs(j.ingressMs)} · {formatWhen(j.createdAt)}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to="/jobs/$id"
          params={{ id: j.id }}
          className="inline-flex size-11 items-center justify-center text-fg-muted hover:text-fg"
        >
          <ArrowUpRight className="size-4" />
          <span className="sr-only">Open job</span>
        </Link>
      </td>
    </tr>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg-elevated px-4 py-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">{label}</dt>
      <dd className="mt-2 font-mono text-2xl tabular-nums tracking-tight">{value}</dd>
      <dd className="mt-1 text-[12px] text-fg-subtle">{hint}</dd>
    </div>
  );
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * (s.length - 1)));
  return s[i];
}
