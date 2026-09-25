/** Observations only. None of these stages authorizes completion or another prompt. */
export const PROGRESS_LABELS = {
    source_archive_saved: "Full completed source stored · verifying page receipt",
    source_archived: "Full source secured · formatting no longer requires the tab",
    cleanup_restored: "Stored result matches restored page · cleanup state recovered",
    repair_running: "Original response secured · Local JSON repair queued or running",
    repair_ready: "Local repair candidate validated · waiting for source/receipt check",
    repair_accepted: "Local format repair accepted for the original reviewer",
    repair_disabled: "Local JSON repair disabled · original retained",
    repair_superseded: "Local repair superseded · no candidate applied",
    repair_interrupted: "Local repair outcome unknown after restart · no automatic replay",
    repair_needs_attention: "Local JSON repair needs attention · inspect original and candidate",
    tab_created: "Review tab created",
    run_dispatched: "Page runner acknowledged · submission not yet confirmed",
    composer_waiting: "Prompt not sent · waiting for composer",
    attachments_waiting: "Prompt entered · waiting for named attachments to finish uploading",
    response_completed_json_invalid: "Response completion controls observed · JSON invalid; inspect original (no automatic resend)",
    attachments_preparing: "Preparing prompt and attachments",
    prompt_prepared: "Prompt entered · not yet sent",
    send_waiting: "Prompt not sent · waiting for enabled send control",
    send_attempted: "Send attempted · waiting for matching user message",
    send_unconfirmed: "Submission unconfirmed · inspect original tab; no automatic resend",
    submission_unknown: "Submission unknown · inspect original draft; no automatic resend",
    submission_persistence_pending: "Submission confirmed · local journal retry pending; no resend",
    submission_persisted: "Confirmed submission journal saved",
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
    preserve_navigated: "Tab preserved · the user moved it to another conversation or site",
    preserve_user_turn: "Tab preserved · the user sent a follow-up turn",
    preserve_edited: "Tab preserved · the user edited Ashlar's prompt",
    preserve_draft: "Tab preserved · the user typed a draft in the composer",
    preserve_ownership_unknown: "Tab preserved · its ownership could not be proven in time",
    preserve_unreachable: "Tab preserved · the page could not be reached or never finished loading",
    preserve_other_binding: "Tab preserved · it now belongs to another job",
    preserve_unknown: "Tab preserved · cause not reported",
    cleanup_waiting_page: "Tab cleanup waiting on the page · loading, discarded, unreachable or ownership not yet proven",
    disconnected: "Tab connection unknown · waiting for reconnection",
    context_changed: "Conversation changed · collect only the bound review; preserve tab",
    cancelled: "Run stopped · the job was cancelled or forgotten; nothing more is sent or collected",
    salvaged_no_repair: "JSON invalid · original delivered as a raw review (no accepted repair)",
    quota: "Provider reported a usage limit",
    error: "Provider or submission reported an explicit error",
    local_queued: "Local LLM request sent · waiting in the model queue (server alive, no output yet)",
    local_generating: "Local LLM generating output",
    // Tab Lease (Phase 1+). Labelled ahead of the extension: a stage without a label is dropped.
    tab_lost: "Tab lost · it disappeared without Ashlar closing it (vanished, creation unknown or browser restart)",
    tab_rekeyed: "Browser replaced the tab's ID · the lease follows the new ID",
    user_touched: "User input on the tab · it is the user's now; Ashlar will not type, send or close it",
    dom_drift: "Page changed without user input · diagnostic only; the tab stays Ashlar's",
    dom_evidence_without_touch: "Shadow check · legacy kept the tab on page evidence, but no user input was recorded",
    lifecycle_diverged: "Shadow check · tab lease and legacy cleanup reached different verdicts",
    preserve_user_input: "Tab preserved · the user typed, clicked, pasted or dropped something in it",
    preserve_user_moved: "Tab preserved · the user moved it out of the Ashlar group or window, or pinned it",
    preserve_browser_restart: "Tab preserved · the browser restarted mid-run; Ashlar no longer messages or closes it",
    group_expanded: "Ashlar tab group re-expanded · a collapsed group can freeze a live run",
    lease_expired_creating: "Lease expired while creating the tab · creation outcome unknown",
    lease_expired_opening: "Lease expired while opening · the page never became ready; run stopped",
    lease_expired_sending: "Lease expired before the send was confirmed · run stopped; no resend in this tab",
    lease_expired_generating: "Lease expired while generating · no progress or past the deadline; run stopped",
    lease_expired_answered: "Answer lease expired · tab released; the local outbox keeps delivering",
    lease_expired_releasing: "Release lease expired · tab closed if never shown, otherwise preserved",
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
    /** Local leg only: last sign the model server is alive for this request (headers, heartbeat
     * chunk or output). observedAt stays "last real progress", so queued-but-alive is distinguishable
     * from no-response. */
    keepaliveAt?: number;
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
