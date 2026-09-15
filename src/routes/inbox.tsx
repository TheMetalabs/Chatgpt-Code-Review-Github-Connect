import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAshlar } from "@/lib/store";
import { formatMs, formatWhen } from "@/lib/utils";
import { SAMPLE_PRS } from "@/lib/samples";
import { signHub256 } from "@/lib/hmac";

export const Route = createFileRoute("/inbox")({ component: Inbox });

function Inbox() {
  const events = useAshlar((s) => s.events);
  const settings = useAshlar((s) => s.settings);
  const fire = useAshlar((s) => s.fire);
  const [ping, setPing] = useState<string>("");

  async function simulate(hmacOk: boolean) {
    const out = await fire({
      sampleKey: "pay-418",
      trigger: "pull_request.opened",
      hmacOk,
    });
    setPing(
      out.httpStatus === 403
        ? `403 · ${out.reject ?? "rejected"}`
        : out.skip
          ? `202 skip · ${out.skip}`
          : `202 queued · ${out.jobId}`,
    );
  }

  async function pingLive() {
    const sample = SAMPLE_PRS["pay-418"];
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: sample.pr, draft: false, head: { sha: sample.headSha, repo: { fork: false } } },
      repository: { full_name: `${sample.owner}/${sample.repo}` },
    });
    const sig = await signHub256(settings.webhookSecret, body);
    const t0 = performance.now();
    const res = await fetch("/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": sig,
      },
      body,
    });
    const ms = Math.round(performance.now() - t0);
    const json = (await res.json()) as { pong?: boolean; reason?: string; verified?: boolean };
    setPing(
      `${res.status} in ${formatMs(ms)}${json.pong ? " · pong" : json.reason ? ` · ${json.reason}` : json.verified ? " · verified" : ""}`,
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Inbox</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Webhook ingress</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
        HMAC, idempotency, fork/draft gates, then 202. GitHub App deliveries enqueue on the server and show up here
        and on Operations. Inbox ping only verifies HMAC. Simulate delivery still runs the worker tape.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={() => simulate(true)}>Simulate delivery</Button>
        <Button variant="secondary" onClick={() => simulate(false)}>
          Simulate bad HMAC
        </Button>
        <Button variant="ghost" onClick={pingLive}>
          Ping live /api/webhook
        </Button>
      </div>
      {ping ? <p className="mt-3 font-mono text-[12px] text-fg-muted">{ping}</p> : null}

      <div className="mt-8 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-sm" aria-label="Webhook event log">
          <thead className="bg-bg-elevated font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="hidden px-4 py-3 font-medium md:table-cell">HMAC</th>
              <th className="px-4 py-3 font-medium">Summary</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-sm text-fg-subtle" colSpan={4}>
                  No deliveries yet.
                </td>
              </tr>
            ) : (
              events.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-4 py-3 font-mono text-[12px] tabular-nums text-fg-muted">{formatWhen(e.at)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={e.httpStatus === 202 ? "ok" : "danger"}>{e.httpStatus}</Badge>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <Badge tone={e.hmac === "ok" ? "ok" : "danger"}>{e.hmac}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div>{e.summary}</div>
                    {e.skipReason ? <div className="text-[12px] text-fg-subtle">{e.skipReason}</div> : null}
                    {e.rejectReason ? <div className="text-[12px] text-danger">{e.rejectReason}</div> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
