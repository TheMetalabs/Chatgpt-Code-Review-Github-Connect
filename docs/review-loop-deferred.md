# Review loop (#77): what is intentionally not fixed here

This is the policy for review findings on #77. A finding that falls in a class below gets a reply
that points here, not a code change in #77.

## 1. Pre-existing gaps on the default review path (main)

These exist on `main` and are unchanged by #77. The fix path does not depend on them. #82 (Tab Lease)
tracks them: issue #82 comments 5816565255, 5817076785 and 5817337799 have the full analysis; the
reasons below are one-line summaries.

| Gap | Why it is deferred | Where |
|---|---|---|
| Cancelled before send waits forever | An unbound page answers can-close with `job_mismatch`, so the review leg holds its slot until an operator clears it | `background.js` cleanupProviderBody; kind-conformance W15 (flag R1) |
| Mismatched binding waits | A tab that now carries another binding makes cleanup wait for ownership that never comes back | `background.js` cleanupProviderBody; W10 |
| Edited turn harvested | A review binds the sent turn by containment, so the user's edit around the prompt is still harvested | `json.js` boundReviewResponse; P5 |
| Lost take invisible | A lost `take` response leaves the job claimed with no visible holder until the lease lapses | `bridge.server.ts` take; `background.js` admitJob |
| In-page navigation during generation | The lingering DOM is harvested under the new URL, and its context is recorded there | `json.js` waitUntilReviewOrQuota, reviewPageContext; W27, P16 (flag R4) |
| Release before run | Lease release racing the page run on the review path (summary only; not re-verified here, see the #82 comments above) | `bridge.server.ts` releaseBridgeJob |
| Resumed review blocks the submit window | Submit-window interaction for resumed reviews (summary only; not re-verified here, see the #82 comments above) | `bridge.server.ts` (submitWindowMs) |
| No takeover terminal | A review has no permanent taken-over verdict, so it waits instead of ending | `json.js` can-close; `background.js` cleanupProviderBody |
| Stop before `tabs.create` | An allocation intent with no tab waits on "tab creation outcome unknown" | `background.js` pollProvider; W36 (flag R8) |
| Attempted send wait | An `attempted` journal is never replayed, so an ambiguous click waits forever | `composer.js` clickSend |
| Late message-ID adoption | A message ID assigned after mount is adopted from the recorded position | `json.js` boundReviewResponse |
| `repairedContext` late | The repair receipt's context is recorded at receipt time, not at collection | `json.js` ashlar-repair-accepted |
| Browser error page never retried | A tab on a `chrome-error://` page is not retried or replaced | `background.js` pollProvider, allowedTab |
| Env overrides JSON for non-fix settings | For non-fix settings, env values win over the saved JSON | `src/lib/settings.server.ts` |

## 2. Handed to #82 (Tab Lease)

A root-cause analysis of review rounds R6 to R15 found that the same kinds of bug kept reappearing
in different places. The tab lifecycle code on #77 is being replaced by #82: a pure reducer
(`extension/tablease.js`) over a `storage.local` registry (`tabledger.js`). #82 is stacked on #77
(82955d0) and merges after it. Refactoring these classes in #77 would only conflict with #82 and
then be deleted, so they are handed over:

| Root-cause class | #82 design element that resolves it |
|---|---|
| Duplicated binding identity: jobId, provider, runId, tabId, browser session and the tab URL built and compared ad hoc (R15: runId missing in finishTabCleanup; the fix tab URL in both providerUrl and fixChatPage) | One registry row per leg, keyed by `legId`. Every tab fact is read from that row. |
| Implicit verdict precedence: the if-order in fixOwnershipProof is the rule, so a transient wait was checked before a permanent verdict (R15 #2) | A closed TAKEOVER table plus the reducer. Precedence is data, and every transition is total. |
| Crash windows in multi-step persistence: record, then external action, then promote (the delivery journal, allocation) each needed its own ad hoc recovery (R15 #1) | The row is written before `tabs.create`, and a `hold.html` nonce proves which tab was created. Recovery reads the registry, never a record alone. |
| Temp-chat simplification: a fix runs only in a ChatGPT temporary chat, which cannot be returned to once left, so the conversation-identity layer (send-time conversation pinning, adoptFixConversation, sentFixConversation, the late message-ID guard) can be deleted | #82's Phase 2 deletion list: owned/closed/preserved records, findOriginalTab, the tab inventory, tabCapacityReport estimation, the fix delivery journal and reconcileFixDeliveries, the allocation recovery block, closeProvenTab/preserveFixTab/waitOrPreserveFixTab, fixOwnershipProof/fixCanClose, the conversation-identity layer and send-time conversation pinning |

## 3. Tracked in other issues

- #83: auto re-trigger when the send button is disabled.
- #78: single-shot review commands per provider.

## 4. Policy for #77 from now on

- A remaining tab-lifecycle finding on #77 is closed with the minimal local fix and a regression
  test that fails without it (Ashlar 0 gate).
- The same finding is also recorded in #82 as a trace or mutant candidate for the Tab Lease model.
- #77 adds no new lifecycle abstractions: no new modules, record types or cross-cutting helpers for
  tab identity, verdicts or journals.
- A finding in a section 1 or section 3 class gets a reply pointing to this document.

## 5. Practical scope (#77 and #85)

This is the user's rule. #77 and #85 judge findings the same way.

- **In scope.** Review findings are fixed until the loop works in real use: real users on the real
  provider pages.
- **Out of scope.** A finding is out of scope when it only happens in an unrealistic interleaving.
  Examples:
  - a user action timed to within a second of a poll or a send;
  - several rare coincidences that must all happen at once.
- **What an out-of-scope finding gets.**
  - A thread reply that cites this section, not a code change.
  - A Tab Lease trace in #82, so the lifecycle model covers the finding.
- **Cheap, safe fixes are still taken**, even when the finding is out of scope. A cheap, safe fix is
  small and local, and it comes with a regression test that fails without it (section 4).
