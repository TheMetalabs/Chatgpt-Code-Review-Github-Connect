# Lossless attachments and rendered submission receipts (1.1.19)

Base: main `6895720` (merged PR #39, 1.1.18.1). This is a follow-up,
not a rollback to 1.1.13. It does not merge, deploy, cancel or rerun reviews.

## Comparison and evidence

PR #39's latest tree includes main #38 (1.1.17.1): run/outbox durability,
bound-only observer recovery, separate admission diagnostics, JSON-pending
counts and previous-error wording remain. The post-send journal-write and
follow-up-response fixes from 1.1.18.1 also remain, with their tests.

The operator supplied three completed HTML captures and one generating
capture. They were replayed privately with scripts removed, external requests
blocked and minimal fixture CSS. Their original text, source, file IDs and
conversation IDs are not committed. Synthetic tests retain the relevant DOM
structure instead. Static captures cannot establish actual upload duration,
installed runtime version, upstream raw model bytes or hosting health.

| Boundary | 1.1.13 / 1.1.17.1 | PR #39 (1.1.18.1) | This change |
|---|---|---|---|
| Attachment framing | Lazy unanchored end-marker regex | Same inherited parser | Negotiated JSON-line envelope; line-anchored legacy reader |
| Fill after attach | 400ms sleep, then global filename probe; inline fallback on slow chips | Same inherited behavior | Fill short prompt immediately; send separately waits for own named chips/progress |
| Rich-text receipt | No confirmed receipt contract | `textContent` loses paragraph/BR boundaries | Canonical body text preserves boundaries without reading file/control labels |
| Completed response controls | Detected in all three supplied completed captures | Also detected | Preserve current-response scope; additionally exclude explicit streaming marker |
| Invalid rendered JSON | Does not parse | Waits indefinitely without distinguishing completed controls | Nonterminal completion-controls/invalid-JSON diagnostic and private original |
| Diagnostic upload | Not this archive path | Awaited by collection lane | Independent single-flight lane; final collection is not blocked |

A literal closing marker inside the extension's own parser source terminated
its legacy attachment early. The supplied rich-text prompt contains a long
source continuation after the normal instructions, consistent with that
failure. A synthetic self-source fixture reproduces it. This is not evidence
that PR #39 added an intentional long attachment delay: the regex, fixed wait,
global probe and chunked insertion fallback already existed in 1.1.13.

All three completed captures contain rendered string values with unescaped
internal quotes; strict JSON parsing fails. Both historical versions also fail
on those same captured strings. Separately, PR #39's full receipt check fails
on the rich-text capture because `textContent` concatenates paragraph/BR text.
The fourth capture is a different, still-generating conversation and is used
only as a negative DOM-state example, never adopted as an Ashlar job.

CommonMark treats backslash punctuation escapes in paragraphs differently from
literal fenced code. A controlled roundtrip of valid JSON with `\"` reproduces
quote loss in paragraph output and preserves the original in a code fence.
This explains a possible rendering loss, not a claim about the unavailable
upstream bytes. The new browser prompt requests one fenced JSON block; the
existing parser still extracts a bare JSON object for the server. There is no
heuristic quote repair, model regeneration or fabrication of review evidence.

## Contracts

- New browser clients request `attachmentProtocol: 2` on take and prompt GET.
  The server encodes the filename/body array on one JSON line in a terminal
  envelope. Source delimiter strings/newlines cannot close that frame.
- Old clients receive their legacy representation. Updated clients also read
  old queued prompts, fixing quoted inline delimiter collisions. Arbitrary
  standalone delimiter collisions in legacy wire data remain inherently
  ambiguous; new V2 frames are the lossless path. Native Local API requests
  receive readable source rather than a browser-only encoded envelope.
- Dispatching files does not mean uploads completed. It only authorizes filling
  the short body. The send barrier checks named attachments in the current
  composer form, visible upload progress, enabled/visible controls, unchanged
  draft and absence of an active generation before the single send attempt.
- Editor selection is scoped to the composer and refreshed after upload
  remounts. Bulk insertion is tried first. No global clipboard fallback or
  per-chunk throttled timers are used. We do not promise a latency bound for
  an unresponsive provider UI.
- Submission is confirmed by matching the canonical rendered message body,
  preserving paragraph/BR boundaries including collapsed text. File chips and
  action labels are not part of that comparison. Late message IDs are pinned.
- Durable prepared/attempted intent remains mandatory before clicking. A
  post-acceptance journal write failure remains recoverable. Ambiguous sends
  are not automatically replayed. Missing identity never falls back to another
  PR or follow-up response. Repurposed tabs remain open after collection.
- `response_completed_json_invalid` means positive completion controls were
  observed but no valid review JSON was found. It is NOT a terminal result or
  proof that the model can never produce more observable text. Original text
  stays private; corrected/later valid DOM can still be collected. Blank or
  generating output stays pending, including an explicit streaming marker
  while the Stop control is temporarily absent.
- Mutation/visibility events wake observers promptly; timers remain fallback
  cadence only. Neither elapsed time nor poll counts turn waits into failure.
- Diagnostic progress/original uploads have their own single-flight lane.
  Slow telemetry cannot block the next harvest/complete poll and cannot create
  an unbounded fan-out. Final responses still require durable archive/server
  acknowledgement before cleanup; telemetry independence is not an ACK bypass.

## Verification

New fixtures: `attachment-boundaries.test.mjs`, `captured-dom-shapes.e2e.mjs`,
`observation-lane.test.mjs`; additional HTTP and Local compatibility checks.
They cover marker literals/full lines, Unicode/CRLF preservation, rich-text
receipts, delayed chips/remounted editors, hidden send controls, streaming
contradictions, invalid completed output, scoped insertion, diagnostic stalls,
old/new client negotiation and unchanged Local request content.

The previous submission-race tests now inject follow-ups before the second
mutation-driven observation, rather than after a fixed 800ms timer. Their
identity/no-resend/no-close assertions are retained. VM Local fixtures import
the real new transport decoder; they do not stub it to an identity function.

Local final runs: 205 review regressions, 45 production-module/HTTP fixtures,
and 52 Chromium DOM/submission fixtures pass. All four operator captures were
replayed without posting: three explicitly report completion-controls/invalid
JSON with original text retained, one remains generating. The rich-text
submission now confirms; malformed captured JSON is deliberately not posted.
Full dependency-backed tests/typecheck/build, History React UI and actual MV3
are verified separately in PR CI. Local npm installation was unavailable due
to missing offline packages; two library test files could not import missing
packages locally. No test is disabled. External model/GitHub I/O is controlled;
this is not a signed-in provider or production-deployment E2E result.

## Applying and remaining limits

Deploy the server first, then update **all files** in the same unpacked
extension directory to **1.1.19** and reload the extension. Keep the extension
ID, pending storage, original tabs and credentials. Do not delete/reinstall or
clear storage. Source merger alone does not update installed browser scripts.
Mixed old content scripts or lost journals may still need operator inspection;
an ambiguous previous send is never silently retried.

Keep PR #39's persistent `ASHLAR_HISTORY_DIR` and separate `ASHLAR_HISTORY_TOKEN`
configuration. Original-response access remains token-protected. This PR does
not turn the single-writer history archive into a persistent execution queue.
Already rendered invalid JSON cannot be losslessly reconstructed from these
captures alone. Inspect its archived original; do not claim it was validly
posted. A future explicitly requested review gets the new fenced-output
contract. No automatic replay of existing jobs, deployment or merge occurs.
