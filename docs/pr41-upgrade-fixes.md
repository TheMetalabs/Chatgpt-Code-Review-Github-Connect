# PR #41: final repair-close boundary and active-collector upgrades

Follow-up to `fb049ae` (1.1.20.1). Extension version: **1.1.20.2**.
Review comments: `4034976314` (P1), `4034976321` (P2).
This change updates the existing PR; it does not merge or deploy it.

## P1 — recheck the acknowledged assistant at close authorization

A native collector can finish before a formatting receipt arrives. Replacing
its assistant response under the same user leaves reviewPageContext unchanged:
that context contains URL and user messages, not the assistant. No collector
then remains to notice the replacement. The old close handler authorized closure.

The close handler now calls preserveRepairContext at the final authorization
boundary for repaired results. A missing/replaced assistant ID, missing original
user, changed source text, or user follow-up permanently preserves the tab. The
acknowledged review remains available. An unchanged response may still close,
but a visible streaming marker, Stop control, draft, or unsaved submission
journal continues to prevent cleanup. These are state checks, not deadlines.

## P2 — listener capability is not executing-collector capability

Reinjecting the v4 listener retained already-executing v2 async functions. Those
functions never produced completedSource and never consumed repairedResult.
Because running was treated as proof of source tracking, repair could not start.

The tracking-capable loop now stamps its own job/run/provider ownership when
it actually starts. Installing/reinstalling a listener never stamps that marker.
A retained legacy or unknown running loop instead gets a private probe tracker.
Two positively completed, matching response-ID/full-text observations are still
required; legacy tracking writes cannot contribute to that counter. Missing
identity, Stop or streaming resets both caches. A known current collector owns
its own counter and repeated worker probes cannot create a second observation.

A verified committed receipt is stored separately as an immutable result and
context snapshot. The new listener can return that result immediately without
waiting for the old invocation to finish or starting a replacement prompt. The
old invocation may remain suspended or later settle naturally; its then/catch/
finally writes to legacy fields cannot overwrite the result returned by the
listener, the original text, or the close-authorization context. We do not claim
to cancel or rewrite an already-executing old JavaScript function. No additional
page polling loop is started. Normal successful cleanup removes the managed
tab; user-repurposed tabs remain under user control.

Duplicate receipts are idempotent only for the same repair ID, response ID,
original text and result. Mismatched receipts cannot replace the first. The
server and worker still establish durable result/receipt storage before sending
this message. Receipt handoff is not a bypass of the server storage boundary.
The installed page listener protocol is now v5; executing-loop capability is a
separate field. Job/run/submission identity and pending storage are retained.

## Regression coverage

Added twelve scenarios in json-repair-browser.e2e.mjs (already run by CI):
unchanged/replaced/missing/same-ID-changed response after native completion;
a genuinely running historical v2 collector across two listener reinjections;
late native success and error/finally after repair acceptance; duplicate/corrupt
receipts; current collector no-double-counting; legacy streaming/foreign-run/
missing-user rejection; reset of legacy probe evidence; full page/worker/HTTP
repair and one-inference cleanup; response replacement before both cleanup
lanes query permission; streaming contradiction during cleanup.

The historical collector/runner fixture is taken from PR #40's v2 implementation
and contains no user capture or private conversation. The running invocation is
actually started before reinjection, not represented only by a boolean flag.

Local validation: 237 regression tests, 67 production-module/HTTP tests and 80
Chromium DOM/submission/page-worker tests pass. The reviewed HEAD reproduces the
new failing paths before the fix. Existing assertions remain enabled. CI must
separately verify the exact pushed HEAD, including React Settings/History,
full npm tests/typecheck/build and MV3 application integration. Local npm ci did
not complete (npm reported Exit handler never called), so those dependency-backed
checks are not claimed as local passes. Model/GitHub and Chrome storage/network
faults are controlled fixtures, not live production model or deployment E2E.

## Preserved contracts / applying

localJsonRepairEnabled remains default ON, independent of reviewLocal. Existing
terminal-provider failure fences and late-response-ID recovery from fb049ae
remain. No generation/queue/observation deadline, automatic prompt replay,
new Local review vote, credential/permission change or original-text upload is
added by these fixes.

After server deployment of PR #41, update all files in the same unpacked
extension directory to 1.1.20.2 and reload the extension. Do not uninstall it,
clear pending storage, or delete original response tabs. A lost binding or
submission journal is still not permission to adopt another conversation.
