# PR #41: preserve committed repairs in mixed completion batches

Reviewed HEAD: `56558b35c724e15b2362574c15ac7d1eb9f269a1`.
Review comment: `4035946338` (P2). This is a server-only follow-up;
the extension remains **1.1.20.2**. No merge or deployment is performed here.

## Failure and correction

The all-duplicate completion path was idempotent only for an entire batch.
An identical repaired ChatGPT result together with a new Grok result instead
entered the ordinary replacement path. Rebuilding the ChatGPT leg from the
incoming payload removed its repair receipt and originalText. While Local was
still pending, a later differing ChatGPT payload could then replace that leg
because the replacement fence depended on the now-missing receipt.

`completeBridgeJob` now selects the authoritative stored repaired leg for each
identical normalized provider/JSON pair before either completion path, archive
writes, or downstream `submitHarborChat`. This preserves all receipt fields,
originalText, and raw JSON in both runtime and archived response processing.
A duplicate's supplied preview text cannot overwrite the committed original,
even in an all-duplicate replay after posting. New peers still follow normal
validation/storage, and a differing payload for any repaired provider still
rejects the entire batch before response writes or job mutation.

The change is scoped to already repaired results. Normal native-result handling,
lease rules, format checks, explicit failure fences and inference deduplication
are unchanged. It introduces no request, queue or generation deadline, model
retry, new reviewer vote, setting change, or browser protocol change.

## Regression coverage

Thirteen HTTP scenarios use the real bridge, repair service, history and harbor
modules. A controlled independent Local request stays pending while a separate
controlled formatting request is committed. Tests cover repaired ChatGPT and
Grok; both batch orders; raw and fenced duplicates; missing or conflicting
incoming originalText; later conflicting JSON; retries while awaiting_chat and
after posting; storage failure on the repaired leg or new peer; repeated entries
for one provider; and switching format fallback OFF after acceptance. They
check complete receipt/original preservation, accepted repair status, no extra
model request, exactly one final post and unchanged conflicting-batch state.

On the reviewed code the new suite reports 12 failures and one passing control.
After the fix all 13 pass. Local full regression and production-module/HTTP
suites report 237 and 80 passes respectively, with no failures or skips.
Local dependency installation is unavailable due to missing offline packages;
the full local browser suite did not finish in this sandbox and is not claimed
as a pass. Exact pushed-HEAD CI results, including build/typecheck and complete
browser/MV3 suites, are recorded in the PR rather than assumed here.

All model, GitHub and storage-fault responses are controlled fixtures. No live
provider generation, production state mutation, or private user capture is used.
Existing tests remain enabled. Applying this incremental fix needs the updated
server; existing 1.1.20.2 extension files do not need another version change.
For the original PR #41 rollout, keep its server-first deployment and existing
extension ID, pending storage, original tabs and private-history configuration.
