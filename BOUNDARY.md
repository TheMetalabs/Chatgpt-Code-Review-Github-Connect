# Edit boundary — local-LLM multi-turn work

This branch (`ai/feat/local-llm-multiturn`) changes **only the local-LLM reviewer leg**.
The ChatGPT / Grok / Chrome-bridge path and the shared merge/posting path are **frozen**.
`npm run check:boundary` enforces this mechanically (default-deny): the run fails if any
changed file is outside the allowlist below.

> **Scope extension — reviewer-context tailoring (`ai/feat/reviewer-context-tailoring`).**
> A later change deliberately improves the **context each reviewer sees**, tailored to its
> mechanism: the multi-turn local loop now pulls any head file on demand (`readFileAtHead`), and
> the one-shot chat legs get pre-attached cross-file definitions plus whole-file (not over-sliced)
> repo policy. That necessarily edits the shared **context-assembly** files
> (`context-slice.ts`, `chat-prompt.ts`, `github-snapshot.ts`, `github.server.ts`,
> `import-resolve.ts`), now on the allowlist. What stays **frozen**: the bridge/submission path
> (`bridge*.ts`, `chat-settle.ts`, `quota-hit.ts`, `composer-has.ts`), the merge/posting path
> (`poster.ts`, `review-diff.ts`, `review-format.ts`, `findings-thin.ts`), and `extension/**`.
> Prompt *semantics*, submission, settlement, and schema-merge are unchanged — only what context
> is gathered/attached. The full `npm test` suite is the behavioral net for the frozen path.

## Why

The local leg runs through the OpenAI-compatible SDK/HTTP transport, so it can do a
multi-turn tool loop that the browser-tab reviewers cannot. That work must not alter how
ChatGPT/Grok build prompts, submit through the bridge, settle, de-quota, or how reviewer
JSON is schema-merged and posted. Those are a separate, already-shipped concern and are
being changed by other sessions in parallel.

The heartbeat follow-up (`ai/feat/local-llm-heartbeat`) extends the allowlist by exactly one
shared file, `reviewer-progress.ts`, and touches **only** its local-provider in-flight branch
so the local lane can surface heartbeat freshness the way the chat lanes already surface
per-step progress. The chat/Grok branches of `buildReviewerLanes` are unchanged; the existing
chat-lane cases in `reviewer-progress.test.ts` are the regression net that proves it.

The queue-aware follow-up (`ai/fix/local-leg-queue-aware-no-deadline`) removes the fixed
20-minute local deadline (a queued multi-turn review on a concurrency-1 server legitimately takes
hours) and replaces it with visibility: the transport streams `chat/completions` and reports
keepalive vs output, a new local-only tracker (`local-leg-activity.ts`) turns that into
`local_queued` / `local_generating` progress, and lanes / ops notes tell "queued at the server"
from "no response". It adds exactly two local stage labels and the optional `keepaliveAt` stamp
to `review-progress.ts`, and two `local.*` server steps to `review-history.server.ts`; chat/bridge
stages and step recording are unchanged.

## Editable (local-LLM only) — the allowlist

| File | Allowed change |
| --- | --- |
| `src/lib/local-llm.server.ts` | the local reviewer entry (`runLocalLlm`, `pingLocalLlm`) |
| `src/lib/local-chat-request.server.ts` | the native transport (add `max_tokens`, sampling, streaming) |
| `src/lib/local-review-loop.server.ts` | **new** — the multi-turn tool loop |
| `src/lib/local-fallback.ts` | local race/skip predicates (no chat semantics) |
| `src/lib/harbor.server.ts` | **only** `kickLocalRace` / `attachLocalLeg` and local settings plumbing |
| `src/lib/reviewer-progress.ts` | **only** the local provider's in-flight lane (heartbeat freshness); chat/Grok branches stay frozen |
| `src/lib/reviewer-progress.test.ts` | local-lane rendering tests (chat-lane cases are the frozen-behavior guard) |
| `src/lib/local-leg-activity.ts` (+ test) | **new** — local-leg liveness tracker + `ASHLAR_LOCAL_REVIEW_DEADLINE_MS` |
| `src/lib/local-status.server.ts` (+ test) | **new** — polls the model server's `/api/status`; skips a local leg the server has no record of (0 active AND 0 queued) so a lost request never hangs the peers' post (`ASHLAR_LOCAL_IDLE_SKIP`) |
| `src/lib/review-progress.ts` | **only** the `local_queued` / `local_generating` labels and the optional `keepaliveAt` field |
| `src/lib/review-history.server.ts` | **only** the `local.accepted` / `local.generating` server-step names |
| `src/lib/settings.server.ts` | **only** local-LLM settings (`localLlm*`, `reviewLocal`) |
| `src/lib/types.ts` | **only** local-LLM settings fields + `DEFAULT_SETTINGS` local values |
| `src/lib/json-repair.server.ts` | **only** the transport call options (`max_tokens`) |
| `src/routes/api/harbor.ts` | **only** the Playground `local` action |
| tests: `src/lib/local-llm.test.ts`, `tests/review/local-loop.test.mjs`, `tests/review/local*.test.mjs`, `src/lib/settings.server.test.ts` | local-leg tests |
| `BOUNDARY.md`, `scripts/check-local-llm-boundary.mjs`, `package.json`, `README.md` | boundary infra + docs |

## Frozen — must not change (guard fails if touched)

Everything else, notably:

- `src/lib/chat-prompt.ts` — the reviewer prompt/attachments (shared; imported read-only).
- `src/lib/bridge.server.ts`, `bridge-token.ts`, `bridge-worker-status.ts` — the Chrome bridge.
- `src/lib/chat-settle.ts`, `quota-hit.ts`, `composer-has.ts`, `reasoning.ts`, `overlay-dismiss.ts` — browser settlement.
- `src/lib/poster.ts`, `review-diff.ts`, `review-format.ts`, `review-json-repair.ts`, `findings-thin.ts` — merge + posting.
- `src/lib/extract-chat-json.ts` — shared JSON extraction (imported read-only).
- `extension/**` — the Chrome extension.
- `src/lib/github*.ts`, `ingress.ts`, `ops-comment.ts`, and the rest of `src/`.

## Guarantee for the ChatGPT/Grok path (regression prevention)

1. **Shared modules stay byte-frozen.** `chat-prompt.ts`, `bridge.server.ts`, `poster.ts`,
   `extract-chat-json.ts` etc. are not in the allowlist, so a single edit fails the guard.
2. **Shared config files are partial-edit.** `types.ts`, `settings.server.ts`,
   `harbor.server.ts`, `json-repair.server.ts` are editable but only for local-LLM lines;
   the full `npm test` suite (chat prompt, bridge, submission, mentions, parallel, poster,
   review-diff) must stay green as the behavioral net.
3. **The local leg never blocks the chat legs.** A local failure still ends as
   `Skipped local (...)`; reviewers remain independent and non-cross-checking.

## Gate before every commit

```
npm run check:boundary   # only allowlisted files changed
npm test                 # ChatGPT/Grok/bridge/merge behavior unchanged (baseline: 221 pass)
npm run typecheck        # 0 errors
```
