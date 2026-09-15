import { Badge } from "@/components/ui/badge";
import type { JobStatus, MergeRec, Severity } from "@/lib/types";

export function severityTone(s: Severity) {
  return s.toLowerCase() as "p0" | "p1" | "p2";
}

export function StatusPill({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { tone: "muted" | "ok" | "warn" | "danger" | "accent"; label: string }> = {
    queued: { tone: "muted", label: "queued" },
    snapshot: { tone: "accent", label: "snapshot" },
    explorer: { tone: "accent", label: "explorer" },
    reviewer: { tone: "accent", label: "reviewer" },
    awaiting_chat: { tone: "warn", label: "awaiting chat" },
    validator: { tone: "accent", label: "validator" },
    posting: { tone: "accent", label: "poster" },
    posted: { tone: "ok", label: "posted" },
    skipped: { tone: "muted", label: "skipped" },
    dlq: { tone: "danger", label: "dlq" },
    cancelled: { tone: "warn", label: "cancelled" },
  };
  const m = map[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function MergePill({ event }: { event?: MergeRec }) {
  if (!event) return null;
  if (event === "REQUEST_CHANGES") return <Badge tone="danger">request changes</Badge>;
  if (event === "APPROVE") return <Badge tone="ok">approve</Badge>;
  return <Badge tone="muted">comment</Badge>;
}
