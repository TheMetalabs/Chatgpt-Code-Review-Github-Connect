# Bridge recovery and job admission (extension 1.1.15)

## Report and evidence

The reported `TheMetalabs/aicc-center#219` request already reached the server:
its 2026-09-16 07:31:26Z status comment identifies `job-mu3s7yd8-23` and says
`ChatGPT: waiting for Chrome bridge`. The PR is not a draft. The supplied
Network screenshot shows a POST to `https://review.jwhy.net/api/bridge` with
HTTP 200; it does not show the request action or JSON response body.

This patch is based on main `dde552f35cf1c16c0380c21fe809467094606b3f`
(tree `ae676a173a1174cb5d74d37b6d2d4973b433df27`). It reproduces code-level
failure paths, not a direct inspection of the user's Chrome storage or live
server logs. A successful HTTP response alone does not prove a job lease or
new job assignment. An authenticated job ping may return `accepted: false`,
`active: false`, and `status: "missing"` with HTTP 200.

## Root cause and repair

Version 1.1.13 returned from `tickBody` whenever any persisted job remained.
A missing backend record, cancelled job waiting for a still-busy tab to finish,
failed tab removal, lost completion acknowledgement, or a reconnecting original
tab could keep that record indefinitely. Recovery continued, but `take` was
never called for any new PR. Numeric tab IDs for absent tabs also consumed the
entire tab budget. Job recovery and transport heartbeat shared one tick lock.

The repair separates three concerns:

- **Recovery:** preserve every original job/provider/run binding, cached reply,
  and tab. Observe a missing server job's original tab without starting a new
  generation or posting its reply to a different job. Retry delivery/cleanup
  when permitted. Unknown state is not cancellation or acknowledgement.
- **Admission:** after recovery processing, healthy current generations still
  retain sequential scheduling. Recovery-only, terminal cleanup, and cached
  outboxes do not prevent a different explicit request from being taken.
  `excludeJobIds` contains retained jobs; a duplicate server response never
  overwrites an existing job or its response. Count physical managed tabs, and
  conservatively reserve space for potentially restored provider tabs whose
  numeric IDs changed. Default four-tab limit (existing setting) is retained.
- **Liveness/diagnostics:** an independent, deduplicated lightweight heartbeat
  records worker-owned health. It does not renew a job lease, mutate an answer,
  or cancel generation. The popup no longer maintains a misleading separate
  connection via its own HTTP fetch. A server outage cannot prevent already
  acknowledged, safely closable tabs from being cleaned up.

No elapsed-time bound is introduced for queueing, generation, response
collection, or reconnection. Existing bridge control-RPC bounds apply only to
one transport attempt, not the model request. Already-running tabs are not
closed to make room. If all four managed/restored slots are occupied, new work
waits and the popup explicitly reports the capacity reason. This is not an
unbounded multi-PR scheduler and does not reconstruct lost server jobs.

## Popup and backend compatibility

The popup separates **Connection** (last HTTP response and timestamp) from
**Job polling** (active/recovering jobs, saved replies, cleanup count, last
poll, and recovery job IDs/status). `Check connection & poll now` asks the
worker to check again without clearing storage, rotating the token, closing
model tabs, or resubmitting an old prompt. Token input is masked.

The server patch adds non-secret `protocolVersion`, `serverInstanceId`,
`pendingJobs`, and `lastTakeAt` metadata. They are diagnostic only. Multiple
server instance IDs may indicate a restart or multiple processes; they are
not grounds for cancelling or restarting model work. The worker retains only
validated primitive metadata, never full response bodies/prompts in health.

The new extension uses the existing main bridge protocol, including
`excludeJobIds`, so the scheduling repair does not require the optional server
diagnostics patch first. Older backends show unavailable diagnostic fields
as unknown. Compatibility has been tested against the pinned production
module graph with controlled external I/O, not against a live deployment.

## Applying without discarding work

1. Back up the currently loaded unpacked extension folder. Keep that folder
   path and extension identity; do not remove/reinstall the extension or clear
   extension storage. Keep existing ChatGPT/Grok answer tabs open.
2. Copy the extension files from this PR into that SAME
   folder (the folder containing `manifest.json`). Reload that installed
   extension in Chrome's extension management page. A new folder may create
   a different extension identity and lose access to the original saved work.
3. Open the popup, confirm version `1.1.15`, origin `https://review.jwhy.net`,
   and the existing enabled/token settings. Use `Check connection & poll now`.
   Do not share the token or an unredacted HAR.
4. Inspect **Job polling**. Recovery-only records should no longer stop fresh
   admission while capacity is available. An active healthy review and a full
   physical tab budget remain valid reasons to wait. HTTP 401 indicates a
   token problem; HTTP 200 alone is not an assignment confirmation.
5. The optional server patch must be applied/reviewed/deployed separately to
   expose server instance and queue count diagnostics. A Git merge is not a
   server deployment.

If the server has permanently lost a job, this patch preserves its response
locally but cannot recreate the missing server job safely. It never treats
`missing` as a successful receipt. Such completed tabs may need explicit,
case-by-case recovery after their answer is secured. Do not bulk-delete old
records to unblock the queue. The earlier separate ChatGPT parsing/original
response dashboard patch is not included here.

## Publication checkpoint and verification

This PR imports the previously saved six implementation files and this document.
No additional implementation changes were made during publication. The original
logs recorded 17 passing admission/recovery cases and two passing Chromium popup
fixtures; those are historical evidence, not a fresh full-suite result for this
published commit. Their source files were not recovered with these seven artifacts
and are **not included** in this PR. In particular, the prior references to
`tests/review/reconnect.e2e.mjs`, `tests/review/popup.e2e.mjs`, and new CI wiring do
not imply that those additions are present on this branch.

Fresh publication checks: Node.js syntax checks for background.js and popup.js,
manifest JSON parsing, TypeScript syntax stripping for bridge.server.ts, and
whitespace validation. Complete tests, full typecheck/build, and actual MV3/live
model E2E still need verification; the PR remains a draft for that reason.

Run the existing repository verification against this branch:

```sh
npm run test:review-regressions
node --experimental-vm-modules --test tests/review/mentions.e2e.mjs
node --experimental-strip-types --test tests/review/browser.e2e.mjs
node --experimental-vm-modules --test tests/review/extension.e2e.mjs
npm test
npm run typecheck
npm run build:dev
```

Controlled Chrome/model/GitHub fixtures are not a live deployment test. There is
no server-history retention change or distributed persistence migration in this
seven-file PR. The earlier separate parser/original-response viewer is not included.
