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
    preserve_undelivered: "Tab preserved · the fix ended without a delivered answer (a fix tab closes only after its answer is delivered)",
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
    // Tab Lease (Phase 1+). Labelled ahead of the extension, so history shows these stages by name
    // rather than under the unlabelled fallback.
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
/** A stage with a history label. */
export type LabelledStage = keyof typeof PROGRESS_LABELS;
declare const unlabelledStage: unique symbol;
/** A well-formed stage the extension recorded ahead of its label, kept as a sentinel: `unlabelled:` and
 * the first 8 hex digits of the SHA-256 of its name, never the name itself. Only the server's
 * keptStage (review-progress.server.ts) makes one, and isUnlabelledStage checks its exact shape. */
export type UnlabelledStage = string & {readonly [unlabelledStage]: true};
/** A recorded stage: a labelled one, or the sentinel of one recorded ahead of its label. Look its label
 * up with progressLabel, never PROGRESS_LABELS directly, so an unlabelled stage shows its fallback. The
 * type stays closed for server code: a stage the server writes must be a LabelledStage, so a mistyped one
 * fails to compile rather than showing up as an unlabelled step. */
export type ProgressStage = LabelledStage | UnlabelledStage;
/** What an unlabelled stage is shown as, ahead of its hash. */
export const UNLABELLED_STAGE = "Unlabelled step";
export const UNLABELLED_PREFIX = "unlabelled:";
/** Exactly the sentinel's shape. A value read back (a history step, a lane's progress) that is neither a
 * label key nor this is not shown by name: it was not written by keptStage. */
const UNLABELLED_SHAPE = /^unlabelled:[0-9a-f]{8}$/;
export const isLabelledStage = (stage: string): stage is LabelledStage => Object.hasOwn(PROGRESS_LABELS, stage);
export const isUnlabelledStage = (stage: string): stage is UnlabelledStage => UNLABELLED_SHAPE.test(stage);
/** Whether a recorded stage is the named labelled stage. Compare through this rather than ===: a string
 * literal still compiles against the unlabelled half of ProgressStage, a mistyped name here does not. */
export const stageIs = (stage: ProgressStage | undefined, want: LabelledStage): boolean => stage === want;
/** The history and lane label of a stage: its PROGRESS_LABELS entry, `Unlabelled step · #<hash>` for a
 * sentinel, and a bare `Unlabelled step` for anything else, so a value of another shape is never shown.
 * A sentinel keeps no name, so it stays unlabelled after its stage's label lands. */
export const progressLabel = (stage: string): string => isLabelledStage(stage) ? PROGRESS_LABELS[stage]
    : isUnlabelledStage(stage) ? `${UNLABELLED_STAGE} · #${stage.slice(UNLABELLED_PREFIX.length)}` : UNLABELLED_STAGE;
const fromExtension = (source: string) => source === "page" || source === "worker";
/** Whether a history step is a page or worker stage that has no label (shown under the fallback, flagged). */
export const unlabelledStep = (step: {source: string; stage: string}): boolean => fromExtension(step.source) && !isLabelledStage(step.stage);
/** A history step's label: a page or worker stage through progressLabel; a server step (job.posted,
 * repair.accepted, local.requested) is shown by its own name. */
export const stepLabel = (step: {source: string; stage: string}): string => fromExtension(step.source) ? progressLabel(step.stage) : step.stage;
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
