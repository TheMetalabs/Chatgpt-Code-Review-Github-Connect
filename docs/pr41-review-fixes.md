# PR #41 review follow-up (extension 1.1.20.1)

Base reviewed: `52622a76253d9dfc384efb54aed7ae08aad1995b`, tree
`6d586ad2cccd899928eaa1c24a01828b0e23fd5b`. The three review threads refer
to the feature's preceding commit `1971737`; all three still reproduced on
this actual branch HEAD. This change updates the same PR; it does not merge,
deploy, rerun production reviews or change operational settings.

## Repaired-result cleanup boundary (P1)

The repair receipt now pins its validated page context and response identity.
The suspended collector rechecks that binding before returning its repaired
result. Completion and duplicate receipts retain the pinned context rather
than replacing it with a later user conversation. A follow-up, missing user
or changed response identity preserves the tab while retaining the accepted
result. An unchanged completed page remains eligible for ACK-gated cleanup.

## Terminal provider outcomes (P2)

An explicitly acknowledged provider failure supersedes that provider's
running/ready formatting repairs. Eligibility independently rejects terminal
provider errors, so an old ready record cannot override the outcome after
recovery. Transient `disconnected` pings are not terminal. Cancellation is
scoped to one provider; another provider's ready repair remains usable.
No elapsed-time inference or new automatic model retry was added.

## Source observations after native collection (P2)

A valid-JSON response may still need schema repair. If its message ID mounts
on or after the final native observation, repair-source requests now continue
collecting fresh positive completion/identity/text evidence after the native
collector stops. Two matching identified observations are still required.
Missing identity, visible Stop or streaming resets evidence. While the main
collector is running, worker probes do not advance its stability counter.
A 422 can thus reach the formatter without another ChatGPT/Grok generation.

## Current-HEAD CI and accessible settings

At review start, the PR description cited `8f4f7e6`, but the actual branch was
`52622a7`. Its CI run 35197320021 failed the Settings button-name assertion.
The visible label was overridden by the enclosing field label. The Toggle
now has its own accessible name, and multilingual UI fixtures declare UTF-8.
The default-ON, save-OFF/reload and independent-reviewer assertions remain.

## Verification scope

Local final suites: 237 regression tests, 67 production-module/HTTP fixtures,
68 Chromium DOM/submission/page-worker fixtures, all passing. The added tests
control the exact suspended-observation boundary, native-ID timing and late
terminal commit, rather than relying on real-time sleeps. Existing tests are
retained. Actual current-HEAD full dependency/build/React/MV3 CI is recorded
in the PR discussion, not inferred from these local tests.

Chrome APIs, storage failures and external model/GitHub responses are controlled
fixtures; the browser is real Chromium. No signed-in provider or production
Local model was invoked. User-uploaded HTML and confidential conversation or
source data were not committed.

`localJsonRepairEnabled` remains default ON and independent of `reviewLocal`.
Raw response retention, format/content checks, job/run separation, indefinite
queue/generation waits, and server/local ACK durability barriers are unchanged.
Deploy the server and update the existing extension directory to 1.1.20.1
before using these fixes. Keep extension identity, pending storage and tabs;
do not delete/reinstall or clear state. This PR is intentionally left unmerged.
