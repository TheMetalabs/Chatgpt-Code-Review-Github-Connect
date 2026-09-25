# Confirmed submission and operational history — extension 1.1.18

## What the screenshot revealed

The old composer path waited ten seconds for a usable button, fell back to a
synthetic Enter, and returned without checking whether a user message existed.
Even a no-op click therefore entered response waiting. The pending bridge flag
then made the server say the tab was answering. These were three different facts
being represented by one boolean; the screenshot alone cannot identify which
particular button/upload state occurred on the operator's machine.

The new flow is: persisted job/run identity → composer/attachments → persisted
send intent → one eligible send click → a new matching user message → response
observation → local outbox → private server archive → receipt → safe tab cleanup.
Send selectors enumerate controls, ignore hidden/disabled/Stop buttons (including a
Send disabled only by styling: `data-disabled`, `pointer-events: none`), prefer the
current composer's form, and never fall through to a looser selector while the real
Send is rendered but disabled. A staged file is ready only when its own chip shows no
progress (spinner, ring, bar, busy/loading state, "uploading" label); a fix attachment
must also hold that for 1 s, and a chip error or a new upload-error alert/toast ends
the run as `attachment_failed` before anything is sent. Review upload/send availability
has no duration deadline; a fix attachment has 3 minutes.
A click, an empty composer, a Stop control or elapsed time cannot confirm receipt.

Once a click might have reached the site, it is not automatically repeated. A
missing acknowledgement is `send_unconfirmed`; an old page without a send journal
is `submission_unknown`. Inspect the original tab and, only after confirming that
it still contains the unsent draft, submit manually there. The observer can then
confirm the matching message. Never open a replacement review or reset storage to
recover an ambiguous send. This is deliberately not a promise of exactly-once
submission across an arbitrary provider/browser failure.

## Reading the dashboard

Operations starts empty/loading rather than with a fabricated posted review. It
shows the last successful read and explicit errors, preserving old rows as stale
instead of silently presenting them as fresh. A UI read cancellation only cancels
the unmounted screen's fetch, never model execution. Demo reset is local-only.
Recent Reviews never substitutes a payment-demo diff for a production PR.

**Job History** has Jobs, Reviews and Delivery Log views. Search by repository, PR,
Job ID, comment ID or delivery ID; use status filters and cursor pagination. A job
shows its correlation IDs, received and client-observed times, provider/run IDs,
observed extension version, server transitions and page/worker stages. Repeated
heartbeats do not create log spam. Ignored ordinary/bot comments remain delivery
records, not phantom review Jobs. Separate delivery attempts preserve the original
admission record. Clicking an old job does not execute or restore it.

The archive includes the actual posted review body/inline comments, final JSON and
original rendered response. A nonempty unparsed Chrome response is stored as a
separate **NOT parsed/completed** observation, not a reviewer result. Queueing,
generation and parse waiting remain unbounded. Raw prompt/source text and arbitrary
errors are not embedded in stage telemetry. Large bodies are explicitly marked
truncated. Chrome/Grok originals mean rendered current-assistant text, not an
entire private chat transcript. Local originals mean completed HTTP message text.

The old `generating` flag still means unfinished work for compatibility. New UI
wording uses authenticated page observations; without them it says submission is
not confirmed, rather than asserting that the model is generating.

## Deployment and access

Deploy the server first with:

```sh
ASHLAR_HISTORY_DIR=/persistent/ashlar/review-history
ASHLAR_HISTORY_TOKEN=<a separate random secret of at least 32 characters>
```

Generate the secret on the server with a cryptographic generator. Keep it out of
Git, browser URLs, screenshots and VITE-prefixed variables. The history screen asks
for this dedicated token, keeps it only in page memory, and sends it in the
`x-ashlar-history-token` header. It is **not** the Chrome bridge token: the existing
bridge-token reveal action is not authentication for private archival reads.
History returns 503 until its read credential is configured; incorrect credentials
return 401. New trace/observation uploads retain the existing bridge token plus
job-lease/provider/run checks. No privileged browser commands are added.

Then replace the files in the **same existing unpacked extension directory** with
1.1.18 and reload. Preserve the extension ID, storage, credentials and model tabs.
This integrates the recovery durability, observer resume and admission diagnostics
from unmerged #38 with main's #37 parsing/unbounded-wait changes. Do not mix files
from the two different historical 1.1.17 builds. This PR does not merge/close #38 or
change production settings, jobs, mentions or tabs.

## Persistence contract and limits

This is a private **single-writer, POSIX-filesystem archive**, not a distributed job
queue. The default directory is `.data/review-history`; set the directory to an
actual persistent volume. Atomic temporary-file writes, fsync and rename protect
each saved record. Filenames are hashes of IDs, and new directories/files use
0700/0600. Multiple application writers must not share this implementation.

The current execution scheduler remains process memory. Historical records are
never loaded into it. A record absent from the current runtime is labelled archived,
even if its last recorded state was awaiting_chat. A server restart can still lose
execution state. Already lost pre-upgrade histories cannot be reconstructed by this
change; do not confuse archival retention with live execution recovery.

Default retention: latest 1,000 terminal jobs, 30 days, 128 MiB job archive, and 5,000
delivery events. Retention runs during writes; idle archives are not a TTL deletion
service. Nonterminal records are pinned, so a disk may fill rather than silently
losing an indefinitely waiting job. Per-job logs retain 2,000 steps with a dropped
count. Browser journals retain 128 page plus 128 worker events. Final original/JSON
texts each retain up to 500,000 characters; unparsed observations retain 128,000.
These are storage bounds, not model or queue timeouts.

Failure to persist a received final response returns no success receipt; the
extension retains its outbox and tab. Metadata archival errors are exposed through
history health. No local archive can guarantee retention if its volume is ephemeral
or an operator deletes it, and successful receipt is not successful GitHub posting.

## Verification

New fixtures reproduce disabled send controls, a no-op click, delayed receipt,
hidden controls, reload after prepared/attempted intent, corrupt journals, ordinary
comment filtering, foreign lease/run rejection, raw-history access isolation,
unparsed evidence, archive write failure, archive restart/retention/pagination,
Local invocation and original response, and dashboard seed/reset/sync boundaries.

Chromium DOM fixtures use synthetic forms and message nodes. The React history
fixture uses mocked read responses; HTTP fixtures use production routes with
controlled external GitHub/model I/O. CI separately runs existing MV3 integration,
all repository tests, type checking and build. None is a signed-in live provider
or an actual multi-hour model run; long waits use virtual clocks. Managed local
browser navigation restrictions were not disabled or bypassed.

## PR #39 review follow-up (1.1.18.1)

The latest main (#38) is merged into this branch without dropping durable
run/outbox barriers, bound observer-only resume, admission diagnostics, or either
set of regression tests. Main's JSON-pending counter excludes already-delivered
legs while this branch retains per-provider history stages.

**After-send journal failure is not a provider failure.** Prepared and attempted
submission records are still mandatory before the external click. After a matching
user turn proves acceptance, the page preserves the confirmed identity in memory.
A failed sent-record write reports `submission_persistence_pending` and continues
collecting that response; polls and later harvest/cleanup messages retry only the
write. A cached final response remains available, but the page refuses automatic
closure until the required sent record is saved. On page-context restart the last
durable attempted record reconciles against the accepted user turn, without a
second send. This does not promise recovery if all durable intent was destroyed.

**Follow-ups do not cancel the original collector.** Collection locates the user
message by the confirmed `messageId`, then scopes response text and completion
controls to its assistant response before the next user turn. Providers without
IDs use the recorded position plus expected prompt; ambiguous/missing identity
waits without falling back to a newer reply. A later follow-up's Stop or quota
signal cannot replace or terminate the already identified original response.
The tab is separately marked as user-repurposed so it stays open after delivery.
No queue/generation deadline or automatic prompt resend is introduced.

The submission Chromium suite covers sent-write quota failures for both providers,
retry after storage recovery, a completed result waiting for persistence, restart
from the attempted record, one-click delivery, follow-up before the second stable
observation, competing follow-up JSON, missing/shifted user IDs, no-ID fallback,
and original-response Stop controls. These are deterministic DOM/storage fixtures,
not a claim that signed-in production providers or arbitrary restarts were tested.
