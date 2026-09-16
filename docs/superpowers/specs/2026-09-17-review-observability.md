# Review submission and operational history

## Contract
A filled composer, a click, a live bridge, and a submitted model request are four different facts. Never declare submission from elapsed time, an Enter key event, a cleared composer alone, or a heartbeat. Confirm a new matching user turn after the saved pre-send baseline. Wait without a duration deadline for attachments/send availability and model response. Once a click might have reached the provider, do not automatically resend: expose `send_unconfirmed` and keep observing the same tab. A human submission can satisfy the acknowledgement later. Preserve job/provider/run identity across reloads.

## Data flow
Page stages (preparing, prompt prepared, send waiting, send attempted, submission confirmed, response waiting/generating, JSON waiting/collected) and worker stages (tab creation, dispatch, delivery, acknowledgement, cleanup) carry bounded, sequenced metadata. The server accepts them only under the matching job lease and provider/run binding. Stage reports do not settle, cancel, or restart a job. Existing `generating` remains a pending-work flag for backwards compatibility, not UI proof of generation.

The server records webhook admission/ignore decisions and job transitions in a private file-backed history store. Journal entries contain stage identifiers and correlation metadata, not prompts, credentials or arbitrary exception text. Bound unparsed response observations and final response bodies are stored separately and returned only by the separate-history-token-protected history endpoint. Storage failure before result acknowledgement must preserve the extension outbox/tab for retry. Repeated heartbeats and repeated telemetry events are deduplicated.

## Operations UI
Production initializes with empty/loading state, not the demo seed. Show successful sync time, read failures and stale observations. Keep demo runs explicitly separate. Add a History navigation entry with Jobs, Reviews and Deliveries, search by repository/PR/job/comment, pagination, job timeline and protected response/export views. Archived jobs are labelled historical: loading history never recreates or reruns paid work. Reset demo cannot delete production history.

## Persistence limits
Default `.data/review-history`, override `ASHLAR_HISTORY_DIR` to a writable persistent volume. One server writer per directory; this is not a distributed queue/database. History is not a live-job restart scheduler. Nonterminal records are never removed by terminal-history retention. Bound terminal history and response size; expose truncation and retention health. Already lost history cannot be recovered. No production configuration, review request or live tab is mutated while developing.

## Verification
Reproduce disabled send beyond ten seconds, no-op click, stale/hidden button, delayed acknowledgement and page reload without duplicate sending in Chromium fixtures. Test history restart, redaction, retention, pagination, response persistence failure, and authorization. Signed webhook fixtures must distinguish ignored comments from runnable Jobs. Verify accepted telemetry does not imply model completion and that mismatched leases/runs cannot alter it. Run existing parallel, unbounded-wait, response/outbox and cleanup suites in CI. Build/typecheck and controlled MV3 tests are separate from live provider validation.
