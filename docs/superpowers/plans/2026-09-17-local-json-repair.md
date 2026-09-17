# Local JSON repair Implementation Plan

> Execution: task-by-task, test-first in the isolated verified source checkout.

**Goal:** Add a default-on, reversible Local JSON-repair fallback without altering
successful reviews, long waits, original provider identity or safe tab cleanup.
**Architecture:** Pure format/schema/content validation; dependency-injected
single-writer repair service; authenticated start/status/commit bridge operations;
independent extension repair lane and bound page receipt; private archive UI.
**Tech Stack:** TypeScript, native Node HTTP, MV3 JavaScript, React, node:test,
Chromium/Playwright and the existing production-module HTTP fixtures.
**Spec:** docs/superpowers/specs/2026-09-17-local-json-repair.md

## Global constraints

Default `localJsonRepairEnabled=true`; explicit false survives env/persistence/UI.
No model-call deadlines or automatic replay; full originals, no new reviewer vote.
No secrets or user captures in commits; no merge/deployment/production reruns.

## Tasks

- [x] Test settings default/false persistence and strict review/FP schemas plus
  extractive content checks; implement `review-json-repair.ts` and settings/UI wiring.
- [x] Test one call, durable intent, archive errors, off-during-call, restart,
  stale/native winner and unchanged raw request; implement `json-repair.server.ts`
  with injectable settings/job/archive/accept dependencies and protected endpoints.
- [x] Test full stable bound-source capture, no generating/partial source, independent
  worker repair lane and matching repair ACK/cleanup; implement extension changes.
- [x] Test archive original/candidate privacy and history display; add history/UI fields.
- [ ] Run existing regressions + new tests, HTTP + Chromium suites, full CI checks;
  inspect diff for content leakage and concurrency/error paths; open a new PR.

Commands: `npm run test:review-regressions`; signed module fixtures via
`node --experimental-strip-types --experimental-vm-modules --test tests/review/*.e2e.mjs`
(select HTTP/browser files per environment); full `npm test`, `npm run test:lib`,
`npm run typecheck`, `npm run build:dev`. New browser fixture is added to CI.

## Final local review

- Independent fallback/reviewer truth table and reviewer-toggle-during-repair
  tests pass. No reviewLocal gate is used by the formatting service.
- A failed local receipt save was reproduced; the retry now persists before
  sending the page acceptance message.
- A candidate swallowing another finding into a string was reproduced and is
  rejected as ambiguous structural content.
- A transient response archive failure now retains a ready candidate and
  retries commit without calling Local again.
- Full CI/React/MV3 remain unverified: dependencies are unavailable locally, and
  this session exposes only read GitHub actions without an authenticated CLI.
  No remote pull request has been created.
