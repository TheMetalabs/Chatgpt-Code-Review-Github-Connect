import { cn } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";

const STAGES: { id: JobStatus | "ingress"; label: string }[] = [
  { id: "ingress", label: "Ingress" },
  { id: "queued", label: "Queue" },
  { id: "snapshot", label: "Snapshot" },
  { id: "explorer", label: "Explorer" },
  { id: "reviewer", label: "Reviewer" },
  { id: "awaiting_chat", label: "Chat" },
  { id: "validator", label: "Validator" },
  { id: "posting", label: "Poster" },
];

const ORDER: Record<string, number> = {
  ingress: 0,
  queued: 1,
  snapshot: 2,
  explorer: 3,
  reviewer: 4,
  awaiting_chat: 4,
  validator: 5,
  posting: 6,
  posted: 7,
};

export function stageCaption(status?: JobStatus): string | null {
  if (!status) return null;
  if (status === "cancelled") return "Cancelled — worker released.";
  if (status === "dlq") return "Dead letter — validator failed.";
  if (status === "skipped") return "Skipped — poster or ingress refused.";
  if (status === "posted") return "Posted.";
  if (status === "awaiting_chat") return "Chat reviewers racing.";
  if (status === "reviewer") return "Local reviewer running.";
  if (status === "snapshot") return "Fetching PR snapshot.";
  if (status === "explorer") return "Building the prompt.";
  if (status === "queued") return "Queued.";
  if (status === "validator") return "Schema-merge.";
  if (status === "posting") return "Writing GitHub review.";
  return null;
}

export function Pipeline({ status, size = "full" }: { status?: JobStatus; size?: "full" | "compact" }) {
  const idx = status ? (ORDER[status] ?? -1) : -1;
  const done = status === "posted";
  const skipped = status === "skipped" || status === "cancelled" || status === "dlq";
  const caption = stageCaption(status);

  if (size === "compact") {
    return (
      <div>
        <ol className="flex flex-wrap items-center gap-1.5">
          {STAGES.map((s, i) => {
            const active = !done && !skipped && idx === i;
            const complete = done || (!skipped && idx > i);
            return (
              <li key={s.id} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    skipped ? "bg-line" : active ? "bg-accent" : complete ? "bg-ok" : "bg-line",
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    "font-mono text-[10px] uppercase tracking-[0.12em]",
                    active ? "text-fg" : complete && !skipped ? "text-fg-muted" : "text-fg-subtle",
                  )}
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>
        {caption ? <p className="mt-2 text-[12px] text-fg-muted">{caption}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {STAGES.map((s, i) => {
          const active = !done && !skipped && idx === i;
          const complete = done || (!skipped && idx > i);
          return (
            <li
              key={s.id}
              className={cn(
                "rounded-lg border px-3 py-3 transition-colors duration-200",
                skipped
                  ? "border-line bg-bg"
                  : active
                    ? "border-line-strong bg-bg-hover"
                    : complete
                      ? "border-line bg-bg-elevated"
                      : "border-line bg-bg",
              )}
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                {String(i).padStart(2, "0")}
              </div>
              <div className={cn("mt-1 text-sm", !skipped && (active || complete) ? "text-fg" : "text-fg-muted")}>
                {s.label}
              </div>
              <div className="mt-2 h-px bg-line">
                <div
                  className={cn(
                    "h-px bg-accent transition-[width] duration-300",
                    skipped ? "w-0" : complete ? "w-full" : active ? "w-1/2" : "w-0",
                  )}
                />
              </div>
            </li>
          );
        })}
      </ol>
      {caption && skipped ? <p className="mt-3 text-sm text-fg-muted">{caption}</p> : null}
    </div>
  );
}
