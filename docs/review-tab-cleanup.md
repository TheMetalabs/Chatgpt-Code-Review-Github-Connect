# Review tab ownership and cleanup (extension 1.1.13)

Follow-up to the lifecycle integration in #31. Deploy extension 1.1.13 with the
existing lease/failure bridge protocol from #31. No model generation deadline is
introduced; queue and generation may remain pending indefinitely.

## Root cause

Commit `146a885` removed `finally { closeTab(tabId) }` to preserve answers after
parsing/transport failures. The recovery worker inherited that policy but deleted
completed job records without ever calling `tabs.remove`. This patch closes tabs
only after durable receipt, not unconditionally on function exit.

## Lifecycle

1. Persist a job/provider-specific run ID before creating or dispatching a tab.
2. Check job ID, provider and run ID on every returned outcome. The page runner
   rejects other jobs/runs and persists its binding in that tab's sessionStorage.
3. Extract the final response from the current assistant DOM. Output collection
   never reads/writes the shared system clipboard. Composer input compatibility
   still has a clipboard fallback; this is unrelated to output collection.
4. Persist the exact outcome before sending it to the server. A lost ACK retries
   delivery of that outcome, not model generation, including after server posting.
5. On a successful completion/failure ACK, persist `delivered` and
   `cleanupPending`. Close this provider's tab without waiting for other providers.
6. Ask the bound page for read-only closure permission. A running page, changed
   user turn, unsent composer draft, navigation or mismatched run is not closed.
   Check the tab URL again immediately before `tabs.remove`.
7. Retain the journal when messaging or removal fails. A worker restart retries
   cleanup, even when the bridge is offline. Only then remove the per-job record
   and legacy mapping. An explicitly closed tab needs no second remove call.

An explicit cancelled job may enter cleanup, but an unfinished answer is still
kept until its page offers safe closure. `active=false`, validator/posting states,
404s and heartbeat gaps are not receipts or evidence of cancellation. Unknown
states preserve both the outbox and tab. A tab repurposed by its user is left open
and handed back to the user rather than automatically closed.

## Concurrency and memory

The existing recovery-first admission policy is unchanged: an extension normally
admits one PR at a time; ChatGPT and Grok can work in their separate tabs. Multiple
persisted PRs are advanced independently, so a transport failure for one does not
prevent collection/cleanup of another. This is not a new multi-PR scheduler.

Creation is capped at four managed review tabs by default, including tabs awaiting
cleanup and records for other configured bridge origins. An integer
`maxReviewTabs` in extension local storage overrides this (1–16). At capacity,
additional providers wait without a deadline; existing generations are never
cancelled to make room. The cap does not close pre-existing over-capacity tabs.

Individual close events are tracked only for managed tabs, in session-scoped
storage. Ordinary tabs produce no metadata. Obsolete persistent close markers
from 1.1.12 are removed; current markers and old job-tab mappings are removed after
cleanup. Numeric tab IDs are never sufficient proof of ownership after restart.

Already orphaned tabs whose prior versions deleted all ownership records are not
bulk-closed by domain or age. There is no safe way to distinguish those from
personal conversations without their original bindings. They may need one-time
manual cleanup. Tab identity/handshake checks narrow navigation races but do not
make Chrome's asynchronous tab-removal API a transactional document operation.

## Verification

Run `npm run test:review-regressions` and the browser fixtures in
`tests/review/browser.e2e.mjs` and `tests/review/extension.e2e.mjs`. New checks cover
per-provider close-after-ACK, lost ACKs, restart after remove failure, job/run
mismatches, unrelated tabs, user navigation/drafts, 100 consecutive reviews without
tab growth, unknown status retention, creation backpressure, and clipboard-free
parallel extraction. The MV3 fixture verifies actual tab closure after stored JSON
while Local remains pending and an unrelated tab stays open.

Fixtures simulate long elapsed time and use controlled model/GitHub responses.
They are not a signed-in ChatGPT/Grok/production Local-model smoke test or a heap
memory benchmark. The repository's existing legacy brand/PWA test failures remain
unchanged and enabled.

## Tab queue (#85, extension 1.1.25)

Every Chrome tab operation runs in one first-in-first-out queue (`tabOp` in
`extension/background.js`): opening a tab, messaging its page, closing, reloading,
re-keying after a Chrome replace, and the inventory probes.

An operation holds the queue from its first read to its last write. Every wait inside
it is bounded: 15 s per page message (`PAGE_REPLY_MS`) and 30 s per operation
(`TAB_OP_BUDGET_MS`). A page message gets whichever of the two is shorter, and when the
operation's budget is spent nothing is sent. A tab whose page did not answer is not
messaged for 30 s (`PAGE_BACKOFF_MS`), by any operation. The queue is never released
while an operation still runs.

| operation | what it runs |
|---|---|
| `poll` | a leg's allocation (capacity check, intent, `tabs.create`, records), dispatch and harvest |
| `release` | a leg's whole cleanup: lookup, verdict, preserve with its re-probe, close, finish |
| `inventory`, `probe` | the tab list and its drops; one ownership probe per provider tab |
| `sourceRead`, `captureCommit`, `repairReceipt` | the page steps of the review-JSON lanes |
| `rekey`, `removed` | Chrome's `onReplaced` and `onRemoved` facts |
| `abandon`, `stall`, `retire` | the cancel and sweep decisions, and the retirement |
| `reset`, `maintenance` | the hard reset; the capacity read of an update |

Rules the code keeps, each pinned by `tests/review/tab-queue.test.mjs`:

- Bridge calls never run inside an operation, and an operation never waits for another
  one, a single-flight lane or a bridge call. It may schedule one, which runs after it.
  A static guard over the call graph checks this, and that every tab effect is reached
  only from inside an operation.
- Chrome's tab events are recorded at once, in memory (`replacedTabIds`, the inventory
  cache), and applied as the next operations. The listeners return nothing. A leg's
  operation that starts before its tab's re-key ran applies it first
  (`applyPendingReplace`; a re-key is idempotent), and an operation that finds an id
  gone reads a reported replace as "lives on", never as absent.
- An operation re-reads the registry when it starts: one queued for a job that retired
  (or was reset) meanwhile does nothing.
- The allocation writes the new tab's owned record, then its fix delivery promotion,
  and only then names the tab in the leg (CE-2).

Two page checks cover what a lock cannot:

- A new ChatGPT prompt is typed and sent only while its tab is still the new chat it was
  opened on, with no user turn there. The worker checks the tab's URL before the first
  dispatch (a page there already bound to the run, whose `started` the worker never
  saved, is adopted and observed instead); the page checks again when it accepts the
  run (`allocationUrl`) and before every composer step until the Send click
  (`throwIfStopped`: each overlay dismissal, model menu click, file upload, typing pass
  and the click). A refused run binds nothing, is never counted as started, fails
  `taken_over`, and its tab is kept.
- A run message carries a deadline (`until`, 5 s before the reply window this send
  has). An unbound page that receives it later starts nothing (`stale_run`), and the
  next poll dispatches again into the same tab. A poll with less than 8 s of budget
  left does not dispatch.

## Practical scope

**Guarantees** (in every in-scope scenario):

1. A tab with user evidence, or one whose ownership cannot be proven, is never closed.
2. A prompt is typed and sent only into the fresh tab Ashlar opened for that run.
3. Each leg sends at most one prompt. A worker stop never causes a second prompt or a
   close without a fresh verdict.
4. Every leg ends in bounded time, except the provider page wedges tracked in #82.
5. An untouched tab closes once its result is secured. For a fix, that means a delivered
   and proven answer (#77).

**In scope** (each has a test row): an untouched run; reading, scrolling or copying in
the tab, which is not evidence; the user typing, staging a file, sending, editing,
regenerating or moving the tab at human speed, which keeps the tab; the user opening
their own chat in the fresh tab before Ashlar sends, which sends nothing there and keeps
the tab; the user closing an Ashlar tab; a job cancelled, superseded or forgotten at any
stage; a Memory Saver discard; Chrome replacing the tab, including A→B→C; an Energy
Saver freeze or a hung page; the worker stopping between operations; an extension
reload or update mid-run; a browser restart; a page answering after the worker gave up;
several jobs at once, and popup actions at any moment; a bridge outage or one lost
response.

**Out of scope.** These traces get a reply citing this section and a Tab Lease trace,
but no code change:

| | kind | what the code does anyway |
|---|---|---|
| O1 | A user action inside a window under about 1 s tied to a page transition or a worker step: very fast tab switching, typing between the verdict and the close, a move in the milliseconds before the click | Can close the user's chat, or lose a draft |
| O2 | Two or more rare events in one leg: a page answering more than 15 s late, the worker stopping inside an operation, a failed storage write, a replace or close lost with a stopped worker | Keeps the tab or fails the leg; can leave a blank tab |
| O3 | The user duplicating an Ashlar tab mid-run | A lookup may adopt the copy |
| O4 | Other extensions, CDP automation, DevTools, hand-edited storage | Mostly keeps the tab |
| O5 | A system clock jump of several seconds during a dispatch | Refuses or extends one dispatch |

**Known open, not about tab-operation ordering** (tracked in #82): a collector that
never ends on a vanished or errored answer turn (R4); send-side stalls in a live tab; a
lost review take; harvesting a review turn the user edited; the fresh tab taking focus
(`active:true`, Tab Lease Phase 4); Grok's fresh-page check; harbor job persistence (R7).

**Review rule for tab-lifecycle findings.** Write the finding as an event trace, and
mark each event ordinary or rare. A trace in an O-class gets a `defer` reply and a row in
"Deferred traces" below. Anything else is fixed with the smallest change to the rules
above, with no new DOM signals. A finding that is a race between two worker steps is
fixed by moving the missing step into its operation, never by adding a guard.

## Deferred traces

Findings answered `defer` under the review rule above: the trace, its O-class, and the
review thread. The Tab Lease work (#82) takes them as failing traces for its model.

| thread | trace (ordinary / rare events) | class |
|---|---|---|
| (none yet) | | |
