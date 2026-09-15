import { cn } from "@/lib/utils";
import type { Finding } from "@/lib/types";

export function DiffView({
  path,
  content,
  findings = [],
  caption,
}: {
  path: string;
  content: string;
  findings?: Finding[];
  caption?: string;
}) {
  const lines = content.replace(/\n$/, "").split("\n");
  const byLine = new Map(findings.filter((f) => f.file === path && f.status === "accepted").map((f) => [f.line, f]));

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="border-b border-line px-3 py-2">
        <div className="font-mono text-[11px] text-fg-muted">{path}</div>
        {caption ? <div className="mt-1 text-[11px] text-fg-subtle">{caption}</div> : null}
      </div>
      <pre className="overflow-x-auto p-0 text-[12px] leading-6">
        {lines.map((line, i) => {
          const n = i + 1;
          const hit = byLine.get(n);
          return (
            <div
              key={n}
              className={cn(
                "grid grid-cols-[3rem_1fr] gap-3 px-3",
                hit ? "bg-danger/10" : n % 2 === 0 ? "bg-transparent" : "bg-bg-elevated/40",
              )}
            >
              <span className="select-none text-right font-mono text-fg-subtle tabular-nums">{n}</span>
              <code className="font-mono text-fg whitespace-pre-wrap break-all">{line || " "}</code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
