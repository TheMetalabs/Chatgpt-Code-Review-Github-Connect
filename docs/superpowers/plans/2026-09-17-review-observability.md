# Review observability implementation plan

**Goal:** Fix unacknowledged prompt submission and make review requests traceable from webhook through response storage and publication.
**Architecture:** Preserve the existing per-PR worker and lease protocol; add explicit submission acknowledgement and metadata-only progress. Persist private operational history separately from the in-memory scheduler, and expose it through an authenticated history API and UI.
**Tech stack:** Existing TypeScript/React/TanStack/Zustand, Chrome MV3, Node filesystem, Node tests and Playwright fixtures.
**Spec:** `docs/superpowers/specs/2026-09-17-review-observability.md`.

## Global constraints
No elapsed-time queue/generation/collection failure, automatic ambiguous resend, unrelated-tab adoption, secret logging, production writes, or automatic replay of archived jobs.

## Tasks
- [x] Reproduce failed submission acknowledgement in `tests/review/submission.e2e.mjs`; run against current `composer.js` before editing it.
- [x] Implement journalled submission in `extension/composer.js` and current-turn confirmation in both content providers. Add page/worker stages without exposing prompt content.
- [x] Test and implement `src/lib/review-history.server.ts`, `review-progress.ts`, and protected `/api/history`; test restart, bounded storage, path safety, response persistence failure and event deduplication.
- [x] Instrument ingress, job transitions, bridge claims/results and publication. Keep ignored deliveries out of the runnable job table. Preserve active jobs beyond the UI history cap.
- [x] Add remote sync state, remove production sample initialization, add History navigation/timeline/response export and fix Reviews empty/error states.
- [x] Integrate #38's tested durability/observer boundaries without reverting #37's parser and unbounded waiting changes. Version the complete extension as 1.1.18.
- [x] Run focused red/green tests, regression tests and browser fixtures. Final local verification: 194 regression tests, 43 HTTP fixtures and 24 Chromium DOM/submission tests passed. Document deployment order, persistence requirements and validation limits.
- [ ] Publish the tested tree and verify dependency-backed tests, full typecheck/build, actual MV3 and React History UI fixtures in PR CI. Record results in the PR. Do not merge or deploy.
