/** Observations only. None of these stages authorizes completion or another prompt. */
export const PROGRESS_LABELS = {
    tab_created: "Review tab created",
    run_dispatched: "Page runner acknowledged · submission not yet confirmed",
    composer_waiting: "Prompt not sent · waiting for composer",
    attachments_preparing: "Preparing prompt and attachments",
    prompt_prepared: "Prompt entered · not yet sent",
    send_waiting: "Prompt not sent · waiting for enabled send control",
    send_attempted: "Send attempted · waiting for matching user message",
    send_unconfirmed: "Submission unconfirmed · inspect original tab; no automatic resend",
    submission_unknown: "Submission unknown · inspect original draft; no automatic resend",
    prompt_submitted: "Prompt submitted · waiting for provider response",
    legacy_observation: "Restored legacy page · observing original response",
    waiting_for_response: "Waiting for provider response",
    generating: "Provider generating · observed in current tab",
    waiting_for_json: "Response visible · waiting for valid review JSON",
    json_observed: "JSON observed · confirming final response",
    response_collected: "Final response collected",
    delivery_pending: "Response saved locally · delivery pending",
    result_saved: "Server acknowledged response storage",
    cleanup_pending: "Response secured · tab cleanup pending",
    tab_closed: "Review tab closed",
    tab_preserved: "User-repurposed tab preserved",
    disconnected: "Tab connection unknown · waiting for reconnection",
    context_changed: "Conversation changed · automatic collection paused",
    quota: "Provider reported a usage limit",
    error: "Provider or submission reported an explicit error",
} as const;
export type ProgressStage = keyof typeof PROGRESS_LABELS;
export type ProgressEvent = {
    source: "page" | "worker";
    sequence: number;
    stage: ProgressStage;
    at: number;
};
export type ProviderProgress = {
    runId: string;
    stage: ProgressStage;
    observedAt: number;
    receivedAt: number;
    extensionVersion?: string;
};
export function sanitizeProgressEvents(value: unknown): ProgressEvent[] {
    if (!Array.isArray(value))
        return [];
    return value.slice(-256).flatMap(item => {
        if (!item || typeof item !== "object")
            return [];
        const row = item as Record<string, unknown>;
        if ((row.source !== "page" && row.source !== "worker") ||
            !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 ||
            typeof row.stage !== "string" || !Object.hasOwn(PROGRESS_LABELS, row.stage) ||
            typeof row.at !== "number" || !Number.isFinite(row.at) || row.at < 0)
            return [];
        return [{ source: row.source, sequence: Number(row.sequence), stage: row.stage as ProgressStage, at: row.at }];
    });
}
