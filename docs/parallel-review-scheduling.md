# Parallel PR review scheduling (extension 1.1.16)

## Scope

This is a standalone change based on main `dde552f`. It replaces the extension's
one-PR-at-a-time scheduler. It does not include the separate, unpublished
connection-diagnostics popup, server diagnostics, JSON-parser changes, or original
response dashboard. No backend API or authentication changes are required.

A pending A must not prevent a separately mentioned B from starting when a review
tab slot is free. B may finish, post to B's PR, and close before A finishes. The
freed slot may then admit C while A continues waiting, including indefinitely in
a provider's queue. Existing explicit-mention admission and same-PR supersession
policies are unchanged.

## Scheduling and ownership

- Work, heartbeat and admission have separate single-flight lanes. A work lane is
  keyed by backend origin and Job ID. One job's delayed page message, HTTP request,
  saved response delivery or tab cleanup does not lock all other jobs.
- Each job has its own provider/run/tab identities. Repeated wakeups do not spawn
  another runner for an in-flight job or accumulate waiters on the same lane.
  The existing content runner deduplicates a retried start acknowledgement.
- A worker loads one shared registry from `pendingReviewJobs`. Durable snapshots
  are written in invocation order, and read/modify/write of shared legacy metadata
  is serialized. A failed storage write does not poison the next write. Provider
  siblings must all settle before the parent work lock is released on error.
- New `take` requests contain all retained Job IDs in `excludeJobIds`. Responses
  that repeat an existing ID cannot overwrite that job or its outbox. A single
  admission lane prevents duplicate claims during overlapping alarms and timers.
- Job RPCs are pinned to the saved backend origin. Changing the configured origin
  cannot send an old job's response to a different backend. Old records are kept.
- A separate heartbeat wakes every 10 seconds and on the existing alarm. It renews
  each job's actual lease, not just a profile-level connection indicator. It can
  run while the job's page polling is stalled. No generation or queue deadline is
  introduced; existing short transport-attempt bounds are unchanged.

## Tab budget

The existing `maxReviewTabs` setting defaults to **4** and is capped at **16**.
This is a **tab** budget, not a PR budget: ChatGPT and Grok use separate slots.
No in-progress tab is closed to make room and no queued review expires.

Admission counts both physical managed tabs (including cleanup-pending tabs) and
providers already admitted but not yet allocated. Capacity check and tab creation
are serialized. If a two-provider job arrives with just one free slot, one
provider starts and the other stays staged until capacity frees; this also works
with a one-tab setting. Further admission waits rather than creating an unbounded
local queue. At most one new server job is claimed per scheduling pass.

Absent historic numeric IDs do not, on their own, consume physical capacity.
Potentially restored provider tabs whose IDs changed are conservatively counted
until binding recovery can identify them. An uncertain in-flight creation intent
also reserves capacity. Such reservations protect against over-creation without
discarding the original job or using elapsed time as a failure signal.

Creation intent is persisted before `tabs.create`, and the returned tab ID and
owner are saved before prompt submission. On restart, uncertain creation is
recovered from the ownership record or matching page binding; if neither can be
established it is retained for recovery, never blindly recreated. This does not
reconstruct a job permanently lost by the server or guarantee automatic recovery
of an unidentifiable tab.

## Completion and cleanup

The per-provider flow remains: current bound final response -> local outbox ->
server acknowledgement -> durable cleanup intent -> ownership/completion check ->
close that tab -> retire the completed job. Another PR's generation never needs
to finish before this cleanup. Unacknowledged responses, unknown server states,
user-repurposed tabs and active generations remain protected. Shared clipboard
output collection is not reintroduced.

## Applying

Update the files in the existing unpacked extension directory and reload that
same extension. The version is `1.1.16`. Keep its origin, token, storage and active
model tabs; do not remove/reinstall it or clear storage. This PR is independent of
the earlier local `1.1.15` diagnostics patch and should be installed from its own
complete extension directory, not by mixing files from unpublished patches.

No server deployment is needed for this scheduler change on the referenced main
bridge protocol. A Git merge does not update an already loaded browser extension.

## Verification

```sh
npm run test:review-regressions
node --experimental-vm-modules --test tests/review/mentions.e2e.mjs tests/review/parallel.e2e.mjs
node --experimental-strip-types --test tests/review/browser.e2e.mjs
node --experimental-vm-modules --test tests/review/extension.e2e.mjs
npm test
npm run typecheck
npm run build:dev
```

`parallel.test.mjs` exercises blocked A / progressing B / new C, simultaneous
wakeups, multi-provider slot allocation, restart identity, lost acknowledgements,
cleanup failure, ordered storage, uncertain tab creation and independent leases.
Old tests asserting intentional serial scheduling now assert admission with free
slots, while preserving their no-duplicate / no-lost-response checks.

`parallel.e2e.mjs` runs signed HTTP webhook and bridge routes through production
parser/ingress/worker/poster modules with Chrome, model and GitHub I/O fixtures.
The separate MV3 scenario uses an actual disposable extension, local chat page
and application server: two PRs run, the extension reloads, B posts/closes before
A, and C uses B's slot. These are not tests against logged-in live model accounts
or GitHub production posting. Long time spans use virtual time. Browser policy
restrictions must be reported, not disabled or bypassed. CI reports dependency-
backed tests/build and browser fixtures separately.
