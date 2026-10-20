# Ashlar raw/failed-leg corpus v2 (2026-10-06 .. 2026-10-20 18:39 KST)
Source: Mac-Studio Chatgpt-Code-Review-Github-Connect/.data/review-history/jobs (snapshot 18:52 KST, copy in src/).
A case = one (job, provider) leg that was salvaged (response json = raw_review envelope) or named in the
posted body as "No complete review from <leg> (reply posted as evidence)". Includes legs dropped silently
beside a clean/findings body (pre-#172), and cancelled/awaiting jobs that never posted.
- <job>.<provider>.txt  full text: response.original (what the extension submitted); local legs w/o original use stored json
- index.json            per-case metadata + classes + main@ebb1cdcf parser result
- summary.json          counts / per-class conversion
- tools/build.py, classify.py, finalize.py (python), eval.ts (bun; imports src/lib/extract-chat-json.ts +
  review-json-repair.ts inspectReviewFormat and extension/json.js parser section via vm)
"converted" = extractChatJsonRecovering(text) non-null AND inspectReviewFormat(review).ok (server canonicalLegRaw path).
"structured" = converted and NOT (truncated:true with 0 findings) — gateLeg on main still posts those as raw evidence.
in_old24 = already in tests/review/fixtures/raw-capture-20261020 (PR #172).
