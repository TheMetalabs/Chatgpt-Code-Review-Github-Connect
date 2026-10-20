# Real Ashlar raw-review cases — 2026-10-20 (after #171 db6d921c merge, 11:22 KST)
Source: Mac-Studio /Users/ai/work/Chatgpt-Code-Review-Github-Connect/.data/review-history/jobs/<hash>/
- <job>.json          = observation-grok.json   (Grok raw harvested text, field `text`)
- <job>.chatgpt.json  = observation-chatgpt.json (ChatGPT raw harvested text)
- <job>.log           = pm2 lines for the job (only tab-event lines exist in pm2)
- jobs/<job>/         = full job dir (meta, steps timeline, capture, repair, response-*, review)
- index.tsv           = job, hash, repo, pr, headSha, posted KST, githubReviewId, grokRaw, chatgptRaw, verbatimPosted, providerVersions
- analysis.json       = per-case strict/fence/brace/balanced parse results
ALL cases: observation final=false, extension providerVersions 1.1.72 (1.1.73 never loaded in Chrome),
text ends mid-"coverage" array (truncated harvest). 1.1.73 extension + server extractChatJson both return null on every case.
Extra classes: leading "JSON"/"Grok...JSON" label (rendered code-block header), "```json" open fence w/o close,
"<escape>" tag before "{" (job-mvg35r08-155), missing "[" after "coverage": (Grok, no code block: 854, 466).
