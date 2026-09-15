import type { ReviewProvider } from "./types.ts";

export type OpsPhase = "running" | "blocked" | "posted" | "skipped" | "failed";

export type OpsCommentInput = {
  phase: OpsPhase;
  providers: ReviewProvider[];
  notes: string[];
};

export const OPS_COMMENT_MARK = "<!-- ashlar-ops -->";

export function buildOpsComment(input: OpsCommentInput): string {
  const chat = input.providers.filter((p) => p === "chatgpt" || p === "grok");
  const local = input.providers.includes("local");
  const reviewers = [
    chat.length ? `${chat.join(" + ")} in parallel (Chrome)` : "",
    local ? "local in the background (optional, never blocks)" : "",
  ]
    .filter(Boolean)
    .join("; ");
  const status =
    input.phase === "blocked"
      ? "blocked — a reviewer is unavailable; others continue"
      : input.phase === "posted"
        ? "review posted"
        : input.phase === "skipped"
          ? "skipped"
          : input.phase === "failed"
            ? "failed"
            : "running";
  const notes = input.notes.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
  const noteLines = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- No blockers. Failures are skipped; remaining reviewers continue.";
  return `${OPS_COMMENT_MARK}

## Ashlar

Reviewers: ${reviewers || "none configured"}.

**Status:** ${status}

${noteLines}
`;
}
