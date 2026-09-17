# Local format-repair fallback

Approved by the operator after the JSON-repair design discussion. The fallback
is default ON, separately switchable from independent Local code reviews. A
configured Local base URL and model are required. Per the operator clarification,
`reviewLocal` is NEVER a fallback predicate: OFF/ON reviewer participation must
not change fallback eligibility, cancel a formatter, or start a Local review. OFF is a server-authoritative
kill switch: no new calls and no uncommitted repaired result may be applied.

An identified, positively completed, stable assistant response is collected in
full (max 500,000 characters; reject truncation). The original is immutable.
Normal valid results use the original path without any extra model request.
Syntax and structural schema failures can request one formatting-only Local
call per job/provider/run/response/hash/schema. Original and candidate are data,
not instructions. The candidate must pass the stage-specific schema and a
conservative source-content alignment check; missing evidence or novel findings
must never be manufactured. Unsupported transformations remain inspectable.

Repairs are a two-phase protocol: archive/start -> candidate ready -> recheck
original page identity/content/completion -> commit through the original
provider result path. A candidate is NOT an ACK. A repaired ChatGPT result is
not a Local reviewer vote. Normal results, cancellation and supersession fence
stale repairs. The extension receives a matching repair receipt before cleanup.

No elapsed-time queue/generation/collection deadlines, automatic prompt resend,
or inference replay after an ambiguous transport failure. Archive attempted
intent before the call; a server restart marks an uncertain call interrupted,
not a fresh generate. Bound repair record count per job; never silently trim
input to fit. Persist all originals/candidates privately under History access.
The existing archive remains single-writer, not a distributed execution queue.
