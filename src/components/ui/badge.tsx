import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Badge({
  className,
  tone = "muted",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "muted" | "ok" | "warn" | "danger" | "accent" | "p0" | "p1" | "p2" }) {
  const tones: Record<string, string> = {
    muted: "text-fg-muted border-line",
    ok: "text-ok border-ok/30",
    warn: "text-warn border-warn/30",
    danger: "text-danger border-danger/30",
    accent: "text-accent border-line-strong",
    p0: "text-p0 border-p0/30",
    p1: "text-p1 border-p1/30",
    p2: "text-p2 border-p2/30",
  };
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 font-mono text-[11px] tracking-wide uppercase",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
