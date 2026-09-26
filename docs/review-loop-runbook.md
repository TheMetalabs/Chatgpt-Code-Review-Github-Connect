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

### Deploys

- Server: only `npm run deploy:server` (#118). A hand-built `a && b; c` chain once restarted the server
  while aicc #439 was at FIXING. Run the script from inside the live checkout.
- Extension and server PRs are predeployed before merge. When both change, deploy the server first
  (#122: extension 1.1.52 against an older server ends a salvaged leg as a failure instead of posting
  it).
