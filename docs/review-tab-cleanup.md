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
