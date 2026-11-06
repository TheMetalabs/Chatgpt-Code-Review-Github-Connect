# Staged local review (Settings `local_review.pipeline`, on by default)

## Why

The 2026-11 false-positive eval used aicc-center 4 PRs; the clearest comparison is #1251, where each reviewer ran on the same PR:

| Reviewer | Reviews | Posted findings | Per review |
|---|---|---|---|
| Grok (Chrome) | 5 | 2 | 0.4 |
| ChatGPT (Chrome) | 7 | 7 | 1.0 |
| Local, grouped tool loop | 4 | 26 | 6.5 |

All 40 judged findings came from local-only jobs: 34 were false positives, 3 valid and 3 unclear.

Three structural causes in the grouped loop explain most of the false positives:

1. **A group saw only its own files.** A guard in a sibling group's file read as "missing". This is "out-of-diff speculation", 12 of 34.
2. **No room to verify.** The first turn took 75% of the 24K loop cap. That left about 6K tokens, which is roughly one 400-line `file_read`. When the cap was reached the model was told "answer with what you have". This produced factual errors and unverified claims.
3. **Nothing ranked findings across the PR.** Each group added its own findings, so a review filled up to the 8-finding cap.

The chat reviewers do not have these problems. They see the whole PR in one turn, reason before they answer, and pick a few findings in that one answer. The pipeline gives the local model the same three properties: the whole-PR view, a chance to refute each finding, and a final pick. It does this as separate turns that each fit the local window.

## Stages

Every turn is a **fresh request**; nothing accumulates across turns. Each turn's prompt is sized to the local first-turn budget (`localFirstTurnBudgetTokens`), so it always fits the ~30K window with room left for the reply.

| Stage | Turns | Input | Output |
|---|---|---|---|
| 1. PR map | 1 per batch of ≤12 files | each file's diff (≤8K chars each) | one factual line per file: summary, guards, effects, plus the diff stat and changed exports Ashlar computes itself |
| 2. Features | 1 per feature group | the review instructions, the feature's diff and context (`buildChatParts` local budget), the **PR map of every other file**, the PR description and policy docs | candidate findings, at most 4 per feature |
| 3. Refute | 1 per candidate, after the deterministic gate (at most 12) | the candidate plus evidence Ashlar collects itself: the cited code ±30 lines, the code each evidence step cites, definitions of the symbols the finding names, their uses in other changed files, the module docs for the file, the PR description, and PR map lines | `confirmed` / `refuted`, a proof quote and a severity |
| 4. Select | 1 (skipped for ≤1 survivor) | the PR map and the confirmed findings | at most `local_review.pipeline_max_findings` (default 3), with duplicates merged |

**Feature groups.**
- Files linked by a relative import, or a test and its subject (same stem), form one group.
- A linked set larger than the group budget is cut along a breadth-first walk of its imports.
- Unlinked files are packed with their directory neighbours.
- Every reviewable changed file belongs to exactly one group.

**Refute rules.**
- A confirmation counts only when its proof quote is real code from the evidence's CODE section (`quoteInCode`). The PR description and the docs do not count as proof.
- The verifier may lower a severity, never raise it.
- With `local_review.pipeline_verify_votes` = 2 or 3, every vote must confirm.
- A verification that cannot run (transport error, or no verdict after one retry) keeps the candidate as reported, severity unchanged, and says so in assumptions. Candidates past the verify cap are kept the same way. A failure never becomes a clean result.

**Sampling.**
- Feature turns use the configured local sampling.
- Map, refute and select turns use temperature 0.1 and presence penalty 0. Votes after the first use temperature 0.4.
- Override with `ASHLAR_LOCAL_PIPELINE_STRICT_TEMPERATURE` and `ASHLAR_LOCAL_PIPELINE_VOTE_TEMPERATURE`.

**Small PRs.** A PR that fits one request still runs single-turn. Stages 3 and 4 then run on its findings (`verifySingleTurn`).

**Unchanged semantics.**
- A feature whose reply never becomes review JSON is `unreviewed_paths`. Its replies are kept as evidence (`unparsedText`).
- If every feature fails, the leg fails.
- When every candidate is refuted, the review still lists `investigated_safe`.

**Ops comment.** The comment adds one line, for example `Local pipeline: 5 feature group(s), 14 candidate(s), 9 past the gate, 2 confirmed, 7 refuted, 2 posted (31 turns)`.

## Recall (2026-11-06)

After the pipeline shipped, precision was in hand but the local reviewer found almost nothing. On the same commit, Codex caught three defects that were later fixed: aicc-center #1473, #1462 and #1468. All three were small PRs, and each local review came back `findings: []`. No candidate reached the refute stage, so the loss happened at generation. Generation used the chat precision rules ("never report anything unverified, conditional or possible…", "delete a finding that…"), and with those rules a small model reports nothing.

Precision is enforced by the refute stage, so generation is now tuned for recall:

**Candidate generation**
- Candidate turns use `HUNT_INSTRUCTIONS` instead of `REVIEW_INSTRUCTIONS`. They are told to report every defect they can tie to a changed line, with that line quoted, because a verifier checks each candidate. Style, docs, naming, log wording and test advice are still not findings.
- Each feature gets one candidate pass per lens (`local_review.pipeline_lenses`, default 3):
  - failure paths (catch / retry / async / partial failure, e.g. #1462's stale profile after a failed refresh);
  - data identity and invariants (key collisions, null, boundaries, e.g. #1468's same-name rows);
  - contracts (callers, callees, status codes, a test's expectation versus the implementation, e.g. #1473).
- The candidates from all passes are merged, and duplicates are removed (`dedupeCandidates`).
- A PR whose diff fits one turn is reviewed as **one whole-PR feature** with no map, so the turn sees the whole change, as ChatGPT does.

**Gate**
- The gate's soft drops (`speculative`, `evidence_unverified`, `evidence_unavailable`) go to the refute stage instead of being dropped unread.
- Its hard drops still apply: already reported, self-retracted, contradicted by the diff or by the reply itself.
- Its note routing (docs, style, i18n, log, test advice) still applies.

**Refute stage**
- A verdict is `confirmed`, `refuted` or `uncertain`.
- A refutation must quote the code or doc text that prevents the defect. One without such a quote counts as uncertain.
- Quotes match token by token when not verbatim: every identifier must be on the line, but punctuation may differ.
- An uncertain candidate is posted at P2 only when its own evidence quotes real code (`local_review.pipeline_keep_uncertain`, default on).

**Downstream gate**
- The posted findings the verifier confirmed, or kept as uncertain, are handed to the leg gate as **trusted verified keys** (`FindingGateExtras.verifiedKeys`), and the gate does not re-judge their hedges and evidence.
- The keys are set only by Ashlar for its own local leg, never from model JSON.
- The hard drops still run.

**Posting cap.** The posting cap default is now 5.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `local_review.pipeline` | on | Off restores the grouped tool loop. |
| `local_review.pipeline_max_findings` | 5 | 1–8: the selection's cap. |
| `local_review.pipeline_verify_votes` | 1 | 1–3: refute turns per candidate. All must confirm. |
| `local_review.pipeline_lenses` | 3 | 1–3: candidate passes per feature (1 = one combined pass). |
| `local_review.pipeline_keep_uncertain` | on | Post an undecided candidate at P2 when its own quote is real code. |

## Measuring it with the real model

The tests use a mocked model. The real effect has to be measured on the machine that serves the local model, from the live Ashlar checkout, so the same settings and model are used:

```
GITHUB_TOKEN=… npm run replay:local -- --pr TheMetalabs/aicc-center#1251 --head <reviewed sha> --base <base sha> \
  --mode all --labels /path/to/fp-eval/index.json --save-snapshot /tmp/1251.json --out /tmp/1251-report.json
```

- `--mode all` runs the pipeline and the old loop on the same snapshot.
- `--expect` takes the defects a review must catch (`[{file, keywords}]`) and scores recall. `--cases` runs many heads in one go (`[{pr, head, expect?}]`) and prints totals.
- Each run scores the posted findings against the judged eval labels (valid / false_positive / unclear / unjudged).
- Later runs can use `--snapshot /tmp/1251.json` and skip GitHub.

The targets:
- the valid #1397 finding is still posted;
- fewer false positives than the gate alone (82% removed on peer18);
- about 1–2 posted findings per review, as with ChatGPT.
