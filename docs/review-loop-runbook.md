# Review loop: operations runbook

The loop's state lives on GitHub (design §2b), but a fix round runs only in the server process. A deploy
or restart during a round cuts it: the PR's newest loop comment stays at FIXING
(`<!-- ashlar-loop-fixing … -->`) and the session stays active, with nothing running it.

## Deploy or restart

**Deploy only with `npm run deploy:server`** (`scripts/deploy-server.sh`). It runs the FIXING and idle
gates below, before and right before the restart, and exits before touching the checkout or pm2 when
either fails. `--from-ref origin/<branch>` predeploys a PR head (detached); `--revert` returns to
`origin/main`; `--check` runs the gates only.

1. **Before any Ashlar deploy or restart, confirm 0 sessions at FIXING.**

   ```sh
   npm run loop:fixing -- TheMetalabs/Chatgpt-Code-Review-Github-Connect [owner/repo ...]
   # or: ASHLAR_LOOP_REPOS="owner/repo,owner/repo" npm run loop:fixing
   ```

   The script lists every open PR whose newest loop comment from the App is FIXING. It uses the
   server's own reader (`newestLoopComment` in `src/lib/review-loop.ts`).
   - Token: `GITHUB_TOKEN` or `GH_TOKEN`, else `gh auth token`.
   - Bot login: `ASHLAR_BOT_LOGIN`, as the server reads it.
   - Exit `0` prints `0 PRs at FIXING …`: safe to deploy.
   - Exit `1` prints one `FIXING owner/repo#N round=… head=… since=…` line per PR: do not deploy.
   - Exit `2` is a usage error or a failed read. The answer is unknown, so do not deploy.

2. **Never deploy while a PR is at FIXING.** Wait for the round to end, then run the check again. A
   round ends with a report and a continuation, a suggestion report, or a handoff. If you cannot wait,
   stop the loop first (kill switch ①).

3. **After a restart, re-issue `/review-loop <mode>` on any session that was cut.** Use `/review-loop`
   for suggest mode or `/review-loop apply` for apply mode.
   - When the loop is on, the server runs a boot sweep once (`sweepCutFixRounds`). It checks at most 20
     open PRs of the installed repositories.
   - The sweep closes each active session left at FIXING with a `loop-error` handoff. The handoff reads:
     "the server restarted during a fix round…". Each outcome is logged as `[review-loop] boot sweep …`.
   - The sweep ignores a session that was waiting on a review. For example, a continuation was posted
     but its review job was lost in the restart. If no review follows the continuation, re-issue the
     loop on that PR too.

## Kill switches

1. **① A stop comment on the PR** (`/review-loop stop`). The session ends and an in-flight round goes
   quiet: no commit and no ref update land after the stop. The App acknowledges it once with STOPPED.
2. **② Settings `fixAgent.mode = suggest` or `fixAgent.provider = none`.**
   - `suggest` downgrades every apply session to suggestions, so nothing is pushed.
   - `none` turns the loop off.
3. **③ Settings `fixAgent.enabled = false`.** This turns the loop off everywhere:
   - No loop step, start record or continuation runs.
   - The boot sweep makes no GitHub call.
   - The change applies to the next step without a restart. A step already waiting re-reads Settings
     when it is admitted.

## Operational lessons (#107–#124, 2026-09-26/27)

Lessons from running the loop on aicc-center with ChatGPT in Chrome. Each names where it lives in the
code, so a future skill or change can find the rule instead of re-learning it.

### Diagnose before fixing

- **One diagnosis beats several guesses.** Extension 1.1.38–1.1.45 went through guessed fixes. What
  worked: predeploy the PR head (server `deploy:server --from-ref`, extension: the coordinator's `ext_update.sh --from` on the host, outside this repo),
  run it once on sandbox PR #93, record the rejection condition in a probe, then fix from the evidence.
- **Keep the evidence locally, never the content in logs.** The extension keeps bounded snapshots in
  `chrome.storage.local` (`fixAnswerHtml`, `responseWaitHtml`, `uploadWaitHtml`, `presendStallHtml`,
  `fixHarvestProbes`, `pendingReviewJobs`); the server archives a rejected fix answer in
  `.data/review-history/fix-raw` and logs one shape-only `fix-answer` line per fix answer (#121):
  `mode blocks chars formatted fileLinks canvas truncated citations json=plain|cleaned|repaired|none`.
- **A parse failure's cause keeps changing.** On one PR (aicc #455) it was, in turn: no code block
  (#119), a block rendered without `<pre>` (#120), JSON outside a block rendered as Markdown (#119
  refuses it as `unfenced_rewritten`), and a citation marker inside a JSON string (#121). Read the
  `fix-answer` line and the snapshot first; do not assume the previous cause.

### The chat page changes under you

- **ChatGPT's DOM moves; read it through one compatibility layer.** Transcript turns lost
  `data-message-author-role` (`extension/turns.js`, #113); file chips are leaf-text spans (#113); a
  fenced block may render as `[data-markdown-copy=code-block] > code` with no `<pre>` (#120); a sent
  prompt renders as Markdown (backticks become `<code>`), so matching it must be Markdown-aware
  (#104, #116).
- **The model writes UI artifacts into its answer.** `:chatgpt-content-reference{index="N"}` appears
  inside JSON strings and its bare quotes break the JSON. The markers are removed only when the text does not parse as written: fix
  answers since #121, review answers since #122, which made it one constant (`CHAT_CITATION_MARKER`,
  `src/lib/extract-chat-json.ts`).
- **A temporary chat moves.** `/?temporary-chat=true` becomes `/c/<id>?temporary-chat=true` with a real
  navigation; the run is re-bound from a sessionStorage journal and the sent turn's evidence (#114).
- **Logged out is a state, not a stall.** A logged-out page fails at once as `logged_out` and pauses the
  provider (#108, #109); only the user can log in again.

### Every wait needs an end

- Bound every stage: pre-send stages (`presend_stalled`, #106), the upload wait (3 min, #111), send
  confirmation (60 s, #101), the response wait (35 min `response_timeout`, #116).
- **A retry loop must end too.** aicc #457 answered in 2 minutes, then its salvaged delivery was sent
  back for a JSON repair that would never run (the strict review schema rejects `raw_review`) every
  2.5 s for 3 h. The worker's own events kept the job fresh, so no stall sweep came back. A salvaged
  leg is now posted (the extension sends `salvaged: true`, `src/routes/api/bridge.ts` skips the repair gate for it), and a server that still refuses it
  ends the leg as `json_invalid` once (#122). A test's fake server that is laxer than the real route
  hides this class: mirror the real gate.

### The fix prompt: benchmark, do not invent

- Fix rules (`fixRules`, `src/lib/fix-agent.ts`) are adapted from the two review-loop skills, each with
  its source cited in a comment ([A] ashlar-review-loop, [C] codex-review-loop-to-convergence). A rule
  made up for one case is not added.
- What live fixes got wrong, and the rule that answers it: a false positive fixed (premise check, rule
  2, #117); a behavior changed while its test still pinned the old one (rule 9, #117); code relying on
  a callee's return value that does not exist, with a test mocking that non-existent contract (rule 9
  callee/mock/network clause, #123); work the PR body put out of scope added back (rule 13, #124).
- **The PR body's scope section reaches both prompts** (`src/lib/pr-scope.ts`, #124). Loop rounds are
  triggered by a bot comment, so the webhook text is not the PR body. Write scope under a heading
  (`## Scope`, `## 범위`, `## Out of scope`); it is untrusted and only narrows what a PR must add — a
  correctness or security defect in the changed code is never out of scope.
- Deliver large fix sources as a hashed attachment with one Markdown-free typed line (#100, #103), edits
  as search/replace against head content (#115), and fall back to the GitHub connector source when the
  attachment cannot be delivered (#107).

### Tabs

- **A temporary chat re-keys its id.** A review pins the first `/c/<id>?temporary-chat=true` it lands
  on (a `local-chatgpt:` id) and ChatGPT then moves it to the server id; the page and the worker follow
  that move on the same proof as a fix (#126). Before that, 126 of 131 reviews kept their tab as
  "navigated" and 85 tabs piled up.
- **Temporary-chat tabs of finished jobs are closed on a timer** (#126, user decision 2026-09-27: the
  user never uses temporary chats in this Chrome, so #82's "a touched tab is the user's" does not apply
  to them). `reclaimPreservedTabs` closes a temporary-chat tab Ashlar opened 10 min after its job left
  the worker registry, and the oldest finished ones first while more than 8 Ashlar temporary tabs are
  open. A job in progress, a tab with no Ashlar binding and any non-temporary conversation are never
  touched. Run it at once with the extension message `ashlar-reclaim-preserved`.
- **Grok review tabs are owned durably (1.1.72).** #169's reclaim names a leftover Grok tab only through
  its live page or session records, and a tab the worker kept (the page could not prove the close: Grok
  moved it to `/c/<id>` unpinned, or Chrome froze/discarded it) lost every session record when its leg
  retired, so 34 of 35 tabs piled up on the Studio. The worker now writes `ashlar:tabLedger`
  (storage.local, cleared on browser start) when it opens a Grok tab; `sweepGrokTabs` (every minute,
  and with `ashlar-reclaim-preserved`) closes ledger tabs no live leg works on: 5 min after a kept
  tab's leg ended, 10 min for an idle home page, 45 min for a tab whose job vanished. Never closed: tabs
  the ledger does not name, the active tab, a tab the page says the user took over (draft, follow-up,
  edit, regenerate). A stale `allocating` flag (older than 5 min) no longer holds a slot, and a leg
  without a tab slot for 60 min fails instead of idling claimed. Tab events (`tab_created`,
  `tab_closed`, `tab_preserved`, `tab_closed_by_sweep`, `tab_close_failed`, `cleanup_failed`,
  `allocating_reclaimed`, ...) ride the bridge ping into the server log as `[ashlar] tab-event ...`
  lines, and the worker status carries the ledger counts (`tabs`).
- **"edited" needs user input (1.1.73).** A review's `edited` verdict was decided by DOM text alone, and
  Grok re-renders a sent prompt (Markdown) once its answer completes, so all 5 Grok legs of the
  2026-10-20 locked-screen run ended `tab_preserved cause=edited` and 1.1.72 released them from the
  ledger as the user's. On a Grok review the page now counts a rendered-text difference as an edit only
  after TRUSTED input that could change the conversation (`isTrusted` typing/paste/drop into an editable
  area, or a press on an edit/regenerate control) made after the run's send was confirmed
  (`sentAt` in the journal), kept per job and run in sessionStorage; Ashlar's synthetic clicks, bare
  pointer events and Grok's rendering produce none. The can-close reply
  carries `userInput` and `renderDiffers` (history/log event `turn_render_differs`). A preserved
  `edited`/`regenerated` leg whose page reports `userInput:false` stays in the ledger and is swept.
  ChatGPT and fix runs keep the DOM-only verdict.
- **Partial and raw Grok answers (1.1.73).** The raw observation texts of the 2026-10-20 run (jobs 1330,
  1250, 1314, 1387) were the sender label alone, a reply cut off mid array, and LaTeX inside a JSON
  string. `final:false` on an observation says nothing (the server writes it on every one), and the
  `cause=edited` cleanup follows a captured source; it does not end the leg. Fixes: a Grok bubble that
  holds only UI labels ("Grok", "×N", "JSON") is not an answer and those leading labels are stripped; an
  incomplete structured answer is handed on as truncated only after standing still 45 s with the stream
  gone; the review JSON is read from the code block literally (a folded block's hidden tail included)
  before the rendered text; a close is held back (`cause: generating`) while Grok's stop control is up;
  and a review string with invalid escapes (`\ldots`, `\(`, a raw newline) is read again with those made
  literal after the strict parse failed (`repairJsonEscapes`, extension and server).
- **Cut-off replies, both providers (1.1.74).** All 24 raw captures of 2026-10-20 (18 ChatGPT, 6 Grok;
  real texts in `tests/review/fixtures/raw-capture-20261020`) were reviews that stopped inside their last
  array, `coverage`, after the verdict and every finding had arrived, and the page called them complete
  (`response_completed_json_invalid`), so every review posted raw. Now: a partial review object is not
  `done` for ChatGPT either until its text stood still 45 s with the stream gone (`reviewDoneSettled`,
  one clock per run + response); then `recoverTruncatedReviewJson` keeps the verdict and ALL findings,
  the whole coverage entries, closes the open string/array/object and marks `truncated: true` (labels,
  an unclosed fence, an `<escape>` tag before `{` and a missing `[` after `"coverage":` are tolerated).
  A reply cut inside `findings` is never recovered (`classifyReviewText` says `truncated`). The server
  recovers the same way for salvaged or late text. A truncated leg with findings is a verdict (they
  merge); one without is evidence, never clean (`RawCause` `truncated`). A malformed auxiliary leg
  beside a CLEAN canonical verdict is no longer dropped (aicc-center#1091): its reply posts verbatim
  and the review is not "no major issues". Inside a verify-clean round the malformed auxiliary reply's
  TEXT stays out of the posted body, but it is never clean credit: the round posts `incomplete` (no
  "no major issues", no `total=0` marker, note "<provider> returned no usable review") whatever local
  verification said, and a recovered truncated auxiliary leg's findings merge and block clean exactly as
  elsewhere. `repairJsonEscapes` escapes every control character U+0000-U+001F.

### Deploys

- Server: only `npm run deploy:server` (#118). A hand-built `a && b; c` chain once restarted the server
  while aicc #439 was at FIXING. Run the script from inside the live checkout.
- Extension and server PRs are predeployed before merge. When both change, deploy the server first
  (#122: extension 1.1.52 against an older server ends a salvaged leg as a failure instead of posting
  it).
- **JSON conversion rate (1.1.75).** Over the 163 raw/failed legs of 2026-10-06..10-20
  (`tests/review/fixtures/raw-corpus-v2`, `tests/review/raw-corpus-v2.test.mjs`): (1) format-only
  normalization (`normalizeReviewFormat`, extension and server): a bare `"` inside a string that cannot end
  it (shell / UI text) is escaped, a missing `[` after the root's `"findings":` is supplied, text after the
  root is dropped; no word of the reply changes. The server also re-reads a worker's salvage envelope from
  its page text before posting it verbatim. (2) Gate rule (Horim): a reply cut off in `coverage` after a
  complete verdict whose `findings` array is complete, closed and EMPTY and whose merge_recommendation is
  not REQUEST_CHANGES is that reviewer's verdict: the review's first line is "Didn't find any major
  issues." (the gate passes), a "Coverage incomplete" note names the reviewer and posts its reply verbatim
  (redacted from the public snapshot), the coverage marker carries `incomplete=<providers>` and the
  findings marker `coverage=incomplete` (`Job.coverageCutProviders`). It must still pass the gate as it is
  (an empty reply without investigated_safe stays an Instant-tier skip). A reply cut before or inside its
  findings, or REQUEST_CHANGES with no finding, stays raw / incomplete (aicc-center#1091). (3) Prompt: one
  JSON object only, every inner `"` escaped, keys in order with `findings` before `coverage`.
