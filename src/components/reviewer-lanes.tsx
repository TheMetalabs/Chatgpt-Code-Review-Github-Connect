import { Check, CircleDashed, LoaderCircle, Minus, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { laneTone, laneVerb } from "@/lib/reviewer-progress";
import type { ReviewerLane } from "@/lib/types";
import { cn } from "@/lib/utils";

function LaneIcon({ state }: { state: ReviewerLane["state"] }) {
  const cls = "size-3.5 shrink-0";
  if (state === "answered") return <Check className={cn(cls, "text-ok")} strokeWidth={1.8} />;
  if (state === "generating") return <LoaderCircle className={cn(cls, "animate-spin text-accent")} strokeWidth={1.8} />;
  if (state === "waiting") return <LoaderCircle className={cn(cls, "text-warn")} strokeWidth={1.8} />;
  if (state === "skipped" || state === "empty") return <Unplug className={cn(cls, "text-danger")} strokeWidth={1.8} />;
  return <CircleDashed className={cn(cls, "text-fg-subtle")} strokeWidth={1.8} />;
}

export function ReviewerLanes({
  lanes,
  compact,
}: {
  lanes?: ReviewerLane[];
  compact?: boolean;
}) {
  if (!lanes?.length) {
    return <p className="text-[12px] text-fg-subtle">Reviewers show up after snapshot.</p>;
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((lane) => (
          <Badge key={lane.provider} tone={laneTone(lane.state)} title={lane.detail}>
            {lane.label} · {laneVerb(lane.state)}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {lanes.map((lane) => (
        <li
          key={lane.provider}
          className={cn(
            "rounded-lg border border-line bg-bg px-3 py-3",
            lane.state === "generating" && "border-line-strong bg-bg-hover",
            lane.state === "answered" && "border-ok/30",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <LaneIcon state={lane.state} />
              <span className="text-sm font-medium">{lane.label}</span>
            </div>
            <Badge tone={laneTone(lane.state)}>{laneVerb(lane.state)}</Badge>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">{lane.detail}</p>
          {lane.answered && lane.jsonChars ? (
            <p className="mt-1 font-mono text-[11px] tabular-nums text-fg-subtle">{lane.jsonChars} chars</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ReviewerLaneDots({ lanes }: { lanes?: ReviewerLane[] }) {
  if (!lanes?.length) return <Minus className="size-3.5 text-fg-subtle" strokeWidth={1.6} />;
  return (
    <div className="flex flex-wrap gap-1.5">
      {lanes.map((lane) => (
        <span key={lane.provider} className="inline-flex items-center gap-1" title={`${lane.label}: ${lane.detail}`}>
          <LaneIcon state={lane.state} />
          <span className="font-mono text-[11px] text-fg-muted">{lane.provider}</span>
        </span>
      ))}
    </div>
  );
}
