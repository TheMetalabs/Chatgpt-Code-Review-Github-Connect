# Completed-source escrow, cleanup recovery and tab capacity (1.1.21)

Base: main `ae6d75adb53b86e1f80b4a7687e3d9419d828cf4`, tree
`265997665118dbbb6502adcbc8a79fdf65773708` (merged #41).
This is a separate follow-up, not a rollback of #41. No model/queue deadline,
forced eviction, increased default tab limit, merge or production deployment.

## Evidence and root causes

The operator reported two Chrome windows, eleven total tabs, seven provider-domain
tabs, five waiting jobs, heartbeat connectivity and no take activity for hours.
Those are operator observations, not a fresh browser/pm2 measurement performed
by this change. Production reads in the implementation environment did not yield
a usable live snapshot. A source count of seven alone is not proof of the old
capacity calculation: it counted managed IDs and conservative restoration guesses.
At exactly four used slots with limit four, a new tab is already blocked.

Reproduced with production modules and controlled Chrome/provider I/O:

1. A completed malformed reply monopolized its tab until Local formatting and
   final result ACK. Formatter OFF, slow inference or rejected JSON could leave
   every browser slot occupied while pings continued indefinitely.
2. An ACKed native result lost its page cleanup state on document reload. The
   worker had the result but only polled can-close, which remained pending.
3. Missing task IDs plus personal provider tabs could satisfy the old restoration
   estimate indefinitely. Conversely, simply ignoring all unknown tabs would
   overbook original runs with a lost local registry.
4. Per-job work can be suspended in transport while a separate repair lane saves
   a sibling result; acknowledged cleanup needs a separate lane, not that work lock.
5. The server/dashboard saw liveness but lacked the worker's actual capacity and
   admission report. A successful ping did not establish that take was progressing.

## Two distinct acknowledgements

`capture` persists the complete, positively completed, bound assistant source.
It validates job/provider/run/response/head/hash and a completed page observation.
The immutable source file, index and timeline step are saved before returning an
acknowledgement. This is NOT a parsed result, successful review or Local vote.

The worker persists the full receipt and source, then asks the same page to
revalidate its original source and user context. Only afterwards can guarded
cleanup close the unchanged owned tab. Generating/streaming, draft, changed
response/user context, missing binding or unsaved journal cannot authorize closure.
A user-repurposed tab is kept and explicitly released from managed capacity.

JSON formatting/validation remains a subtask of the original provider. It can
continue without that browser tab, using authenticated `capture-read` with exact
receipt identity, full length and SHA-256 verification. New normal results do not
use this extra inference path. The `localJsonRepairEnabled` toggle stays default
ON and independent of `reviewLocal`. OFF still preserves/archives completed source
and releases the browser resource, but never runs the formatter or posts invalid JSON.

After cleanup, Chrome keeps a compact source receipt rather than duplicate full
source and review prompts. Prompts needed by an unfinished peer are retained.
The full source remains in protected server history; it is fetched only for the
formatter request. Source/candidate/accepted JSON are different records.

Final JSON still requires the existing server result ACK and local receipt. The
source-only receipt must not set `delivered` or suppress pending review validation.
Storage/transport failures retry the same archive/receipt, not the model prompt.

## Cleanup after interruption

Cleanup has independent per-job/provider single-flight scheduling even while a
work/heartbeat lane is suspended. It remains safe and bounded at the physical
resource boundary. Repeated ticks do not accumulate waiters on occupied lanes.

Native result collection records response identity, exact source and the user
context at collection time. After document reload, an owning worker with a stored
server-ACKed outbox can restore the cleanup proof using `ashlar-result-saved`.
The page verifies the sent journal, response ID, full text, extracted JSON,
completion controls and context. It does not start another collector or send.
Source escrow receipts are similarly re-presented after reload, with fresh source
stability checks. An old outbox without sufficient identity remains protected;
this change does not fabricate lost proof for legacy results.

## Capacity and recovery

The default is still **4**, with explicit popup configuration limited to 1..16.
It is not a global limit on all personal ChatGPT tabs. Read-only `ashlar-tab-status`
probes distinguish unbound personal pages, current managed runs, released user pages,
and unknown/orphan bindings. Probes run independently and contain no raw source.
They never adopt a conversation or dispatch a prompt.

Unknown provider tabs reserve space until ownership is positively resolved, rather
than being aged out. Known personal/released tabs do not consume managed slots.
A bound orphan is counted/protected, not assumed personal. Missing jobs remain in
storage. Inventory invalidates on navigation and removal; finished probe metadata
for removed IDs is discarded.

At capacity the worker may call `recover`, never ordinary take through a bypass.
The server returns only the same profile's previously attempted pending providers
whose job/run IDs match the reported existing tabs. The recovered slots are durably
marked started/resume-only; missing tabs do not authorize new allocation. Foreign
profiles/runs, new jobs, FP rounds, finalized provider legs and jobs absent from the
server runtime are not adopted. No new provider is silently added to the recovery.

This cannot guarantee progress if every slot really is generating, storage cannot
save originals, or all remaining tabs lack verifiable ownership. Those conditions
remain visible and protected; no timeout, unrelated-tab closure or overflow pool
is introduced to hide them.

## Diagnostics and history

Popup: admission reason, used/limit, managed/unknown/restoration/orphan counts,
physical provider-domain count, source backlog, cleanup count and per-job reasons.
Changing a limit requires an explicit valid Save; opening the popup changes nothing.

Heartbeat publishes an allowlist of counts, phase, timestamps and extension version.
No local blockers, prompt, token, raw source or tab URL is sent as telemetry. The
server distinguishes latest heartbeat from latest work report, so an old report
cannot become current merely because a new ping arrived. Dashboard status is shown
on both desktop and narrow layouts. Multiple profiles are not an aggregated pool;
the diagnostic is the most recent reported worker, not a distributed scheduler.

History records full-source metadata separately. The existing protected original
view can reveal the immutable source; default metadata omits text. React renders
it as text, not HTML. Nonterminal captured sources are pinned by history retention.
The per-source bound is 500,000 characters, with at most eight source identities per
job; rejected size/count/storage limits do not silently truncate or grant an ACK.

## Compatibility, deployment and limitations

Deploy server first, ensuring **ASHLAR_HISTORY_DIR is on persistent storage** and
the existing separate ASHLAR_HISTORY_TOKEN is configured. Source files must survive
server/release/container restarts. Then update all files in the SAME unpacked
extension directory to **1.1.21** and reload. Keep extension ID, pending storage,
original tabs and credentials. Do not delete/reinstall or clear storage.

Capability negotiation (`captureProtocol:1`, `recoveryProtocol:1`) keeps old server
paths intact. The earlier browser repair fixtures explicitly use the legacy server
capability path, retaining their existing race/ACK assertions. New fixtures run
with the unmodified new server and test archive-before-format behavior.

This persists evidence, not the in-memory execution queue. If the server runtime
loses a Job on restart, the source is still in history but automatic continuation
of the lost execution is not claimed. Missing jobs/bindings/journals, legacy outboxes
without identity, oversized originals, insufficient disk space or ambiguous Local
repairs may still require operator attention. Pending sources can accumulate on disk;
monitor archive storage rather than relying on browser tabs as the only copy.

## Verification scope

`tab-capacity.test.mjs`, `worker-status.test.mjs`, `source-capture.e2e.mjs`, and
`capacity-browser.e2e.mjs` cover the reported lifecycle. Additional filesystem
history and protected-UI assertions are included. CI workflow runs the new suites
without removing existing suites. Benign ownership-probe messages are excluded
from existing work-message-count assertions; they are independently single-flight.

The checked-in historical v2 collector and #41 receipt/terminal failure/mixed-batch
protections remain. Tests use real Chromium/production HTTP modules with synthetic
model/GitHub data and controlled storage faults. Long waits use virtual time.
No live signed-in provider, Studio/pm2 modification or actual model-cost request
was used. Full dependency-backed typecheck/build/React/MV3 and new-PR CI need to run
in an environment with dependencies and GitHub write access; local evidence records
which commands actually ran. Do not infer a CI pass from the old base's CI.
