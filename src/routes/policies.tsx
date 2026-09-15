import { createFileRoute } from "@tanstack/react-router";
import { CODE_REVIEW_MD, PAYMENT_AGENTS_MD, ROOT_AGENTS_MD } from "@/lib/policy";

export const Route = createFileRoute("/policies")({ component: Policies });

const FILES = [
  { path: "AGENTS.md", note: "Directory page. ~short. Points at details.", content: ROOT_AGENTS_MD },
  { path: "code_review.md", note: "Priority, Never report, finding standard.", content: CODE_REVIEW_MD },
  { path: "src/payment/AGENTS.md", note: "Closest-file wins on payment diffs.", content: PAYMENT_AGENTS_MD },
];

function Policies() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">Policies</p>
      <h1 className="mt-2 text-3xl font-medium tracking-tight">Closest file wins</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted">
        Constitution stays short. Repo files are promoted only from allowlisted relative paths. PR bodies and source comments stay untrusted — including “ignore previous instructions”.
      </p>
      <div className="mt-8 space-y-6">
        {FILES.map((f) => (
          <article key={f.path} className="overflow-hidden rounded-xl border border-line">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line bg-bg-elevated px-4 py-3">
              <h2 className="font-mono text-sm">{f.path}</h2>
              <p className="text-[12px] text-fg-subtle">{f.note}</p>
            </header>
            <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-fg-muted">{f.content}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}
