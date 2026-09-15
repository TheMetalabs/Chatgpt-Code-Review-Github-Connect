# Review lifecycle recovery

Integrated follow-ups #31 and #32 to PR #30. Extension version: **1.1.12**. Deploy the bridge server and reload the updated extension together: control requests use client identity and ownership leases, and terminal provider errors use the authenticated `failure` bridge action.

## Invariants

- Queueing and model generation have no elapsed-time deadline. Stop disappearance alone, streaming JSON and old-turn controls do not establish completion.
- Both content scripts use `installReviewRunner`. A run returns `busy` immediately; harvest observes the runner's cached terminal result, not partially generated DOM. Job IDs prevent cross-job harvest. Reinjecting the scripts does not add another listener or run.
- The MV3 worker advances work in short ticks. `chrome.storage.local.pendingReviewJobs` stores each job's origin, prompts, provider tab IDs, start acknowledgements and terminal outcomes. Persisted jobs are reconciled before taking new work. Existing session tab mappings and the alternate follow-up outbox format are migrated when still available. A tab-local job binding permits read-only discovery after tab IDs change.
- A lost start acknowledgement retries the same idempotent page command. A restarted page observer resumes without submitting the prompt again. A completed JSON result is retained until bridge delivery is acknowledged, and replayed only to the bridge, not the model.
- `quota`, `empty`, explicit individual tab closure and navigation away are terminal outcomes. The server records the failed provider without stopping other racers or modifying completed jobs. Missing tabs, lost bindings and transport failures are disconnected/pending until reconnection, not inferred empty/quota. A window/browser closing may be followed by session restoration. Ordinary resume cannot adopt an unrelated tab.
- A client ID identifies the original Chrome profile; lease expiry permits recovery, never ownership theft or model replay. Direct claim and queue selection both enforce ownership. Release preserves execution history. A wrong-lease response retains the outbox and reacquires a lease rather than discarding the final JSON.
- The server stores successful raw output atomically with `generating=false`, before asynchronous validation. Heartbeats do not announce completion before outcome delivery.
- Local generation uses native HTTP(S), no SDK/fetch header/body deadline, no automatic network retry, and an optional caller-provided abort signal. The `/models` health check remains bounded to 5 seconds. Health probes never gate generation. Exactly one JSON correction request is allowed only after a completed non-JSON answer; a second invalid response is an explicit parse failure. Cancellation and supersession abort only the explicitly cancelled Local job.
- Server/extension JSON escape parsing and completion predicates have shared behavioral tests.

Pending prompts and responses are stored locally in the extension while awaiting delivery, then removed from the pending-job records. This does not reconstruct a temporary conversation lost by closing/navigating the tab, nor override timeouts enforced by upstream model servers or proxies. Migration cannot recreate session tab mappings already erased before upgrade.

## Automated verification

Node.js 22.16 or newer; this suite has no npm package dependencies and makes no model calls:

```sh
npm run test:review-regressions
```

It loads the real content scripts, background state transitions, bridge error/HTTP handlers and parsers. Chrome and DOM I/O are mocked. Native local transport tests use real loopback HTTP sockets with a virtual clock covering a day before response headers and another day during the body; this is not a live multi-day model test.

The independent `review-lifecycle` CI job runs both PRs' regressions and cross-component integration tests even if unrelated template tests fail. The `review-browser` job installs Chromium and runs the real DOM and actual MV3 extension fixtures from #31. External model/GitHub endpoints are controlled fixtures, not signed-in live services. `npm test` also runs them first. The existing `verify` job retains the full test suite and runs typecheck/build after dependency installation even when tests fail, so failures stay visible rather than being hidden by `&&`. `npm run test:lib` also runs separately in CI to expose the library test phase when legacy script tests fail.

## Manual browser smoke test still required

1. Start an explicitly requested PR review; leave the model queued and generating beyond 10 minutes. Confirm no premature empty/quota status and no second prompt.
2. Stop/restart only the extension service worker during a run. Confirm the existing tab is harvested before another queued PR is taken.
3. Reload the extension with a live conversation still open. Confirm observation resumes without duplicate submission. Then close a review tab and verify only that provider is reported unavailable.
4. Interrupt bridge connectivity after the model has completed, restart the worker, and reconnect. Confirm the retained JSON is delivered once and the model is not invoked again.
5. Race ChatGPT/Grok with Local; let one fail explicitly and the others finish. Confirm successful JSON is stored before completion state and remaining racers continue.

At development time the unchanged legacy script suite reproduced 185 passing / 10 failing tests (brand-check and grok-pwa-plugin). Those unrelated failures were not disabled or repaired in this change. Live signed-in ChatGPT/Grok and real Local LLM E2E verification has not been performed here.
