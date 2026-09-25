# Review loop: operations runbook

The loop's state lives on GitHub (design §2b), but a fix round runs only in the server process. A deploy
or restart during a round cuts it: the PR's newest loop comment stays at FIXING
(`<!-- ashlar-loop-fixing … -->`) and the session stays active, with nothing running it.

## Deploy or restart

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
