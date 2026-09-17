# Review recovery boundaries (extension 1.1.17.1)

Follow-up to the PR #35 / #36 review, originally based on main `4c14d45`,
now integrated with main `421cbeb` (PR #37). This changes the extension only
and does not change the bridge API. It preserves #37's complete assistant DOM
extraction, local raw observations and unbounded waits. The separate prompt
submission confirmation and server history/dashboard work in PR #39 is not
included or merged by this PR.

## Durable identity and outbox

A shared in-memory registry can contain a run ID or tab binding whose last
storage write failed. Presence in memory is not proof of persistence.
`pollProvider` retries a registry snapshot before any tab message, including
original-tab discovery. A failed write therefore cannot bind a transient run
ID to a page and split its identity from the next worker's saved state.
A tab allocated before a failed write is retained, not allocated again.
`deliverOutcome` also persists the outbox before any delivery attempt, even
when an earlier poll left the outcome only in memory.

The ordering remains: save identity -> observe the bound response -> save
outbox -> server ACK -> safe tab cleanup. Storage errors do not mean empty
model output, do not discard pending work, and do not cause a new generation.

## Observation-only recovery

A restored page can retain its job/run binding while losing its in-memory
collector. `ashlar-harvest` then reports `idle`. For a missing or otherwise
inactive server job, the extension may resume that collector only after an
exact job/provider/run match. The resume message contains no prompt and no
legacy-adoption flag. Existing content scripts' `resume: true` path only
observes the current answer; it does not fill the composer or click Send.

An unbound page, another job, another run, or another provider is not adopted.
Missing/unknown server work is still not an ACK: the recovered reply remains
in the original local outbox, the tab stays open, and no result is sent to a
different PR. When the original server job returns, ordinary delivery and
ACK-gated cleanup can continue. Permanently lost server jobs are not rebuilt.

## Independent monitoring

`bridgeWorkerStatus.phase` describes executing/recovering work. Separate
`admissionPhase` and `admissionCheckedAt` fields describe the most recent
new-request decision. Finishing a work lane cannot erase a capacity, quota,
or connection blocker. Ordered writes prevent older status snapshots from
winning a race. A subsequent successful admission check updates the blocker.
The popup shows both states and still accepts old reports during an upgrade.

## Preserved contracts and applying

Queueing, model generation, response observation and reconnection have no
elapsed-time deadline. PR #37's removal of application deadlines for bridge
requests and content acknowledgements is preserved, as are bounded tab capacity,
independent job heartbeats and job/provider/run separation.
No active tab is closed to make room.

Update the complete files in the SAME installed unpacked extension directory
to 1.1.17.1 and reload that extension. Do not remove/reinstall it, clear storage,
rotate credentials or close pending answer tabs. Server deployment is not
required for these extension-only changes; a Git merge alone does not update
an already loaded extension. The fourth version component distinguishes this recovery
patch from #37 (1.1.17), while remaining older than #39 (1.1.18). Do not
downgrade an installation already using #39 to this smaller recovery release.

## Verification

`tests/review/recovery-boundaries.test.mjs` covers storage failures across
wakeups/restarts, cached outbox persistence, bound-only ChatGPT/Grok observer
resume, missing-job retention, independent diagnostics and indefinite waiting.
It uses production functions with controlled Chrome/storage/server adapters.
`tests/review/pr38-integration.test.mjs` guards against choosing only one side
of the #37/#38 conflicts: both JSON-wait counters and admission blockers must
remain visible without exposing raw observation text in the diagnostics.
`tests/review/browser.e2e.mjs` additionally exercises real Chromium response DOM
collection and popup rendering. These are not live model-account tests.

Run the full repository CI in addition to the targeted regression suite:

```sh
npm run test:review-regressions
node --experimental-vm-modules --test tests/review/mentions.e2e.mjs tests/review/parallel.e2e.mjs tests/review/long-wait.e2e.mjs
node --experimental-strip-types --test tests/review/browser.e2e.mjs
node --experimental-vm-modules --test tests/review/extension.e2e.mjs
npm test
npm run typecheck
npm run build:dev
```
