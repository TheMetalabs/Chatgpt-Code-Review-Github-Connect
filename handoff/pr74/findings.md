# PR #74 Ashlar findings digest (rounds 1-6)

Total findings: 57 (46 inline, 11 body). P1=21, P2=36, P0=0.

Disposition status: fixed=44, verified=7, verified-hardened=4, by-design=1, deferred=1

| Round | Commit | Total | Inline | Body | P1 | P2 | Fix commit |
|---|---|---|---|---|---|---|---|
| 1 | a4d0fd4 | 8 | 8 | 0 | 4 | 4 | da4808f (reply cites pre-rebase 7c586ad8) |
| 2 | 4f2bd76 | 6 | 6 | 0 | 2 | 4 | 5b2560d |
| 3 | 5b2560d | 15 | 8 | 7 | 3 | 12 | 31473f3 |
| 4 | 31473f3 | 8 | 8 | 0 | 5 | 3 | d563714 |
| 5 | d563714 | 9 | 8 | 1 | 4 | 5 | 921101b |
| 6 | 921101b | 11 | 8 | 3 | 3 | 8 | 0b0a2cd |

Notes:
- Round mapping verified: bot reviews in chronological order a4d0fd4=1, 4f2bd76=2, 5b2560d=3, 31473f3=4, d563714=5, 921101b=6; every inline root comment's original_commit_id and pull_request_review_id match its round's review.
- Per-round counts match each review's <!-- ashlar-findings total= inline= body= p0= p1= p2= --> trailer.
- line = original_line at the reviewed commit; current_line = position on the current PR head (null when the thread is outdated or the finding is body-only).
- resolved: no Ashlar thread on PR #74 is marked resolved on GitHub (all is_resolved=false); body findings have no thread (resolved=false, outdated=null). Use disposition_status for the author's claimed outcome.
- disposition = thread replies (inline) or the matching numbered item of jay-1233's 'Round-N dispositions for the findings without an inline anchor' issue comment (body), condensed to <=400 chars; disposition_full keeps the verbatim text.
- summary, disposition_status, disposition_short and tags_annotation are the dataset builder's annotations, not GitHub text.
- Round-5 review body also carried a non-finding assumption note: 'enqueueFromDecision (harbor.server.ts, not read) is assumed to record a 202 event for skipped/stop/synchronize deliveries; the applyLoopControl redelivery guard (acceptedDeliveryIds(state.events)) depends on that to suppress redelivered stop directives.' It became finding R6-3 in round 6.
- Round-3 dispositions comment ends with: 'This PR now also includes the durable loop session (formerly #75). Round 3's stop, supersession and terminal-idempotency findings are resolved by it (see the inline replies).'
- R6-5 (inline) and R6-9 (body) are the same issue reported twice in round 6 (maybeEscalate bypasses the just-posted cache).
- Round 7 (reviewing 0b0a2cd, job job-muf987dm-2411) was still running at collection time (2026-09-24 ~08:46Z): ops comment says 'ChatGPT: JSON back · 5 findings', local LLM still running; no round-7 review posted yet.
- Round-1 fix commit is cited as 7c586ad8 in replies; after a rebase the round-1 commit on the branch is da4808f.

Tag counts (annotation): unverified-dependency=11, idempotency/sequential-dedup=10, silent-stall=9, event-time/ordering=9, head-supersession/relevance=7, untrusted-text-boundary=6, concurrency/in-flight-guard=6, durable-session-state=6, error-mapping=5, read-after-write-lag=5, duplicate-implementations=4, control-marker-spoofing=3, budget/cap-contract=3, authorization/provenance=3, post-commit-phase=2, termination-contract=2, transient-failure-terminal=2, prompt-injection=2, test-isolation=2, mutable-source-as-state=2, test-issue=2, session-identity=2, watcher-robustness=2, wrong-head=1, doc-code-drift=1, fail-open-coercion=1, gate-ordering=1, fail-open-on-read-error=1, validation-coverage=1, stop-scope=1, external-api-shape=1, control-vs-review-routing=1


## Round 1 (reviewed a4d0fd4)

### R1-1 [P1] [inline] src/lib/review-loop-runtime.server.ts:403
**Fix reports can forge trusted loop markers**
Claim: Model-controlled fix summary / returned paths are interpolated verbatim into a bot-authored fix report. alreadyEscalated trusts any parseable ESCALATE marker anywhere in a bot comment, so a forged marker for the current head suppresses the real fix-declined handoff (untrusted text becomes trusted control text).
Disposition (fixed): Fixed (7c586ad8, now da4808f): every untrusted value goes through sanitizeModelText; escalate/stopped/continue parsers accept a marker only when it OPENS the comment; regression test.
Tags: untrusted-text-boundary, control-marker-spoofing

### R1-2 [P1] [inline] src/lib/review-loop-runtime.server.ts:392
**Post-commit comment failure hands off the wrong head**
Claim: After an applied round pushes NEW_SHA, the success report is posted before the continuation; if the continuation POST throws, the report falsely says the next review was requested and the catch path escalates loop-error against the OLD headSha (escalate closure bound to pre-fix head).
Disposition (fixed): Fixed: explicit post-commit phase; every handoff names the new head, continuation posted before the report, failed continuation -> report says so + loop-error on pushed sha.
Tags: silent-stall, post-commit-phase, wrong-head

### R1-3 [P1] [inline] src/lib/review-loop-runtime.server.ts:408
**catch-path loop-error is never posted when deps failed to load — silent exit breaks the termination contract**
Claim: If productionDeps() (dynamic import) rejects, `d` stays undefined and the catch-path escalate() returns a log-only reason without posting anything, so a user-requested loop ends with no PR-visible signal, breaking the 'every step ends in a fixed outcome' contract.
Disposition (fixed): Fixed: provider transports lazy-load inside requestFix (import failure -> request-failed -> retry -> fix-failed handoff); only GitHub-client load failure remains log-only (documented).
Tags: silent-stall, termination-contract

### R1-4 [P1] [inline] src/lib/review-loop-runtime.server.ts:390
**continueComment throw on an applied round kills the step with no report and no escalation while the fix commit is already pushed**
Claim: An 'applied' outcome with missing/short commitSha makes continueComment throw before the applied report is posted: commit is pushed but no report and no continuation, only loop-error (if d exists) -> pushed-but-unannounced commit and a stalled loop.
Disposition (fixed): Fixed: sha validated before composing the continuation; missing sha posts the applied report (next review not requested) then loop-error; never throws before the report.
Tags: silent-stall, post-commit-phase

### R1-5 [P2] [inline] src/lib/review-loop-runtime.server.ts:396
**Suggest mode posts fixes for superseded heads**
Claim: Live-head validation only runs in apply mode; a suggest-mode fix for H1 is posted even after a push moved the head to H2.
Disposition (fixed): Fixed: supersession check runs before posting any non-applied result (suggestions included); test.
Tags: head-supersession/relevance

### R1-6 [P2] [inline] src/lib/review-loop-runtime.server.ts:329
**The in-flight guard does not serialize fix rounds**
Claim: inFlightEscalate only covers maybeEscalate/escalateNow; two concurrent runPostReviewLoop calls for the same PR/head both proceed to requestFix and both post. No per-head guard spans the whole step.
Disposition (fixed): Fixed: per-head step guard over the entire post-gate step (released in finally); cross-process coordination declared a non-goal (single harbor instance).
Tags: concurrency/in-flight-guard

### R1-7 [P2] [inline] src/lib/review-loop.ts:452
**Pattern precedence contradicts the hard round-cap contract**
Claim: classifyStuck evaluates whack-a-mole/oscillation before the rounds>roundCap branch, so a history past the fix budget returns a pattern reason instead of round-cap; design doc and unit test contradict each other.
Disposition (fixed): Fixed: budget authoritative (review N+1 with findings is round-cap regardless of trend); trend carried as stuckPattern in Detail; tests.
Tags: budget/cap-contract, doc-code-drift

### R1-8 [P2] [inline] src/lib/review-loop-runtime.server.ts:336
**ESCALATE_IN_FLIGHT from maybeEscalate falls through to a blind fix round with empty rounds, defeating requireCurrentRound**
Claim: ESCALATE_IN_FLIGHT from maybeEscalate carries rounds:[]; after a CURRENT_ROUND_MISSING retry the in-flight response can fall through into a fix round with empty rounds, defeating requireCurrentRound.
Disposition (fixed): Addressed: every maybeEscalate error returns before the fix round (in-flight quiet, else loop-error); step guard removes the interleaving.
Tags: concurrency/in-flight-guard, error-mapping


## Round 2 (reviewed 4f2bd76)

### R2-1 [P1] [inline] src/lib/github.server.ts:840
**Unknown head repository is treated as safe for apply**
Claim: fetchPullHeadRef collapses head.repo=null to fork=false (Boolean(...fork)), so unknown head provenance passes the apply fork guard and could write a same-named branch in the base repo.
Disposition (fixed): Fixed (5b2560d): positive provenance sameRepo (head full_name === owner/repo); apply only when true; unknown -> loop-error.
Tags: authorization/provenance, fail-open-coercion

### R2-2 [P1] [inline] src/lib/review-loop-runtime.server.ts:323
**A stale clean review is declared converged before head validation**
Claim: The zero-findings CONVERGED gate runs before the live head is read, so a clean review of H1 ends the loop even though H2 was pushed after it.
Disposition (fixed): Fixed: live head read before any verdict; stale review -> continuation to the live head; CONVERGED only for the live head.
Tags: head-supersession/relevance, gate-ordering

### R2-3 [P2] [inline] src/lib/review-loop.ts:127
**Escalation detail leaves live @mentions intact**
Claim: The escalation sanitizer neutralizes markers but does not defang @mentions, so model summary text or repo-controlled repeated file names in Detail ping users/teams from a bot comment.
Disposition (fixed): Fixed as a class: one sanitizer (sanitizeUntrusted) for every untrusted field in bot comments (Detail, repeated files, CI text, repo, fix reports).
Tags: untrusted-text-boundary, duplicate-implementations

### R2-4 [P2] [inline] src/lib/review-loop-engine.server.ts:280
**Unreadable idempotency history permits duplicate handoffs**
Claim: escalateNow treats a failed listIssueComments idempotency read as 'no prior handoff'; sequential deliveries while the read fails each post an ESCALATE (the Set only serializes overlapping calls).
Disposition (fixed): Fixed: session-scoped marker scan stays source of truth; on read failure fall back to this process's record of posted handoffs; cross-process dedup a non-goal.
Tags: idempotency/sequential-dedup, fail-open-on-read-error

### R2-5 [P2] [inline] src/lib/review-loop-runtime.server.ts:105
**commit-failed is not retried, so one transient commits-API failure ends the loop with a human handoff**
Claim: commit-failed is not in RETRYABLE, so a single transient commits-API failure ends the loop with a fix-failed human handoff although budget remains.
Disposition (fixed): Fixed at transport: commitFiles retries blob/tree/commit/ref once; lost ref-update response recognized as already-at-target; BranchMovedError never retried.
Tags: transient-failure-terminal

### R2-6 [P2] [inline] src/lib/review-loop-runtime.server.ts:337
**Terminal handoff silently dropped when the escalation guard is held (ESCALATE_IN_FLIENT mapped to a quiet exit)**
Claim: When a concurrent maybeEscalate holds the guard, escalateNow returns ESCALATE_IN_FLIGHT and the runtime maps it to silent STEP_IN_FLIGHT; for non-stuck terminal reasons nobody else posts, so the handoff is silently dropped.
Disposition (fixed): Fixed: blocked terminal handoff backs off once and retries; if still blocked returns a non-silent logged reason.
Tags: concurrency/in-flight-guard, silent-stall, error-mapping · reviewer flagged unverified dependency


## Round 3 (reviewed 5b2560d)

### R3-1 [P1] [inline] src/lib/review-loop-runtime.server.ts:528
**Head moves during a fix silently terminate the loop**
Claim: Supersession discovered after the fix request started (watcher/validator) returns SUPERSEDED without posting a continuation for the new head; synchronize does not restart the loop, so the session stalls with the old FIXING marker.
Disposition (fixed): Fixed (31473f3): every supersession exit requests the live head's review via one idempotent continuation per (PR, head, session); push handler does the same.
Tags: head-supersession/relevance, silent-stall

### R3-2 [P1] [inline] src/lib/review-loop-runtime.server.ts:503
**Stop and newer-session intent do not cancel an active fix**
Claim: stillWanted checks only the head SHA, so an operator stop or a newer session on the same head does not cancel an in-flight apply; FixRequestStop cancellation is mapped to retryable request-failed and retried.
Disposition (fixed): Fixed: one relevance check (head moved / session ended / newer session / apply->suggest downgrade) at every checkpoint; a moot round keeps its identity and is never retried.
Tags: head-supersession/relevance, error-mapping

### R3-3 [P1] [inline] src/lib/review-loop-engine.server.ts:245
**Terminal ESCALATE markers are ignored on non-stuck histories**
Claim: alreadyEscalated is consulted only after classifyStuck returns a stuck reason; a redelivered non-stuck review after a fix-failed handoff re-runs the fix agent and may push after the terminal handoff.
Disposition (fixed): Fixed structurally: durable session ends at the App's ESCALATE marker, so a redelivered review finds no active session before the fix path.
Tags: idempotency/sequential-dedup, durable-session-state

### R3-4 [P2] [inline] src/lib/review-loop-runtime.server.ts:423
**Sequential stale deliveries emit duplicate continuation triggers**
Claim: inFlightSteps only serializes concurrent work; two sequential stale deliveries each post a canonical continuation for the live head, causing duplicate reviews.
Disposition (fixed): Fixed: ensureContinuation - single-flight in process + durable-history scan; one continuation per (PR, head, session).
Tags: idempotency/sequential-dedup

### R3-5 [P2] [inline] src/lib/review-loop-runtime.server.ts:199
**Apply mode rejects supported .mts and .cts TypeScript files**
Claim: SYNTAX_EXTS omits .mts/.cts, so valid candidates fail validation -> retry -> fix-failed.
Disposition (fixed): Fixed: .mts/.cts syntax-validated with ScriptKind.TS; tests.
Tags: validation-coverage

### R3-6 [P2] [inline] src/lib/review-loop-engine.server.ts:148
**Session boundaries compare timestamps as raw strings**
Claim: Session boundaries compare ISO timestamps as raw strings; '...00Z' vs '...00.500Z' misorders, so an older handoff can silence a new session and old reviews contaminate rounds.
Disposition (fixed): Fixed: instants (isoMs epoch ms) everywhere; with an anchor, missing/unparseable timestamps excluded.
Tags: event-time/ordering

### R3-7 [P2] [inline] src/lib/fix-agent.ts:29
**Raw editable paths escape the fix prompt data boundary**
Claim: buildFixPrompt renders editable paths raw (paths.join) in the instruction section; a path containing a newline injects instruction text before the untrusted-data boundary.
Disposition (fixed): Fixed: editable list emitted as JSON array; paths with C0/C1/U+2028/9 controls are non-editable; isSafeFixPath shared.
Tags: untrusted-text-boundary, prompt-injection

### R3-8 [P2] [inline] src/lib/review-loop-runtime.server.ts:456
**ESCALATE_IN_FLIGHT from the pre-fix check exits silently with no retry**
Claim: ESCALATE_IN_FLIGHT at the pre-fix check maps to silent STEP_IN_FLIGHT with no backoff; a stale in-flight state would silently no-op every later step (permanent silent stall).
Disposition (fixed): Fixed: one backoff + re-read; still in flight -> logged non-silent reason; in-flight guard is in-memory, released in finally.
Tags: concurrency/in-flight-guard, silent-stall, error-mapping · reviewer flagged unverified dependency

### R3-9 [P2] [body] src/lib/review-loop-runtime.server.ts:390
**runPostReviewLoop can throw if escalateNow rejects**
Claim: escalate() awaits escalateNow without try/catch (also in the catch block), so a rejection escapes runPostReviewLoop, violating its documented 'never throws' contract.
Disposition (fixed): Fixed: escalateNow already converts failures to {error}; escalate() now also wraps the call.
Tags: termination-contract, unverified-dependency · reviewer flagged unverified dependency

### R3-10 [P2] [body] src/lib/review-loop-runtime.server.ts:348
**Provider abort/activity plumbing to requestLocalChat is unverified**
Claim: Watcher guarantees depend on ctl.signal aborting requestLocalChat and onActivity firing; unverified from the snapshot, and fixReportsActivity is derived from env rather than actual capability.
Disposition (verified-hardened): Verified (signal reaches http.request; buffered reply reports output at headers); change: fixReportsActivity from transport's localStreamingDefault().
Tags: unverified-dependency · reviewer flagged unverified dependency

### R3-11 [P2] [body] src/lib/review-loop.ts:312
**Zero-findings (CONVERGED) marker is not anchored to the comment start like the other control markers**
Claim: ZERO_FINDINGS_RE (isZeroFindings) is not anchored like the escalate/stopped markers, so a zero-findings marker quoted in bot prose could be read as CONVERGED.
Disposition (fixed): Fixed: one shared parser reads only the review body's trailing ashlar-findings marker, used by engine and isZeroFindings; tests.
Tags: control-marker-spoofing, duplicate-implementations

### R3-12 [P2] [body] src/lib/review-loop-engine.server.ts:239
**Zero-round history reaches the round cap only if classifyStuck([]) returns a reason — unverified dependency**
Claim: Zero-round (unattributable) histories reach the cap only if classifyStuck([]) returns a reason (unverified); a lenient caller would end silently.
Disposition (verified): Verified: classifyStuck([]) is null by design; runtime always passes requireCurrentRound -> CURRENT_ROUND_MISSING -> backoff -> loop-error; lenient-caller caveat documented.
Tags: budget/cap-contract, unverified-dependency · reviewer flagged unverified dependency

### R3-13 [P2] [body] src/lib/review-loop-runtime.server.ts:459
**Transient history lag becomes a terminal loop-error handoff after one 3s retry**
Claim: CURRENT_ROUND_MISSING gets a single 3 s re-read; API lag beyond that yields a terminal loop-error handoff for a healthy session.
Disposition (fixed): Fixed: re-reads back off 3/6/12 s before history counts as unverifiable.
Tags: transient-failure-terminal, read-after-write-lag · reviewer flagged unverified dependency

### R3-14 [P2] [body] src/lib/review-loop-runtime.server.ts:287
**sanitizeModelText delegates to unverified sanitizeUntrusted; marker and mention defenses depend on it**
Claim: sanitizeModelText now delegates to sanitizeUntrusted, whose marker/mention/length semantics were not visible to the reviewer.
Disposition (verified): Verified, no change: sanitizeUntrusted is the same code and the single sanitizer; covered by a forge test.
Tags: untrusted-text-boundary, unverified-dependency · reviewer flagged unverified dependency

### R3-15 [P2] [body] src/lib/review-loop-runtime.server.test.ts:490
**Concurrency test depends on unverified in-flight registration ordering and a shared module-level guard**
Claim: Concurrency test assumes inFlightSteps registration happens before any await and shares a module-level Set across tests without reset (possible flakiness).
Disposition (verified): Verified, no change: add is synchronous before first await; every exit deletes the key in finally.
Tags: test-isolation, unverified-dependency, concurrency/in-flight-guard · reviewer flagged unverified dependency


## Round 4 (reviewed 31473f3)

### R4-1 [P1] [inline] src/lib/review-loop-runtime.server.ts:619
**Apply can commit after its write authorization becomes stale**
Claim: Apply permission is fetched once before the slow fix request; relevance does not compare the current starter or re-check permission before the ref write, so a round can commit after authorization went stale (new starter without write, or revoked).
Disposition (fixed): Fixed (d563714): relevance compares current starter; pre-commit validate re-checks permission right before ref write; lost access/failed lookup -> loop-error.
Tags: authorization/provenance, head-supersession/relevance

### R4-2 [P1] [inline] src/lib/review-loop-engine.server.ts:381
**Edited comments are reconstructed as durable session commands**
Claim: Session reconstruction reads current (possibly edited) comment bodies at their original createdAt, so a comment later edited to /review-loop apply becomes a backdated start; webhook also used created_at for edited stops.
Disposition (fixed): Fixed (root cause): starts only from the App's start record (event time of directive); human stops only from unedited comments; edited stop via webhook at updated_at + STOPPED.
Tags: event-time/ordering, durable-session-state, mutable-source-as-state

### R4-3 [P1] [inline] src/lib/review-loop-engine.server.ts:389
**Current PR-body stop text is replayed at PR creation and cannot stop later sessions**
Claim: readLoopEvents emits the current PR body as a directive at PR created_at, so a body edited to stop sorts before a later start and cannot stop later sessions.
Disposition (fixed): Fixed: fold no longer reads the PR body; fresh body directives handled by webhook at updated_at; stop is a control event; ingress admits no job.
Tags: event-time/ordering, durable-session-state, mutable-source-as-state

### R4-4 [P1] [inline] src/lib/review-loop-runtime.server.ts:779
**A failed continuation post can permanently stall an active loop**
Claim: Continuation posting is fire-and-forget; a transient POST failure after a push (delivery already accepted) or a crash after an own-push commit (own synchronize skipped) leaves an active session stalled forever.
Disposition (fixed): Fixed: continuation retries 0/2/5 s with re-scan; still failing -> loop-error handoff; App's own push goes through the idempotent repair path.
Tags: silent-stall, idempotency/sequential-dedup

### R4-5 [P1] [inline] src/lib/review-loop-runtime.server.test.ts:812
**Backoff-then-terminal path asserts an operator-stop reason with no operator stop present**
Claim: A test asserts 'loop stopped by operator' when a fix-failed handoff (not a stop) lands during backoff; runtime mislabels a handoff-ended session as an operator stop.
Disposition (fixed): Fixed: quiet reason names how the session ended (endedBy stop/handoff/converged); test split.
Tags: test-issue, error-mapping · reviewer flagged unverified dependency

### R4-6 [P2] [inline] src/lib/harbor.server.ts:1348
**Stop only cancels jobs whose trigger itself was a loop start**
Claim: applyLoopControl cancels only jobs whose trigger was a loop start; a plain re-review during an active session is not cancelled by stop and can post after STOPPED.
Disposition (by-design): By design, documented: stop cancels the loop's own work; a human-requested review still posts but its loop step finds the session ended.
Tags: stop-scope · reviewer flagged unverified dependency

### R4-7 [P2] [inline] src/lib/github.server.ts:885
**fetchUserPermission likely always returns 'none', disabling the apply permission gate**
Claim: fetchUserPermission assumes a JSON body; if the endpoint returned 204 it would always yield 'none', disabling apply.
Disposition (verified): Verified against live API (200 JSON with permission); no change.
Tags: unverified-dependency, external-api-shape

### R4-8 [P2] [inline] src/lib/review-loop-runtime.server.ts:814
**stopLoop re-posts the STOPPED marker on every repeated stop directive (ack idempotency not enforced)**
Claim: stopLoop's gate only checks active/endedBy; a second stop on an already-stopped session re-posts STOPPED (sequential ack idempotency not enforced).
Disposition (verified): Verified: fold turns endedBy stop -> stopped once STOPPED follows, so later stops are no-ops; test pinned.
Tags: idempotency/sequential-dedup · reviewer flagged unverified dependency


## Round 5 (reviewed d563714)

### R5-1 [P1] [inline] src/lib/review-loop-runtime.server.ts:934
**Persist stop events at the original stop time**
Claim: A webhook stop (edit/body) is only injected into the current read; if the single STOPPED POST fails there is no durable stop, and if it is delayed the STOPPED at its later createdAt ends a newer session.
Disposition (fixed): Fixed (921101b): STOPPED ack records the stop (line 2 ashlar-loop-stop at= by=); fold uses `at`; retries re-scan; in-process pending stop honored until durable.
Tags: event-time/ordering, durable-session-state

### R5-2 [P1] [inline] src/lib/review-loop-engine.server.ts:151
**Scope history by session identity, not an inclusive second timestamp**
Claim: History/idempotency scoping uses t >= startIso at second resolution, so session A's handoff in the same second as session B's start counts as B's, leaving B without its own terminal signal.
Disposition (fixed): Fixed: control comments scoped by start record's comment id (startSeq, monotonic); reviews must be strictly later than start; controlInSession.
Tags: event-time/ordering, session-identity

### R5-3 [P1] [inline] src/lib/review-loop-runtime.server.ts:226
**Keep rejected model text out of retry instructions**
Claim: retryFeedback splices the raw rejection error (containing model-controlled path text) into the next prompt right before the trusted retry directive: prompt injection into the apply retry.
Disposition (fixed): Fixed: fixed-text retry directive with closed outcome code; detail JSON-encoded in a declared-untrusted field.
Tags: untrusted-text-boundary, prompt-injection

### R5-4 [P1] [inline] src/lib/review-loop-runtime.server.ts:787
**Agent-controlled summary/error posted unsanitized into the ESCALATE handoff comment**
Claim: res.summary/res.error are forwarded as escalate() detail without sanitizeModelText (unlike renderFixReport), so a forged continue/start/stopped marker could reach a bot-authored handoff.
Disposition (verified-hardened): Verified (escalateNow renders detail via sanitizeUntrusted) and hardened: call sites sanitize too; forge test.
Tags: untrusted-text-boundary, control-marker-spoofing, unverified-dependency · reviewer flagged unverified dependency

### R5-5 [P2] [inline] src/lib/review-loop-runtime.server.ts:466
**Retain successful continuation dedup across list lag**
Claim: The continuation single-flight entry is deleted when the POST resolves; a sequential synchronize handler with a stale list posts a second continuation. Handoff local record consulted only on list error.
Disposition (fixed): Fixed: successful control posts remembered per GitHub client for 24 h and consulted together with listed history (continuation, handoff, start, stop).
Tags: idempotency/sequential-dedup, read-after-write-lag

### R5-6 [P2] [inline] src/lib/harbor.server.ts:1334
**recordLoopStart posts a durable start record without checking loopEnabled**
Claim: recordLoopStart posts a durable start record without checking loopEnabled, so a start admitted while the fix agent is off becomes a live session anchor once re-enabled.
Disposition (verified-hardened): Already gated inside startLoop; now also gated at the harbor call site.
Tags: authorization/provenance, durable-session-state · reviewer flagged unverified dependency

### R5-7 [P2] [inline] src/lib/review-loop-runtime.server.ts:933
**STOPPED ack not idempotent across sequential stop re-deliveries**
Claim: stopLoop's check never looks for an existing STOPPED ack, so a sequential re-delivery of the same stop re-posts STOPPED.
Disposition (fixed): Fixed: stop recorded durably; each attempt scans for a record of this stop (requester+time) plus recent local post.
Tags: idempotency/sequential-dedup · reviewer flagged unverified dependency

### R5-8 [P2] [inline] src/lib/review-loop.test.ts:346
**Hard fix-round budget assertions rest on unverified classifyStuck**
Claim: New hard-budget test assertions depend on classifyStuck behavior the reviewer could not read; if the old 'improving-at-cap -> null' rule remained, the bound would not be hard.
Disposition (verified-hardened): Verified and pinned: round-cap check precedes patterns; boundary tests for decreasing/plateau/rebound.
Tags: budget/cap-contract, unverified-dependency, test-issue · reviewer flagged unverified dependency

### R5-9 [P2] [body] src/lib/github-payload.ts:110
**PR-body stop directive widens the body-request gate to a review trigger whose skip depends on unverified ingress**
Claim: The body-request gate was widened to any fresh directive incl. stop; whether ingress skips a stop-only body_mention as control-only (vs. running a full review) lives in unseen ingress.ts.
Disposition (verified): Verified, no change: reviewSkipReason returns control-only skip for stop-only mention triggers; tests run real decideIngress.
Tags: unverified-dependency, control-vs-review-routing · reviewer flagged unverified dependency


## Round 6 (reviewed 921101b)

### R6-1 [P1] [inline] src/lib/harbor.server.ts:621
**Serialize START and STOP control events before persisting them**
Claim: START record POST and STOP handling run as independent fire-and-forget ops; a stop that reads history before the start record lands returns NO_SESSION and is lost, then the start lands -> active session with no stop (apply may write).
Disposition (fixed): Fixed (0b0a2cd): harbor passes startInFlight so stopLoop records the stop even if it ends nothing yet; stop honored in-process immediately; a stop that stops nothing posts nothing.
Tags: event-time/ordering, concurrency/in-flight-guard, durable-session-state

### R6-2 [P1] [inline] src/lib/review-loop-session.ts:65
**A STOP in the same second as START is ordered before it and ignored**
Claim: deriveLoopSession sorts terminal events before starts on timestamp ties (kind-only ORDER map), so a stop in the same second as a start is processed first and ignored.
Disposition (fixed): Fixed: same-second ties order a human stop after a start; App terminal records still sort before a start.
Tags: event-time/ordering, session-identity

### R6-3 [P1] [inline] src/lib/harbor.server.ts:1347
**applyLoopControl redelivery guard cannot cover control-only deliveries; retried webhook re-fires stop/continue side effects**
Claim: applyLoopControl's delivery dedup reads state populated only after control runs; control-only deliveries never get recorded, so a retried/duplicate webhook re-fires stop/continue side effects.
Disposition (fixed): Fixed: loop-control-claims.ts claims the delivery id before the side effect (bounded); released when the step did not land.
Tags: idempotency/sequential-dedup, unverified-dependency

### R6-4 [P2] [inline] src/lib/review-loop-runtime.server.ts:582
**The missed-push repair path lacks the head-move event needed to reject stale clean reviews**
Claim: continueOn repairs a missed push without injecting a head-move event, so a clean review of the old head that landed after the push is counted as convergence and the loop silently stalls.
Disposition (deferred): Deferred: no trustworthy head-move timestamp in the pulls API; ends as a quiet superseded step, resumes on next push/re-review.
Tags: head-supersession/relevance, event-time/ordering, silent-stall

### R6-5 [P2] [inline] src/lib/review-loop-engine.server.ts:290
**Stuck-loop escalation bypasses the new read-after-write dedup cache**
Claim: maybeEscalate posts its handoff without consulting/recording the read-after-write cache that escalateNow uses, so a sequential step in the lag window double-posts.
Disposition (fixed): Fixed: shared handoffKey; maybeEscalate consults the just-posted cache and records its own post; tests both orders.
Tags: idempotency/sequential-dedup, read-after-write-lag, duplicate-implementations

### R6-6 [P2] [inline] src/lib/github-payload.ts:66
**Edited directives are backdated when updated_at is absent**
Claim: For edited comments commentEventAt falls back to created_at when updated_at is absent, backdating edit-added stop/start directives.
Disposition (fixed): Fixed: edited -> updated_at or undefined (receiver clock), never created_at.
Tags: event-time/ordering

### R6-7 [P2] [inline] src/lib/fix-request-watch.ts:125
**Synchronous throw from request() leaves the watcher interval armed until the queue ceiling**
Claim: A synchronous throw from request() rejects the executor before settle() is wired, leaving the watcher interval running until the queue ceiling and the AbortController never aborted.
Disposition (fixed): Fixed: synchronous throw settled exactly like a rejection (timer cleared, signal aborted).
Tags: watcher-robustness

### R6-8 [P2] [inline] src/lib/fix-request-watch.ts:87
**A hung stillWanted() call permanently disables relevance checks for the in-flight request**
Claim: One hung stillWanted() keeps the `checking` latch set forever, disabling all later relevance checks (stop/head move) for the in-flight request.
Disposition (fixed): Fixed: each relevance check bounded to checkEveryMs; late cancel still counts; queued checks not dropped.
Tags: watcher-robustness, head-supersession/relevance

### R6-9 [P2] [body] src/lib/review-loop-engine.server.ts:292
**maybeEscalate does not rememberPosted after posting, so a sequential re-run inside the read-after-write window double-posts the ESCALATE handoff**
Claim: maybeEscalateInner posts the handoff without rememberPosted (unlike escalateNow), so a sequential re-run in the read-after-write window double-posts ESCALATE (same issue as R6-5).
Disposition (fixed): Fixed: same handoffKey + just-posted cache as escalateNow; test with frozen list gives one handoff.
Tags: idempotency/sequential-dedup, read-after-write-lag, duplicate-implementations

### R6-10 [P2] [body] src/lib/review-loop-runtime.server.ts:601
**Self-healing start re-read is gated on a fresh post, so an existing-but-lagged START record yields a silent NO_SESSION**
Claim: The self-heal re-read after startLoop is gated on started.posted; if the first read lagged but the record exists ('start already recorded'), the session is never re-read -> silent NO_SESSION for the first round.
Disposition (fixed): Fixed: re-read whenever the start record exists (incl. 'already recorded'), backing off 3/6/12 s while the list lags.
Tags: read-after-write-lag, silent-stall

### R6-11 [P2] [body] src/lib/review-loop-engine.server.test.ts:514
**Round-5 escalateNow tests share a session key, so the process-wide postedRecently cache from one test poisons the next**
Claim: Two round-5 escalateNow tests reuse identical session coordinates; the reviewer assumed a process-wide postedRecently cache, so the first test's post would poison the second.
Disposition (verified): Verified, no change: cache is keyed per GitHub client (WeakMap); each test builds a fresh fake client.
Tags: test-isolation, unverified-dependency · reviewer flagged unverified dependency
