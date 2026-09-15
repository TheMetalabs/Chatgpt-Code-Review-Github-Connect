import { Badge } from "@/components/ui/badge";
import { severityTone } from "@/components/status-pill";
import type { Finding } from "@/lib/types";

export function FindingCard({ finding }: { finding: Finding }) {
  const dropped = finding.status === "dropped";
  return (
    <article className="rounded-xl border border-line bg-bg-elevated p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
        {dropped ? <Badge tone="muted">dropped</Badge> : <Badge tone="ok">accepted</Badge>}
        <span className="font-mono text-[11px] text-fg-subtle">
          {finding.file}:{finding.line}
        </span>
      </div>
      <h3 className="mt-3 text-[15px] font-medium tracking-tight">{finding.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">{finding.failureScenario}</p>
      {dropped && finding.dropReason ? (
        <p className="mt-3 text-sm text-warn">{finding.dropReason}</p>
      ) : (
        <dl className="mt-4 grid gap-3 text-sm">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Root cause</dt>
            <dd className="mt-1 text-fg-muted">{finding.rootCause}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Evidence</dt>
            <dd className="mt-1 font-mono text-[12px] text-fg-muted">{finding.evidence}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Fix</dt>
            <dd className="mt-1 text-fg-muted">{finding.recommendedFix}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">Test</dt>
            <dd className="mt-1 text-fg-muted">{finding.recommendedTest}</dd>
          </div>
        </dl>
      )}
    </article>
  );
}
