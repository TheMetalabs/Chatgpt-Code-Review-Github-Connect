# Local JSON repair fallback (extension 1.1.20)

Base: main `7935b6359496247ad1890d12afd5f1e44429219a` (PR #40).

## Independent, default-on policy

`Settings -> Local JSON repair fallback -> 파싱 실패 시 Local LLM으로 JSON 복구`
controls `localJsonRepairEnabled` (default **true**). Save the settings to apply
it. The setting is a formatting fallback, not an additional code-review provider.

| Local code review (`reviewLocal`) | JSON repair | Completed invalid ChatGPT/Grok response |
| --- | --- | --- |
| OFF | ON | Eligible for one formatting request |
| ON | ON | Eligible for one formatting request; no additional reviewer vote |
| OFF | OFF | No formatting request |
| ON | OFF | No formatting request; configured independent reviews are unaffected |

`reviewLocal` is not an eligibility predicate and toggling it does not cancel
format repair. Only `localJsonRepairEnabled` controls this policy. A configured
Local base URL/model remains necessary to make the HTTP request; the Local
reviewer does not have to be selected. No model health timeout is used as a gate.
The shared endpoint is contacted from the **server**, not from the Chrome PC.

Missing settings migrate to ON. A saved boolean false survives process restart
and wins over the environment startup default `ASHLAR_LOCAL_JSON_REPAIR_ENABLED`.
Turning OFF prevents new requests and aborts/fences uncommitted candidates,
even across OFF -> ON changes. It does not cancel the original browser review,
clear responses, add a Local reviewer, or retract results already committed.
Changing the endpoint/model/credential fences outstanding candidates as well.

## Flow and trust boundaries

1. A new-capability extension offers a full source only after the bound user and
   response identities match, the current answer has positive completion
   controls without a Stop/streaming contradiction, and two observations have
   the same content/response ID. Blank, partial and generating responses cannot
   start repair. Observed stability is not itself evidence of completion.
2. Syntax failure reaches this path directly; syntactically valid JSON with
   invalid review fields gets `422 json_repair_required` before permissive
   posting filters can silently drop findings. Normal valid JSON takes the
   original path with no formatting request.
3. The server verifies the lease/job/provider/run/head and full text/hash,
   archives the immutable original and attempted request, then starts one
   formatting-only native Local request. Original + schema + errors are data in
   the user payload. The system instruction forbids rereviewing/inventing text.
4. The candidate passes strict JSON/schema validation and a conservative full
   content alignment check. An inferred correction is **not** proof of the
   upstream model's original bytes. Allowed representations include documented
   camelCase aliases, integer line strings, single finding objects and wrappers;
   malformed quoting/commas may pass only when source bytes remain accountable.
   New/deleted findings, changed evidence/line/severity, duplicate keys, missing
   required information and ambiguous structural text are rejected.
5. A ready candidate is NOT a result ACK. The worker re-reads the same completed
   original before requesting commit. The server rechecks current state and
   adopts it as the original provider's result, retaining `normalizedBy: local`
   separately. No additional consensus vote is created. The normal snapshot and
   posting policy checks still run; formatting does not certify correctness.
6. A matching server receipt must be persisted locally before the page is
   notified. Cleanup is then governed by the existing job/run/message/draft/
   user-followup guards. Result archive failure retries commit, not inference.
   A changed/unavailable page after server acceptance is preserved, not closed.

Repair metadata, original, raw Local candidate and validated candidate are
separate in Job History. Metadata-only reads omit original/candidate content.
The existing History token is required to load them; text is rendered inertly.
No source text is written into ordinary progress events. The formatter result
is not sent to GitHub until accepted and validated by the original review path.

## Failure and concurrency behavior

- No application deadline on upload, queue, model generation or repair wait.
  Browser observer timers and test watchdogs are not production model deadlines.
- One automatic attempt per job/provider/run/response/hash/schema/head, with
  at most eight stored repair identities per job. A changed completed original
  creates a new identity; it invalidates the old uncommitted formatter.
- Native valid results, explicit job cancellation/supersession, or the OFF
  setting fence pending repairs. The first committed result cannot be replaced
  by a late different candidate. Commit requests are deduplicated.
- An ambiguous HTTP failure or server restart does not replay inference. The
  original and any candidate remain inspectable; status becomes needs-attention
  or interrupted. This version does not add a manual repair retry button.
- Full originals have a 500,000-character safety limit. The 128,000-character
  diagnostic preview is never sent as if it were the full response. Oversized,
  truncated or missing source is not silently summarized.
- The independent repair lane does not block normal heartbeat or other PRs.
  Existing per-profile review tab limits and ACK-gated cleanup remain.

## Compatibility and limits

Deploy the server first; update all files in the same unpacked extension to
1.1.20 and reload it without clearing storage or deleting existing tabs. Older
clients cannot request the full-source/repair-receipt protocol, so the server
preserves their legacy completion handling. Unbound legacy tabs are not adopted.
Keep `ASHLAR_HISTORY_DIR` on the existing persistent single-writer volume and
retain the separate History access token.

The live fallback covers current ChatGPT/Grok **review** replies. A pure
`keep/drop` schema validator is tested, but legacy FP execution rounds are
explicitly not routed to this new protocol; their lifecycle needs separate
integration. This does not replace the independent Local review/retry path.
There is no structured-decoding requirement on the Local backend: the schema
is supplied in the prompt and output is validated. Backend context limits,
format fidelity and generation quality can still prevent successful recovery.

The archive is not a persistent execution scheduler or distributed queue.
Unreadable journals, lost job identities and already truncated originals cannot
be repaired by inventing state. Existing malformed responses are not replayed
as new ChatGPT/Grok prompts.

## Verification scope

Tests include all four review/fallback combinations, default/false persistence,
real Settings store serialization, strict validation and rejected content edits,
one inference per identity, OFF during inference, restart fencing, HTTP lease
checks, full source versus diagnostic preview, normal-result races, page
receipt durability and committed cleanup. The browser integration uses actual
Chromium with controlled Chrome API/model/GitHub responses.

The three supplied completed HTML captures and one generating capture were
replayed privately. Predetermined formatting oracles pass unchanged content
checks (3/2/2 findings); changed line numbers fail; the generating sample is not
eligible. This is **not a measurement of a live Local model's repair success**.
No private captures, responses, or conversation IDs are committed.

Full dependency-backed build/React/MV3 and CI still require execution in an
environment with dependencies and GitHub publication available. No new PR,
merge, production setting change, deployment or live model invocation is claimed
by these local verification results.
