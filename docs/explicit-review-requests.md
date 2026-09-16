# Explicit review requests

## Behavior

An explicit configured mention (by default `@ashlar-bot` or `/review`) is a new
review request regardless of PR lifecycle state: open, draft, closed or merged.
The `skipDrafts` setting still suppresses unsolicited draft events; it does not
suppress an explicit request. Authentication, HMAC validation, the configured
fork trust policy and GitHub access controls are unchanged. A locked or
inaccessible repository can still reject the API operation: a command does not
grant additional permissions.

A new request is also accepted after an earlier job was posted, skipped, failed
(`dlq`) or cancelled, even at the same head SHA. The prior job is not revived.
If a review is still in flight, the existing explicit-supersession policy remains:
a new command cancels that old job and creates a separate one. Redelivery with the
same GitHub delivery ID does not create runnable work or supersede the active job.

## Supported input

- A top-level PR comment, including an edited comment containing a mention.
- An inline review comment, created or edited, containing a mention.
- A PR description containing a mention when the PR is opened.
- A description edit that newly introduces a mention. The previous value comes
  from GitHub's `changes.body.from`; null is treated as a previously empty body.
  It also works when the PR is already closed or merged.

A mention is recognized using the current configured username and mention tokens,
with the existing token-boundary rules. Matching happens before preview truncation;
the HTTP webhook body size limit remains in place. Bodies and comments remain
untrusted prompt material and cannot replace review policy.

An existing mention is **not** a subscription to future pushes. Synchronize,
reopen, ready-for-review and unrelated edits do not repeat a previous body request.
To request another review, create a new comment or remove and then re-add the body
mention. A title-only edit, a removed mention, a malformed edit without its old
body and an unmentioned PR never authorize model work.

## Why the eyes-only draft symptom occurred

Issue-comment payloads do not carry the PR's draft flag. The old parser initialized
it to false, ingress accepted the job, and the worker added an eyes reaction before
fetching the real PR metadata. After fetching it, a second unconditional
`skipDrafts` check skipped even an explicit request, without an explanatory status
comment. This is a code-reproduced path, not confirmation of an inaccessible
production log or runtime setting.

Ingress and the post-fetch worker now share `reviewSkipReason`. Fork policy is
checked before snapshot reads as well as afterwards. The eyes reaction is added
only once the job has a valid snapshot and enters `awaiting_chat`. Status comments
include its dashboard job ID, and late policy rejection or snapshot errors report
an explicit reason instead of leaving only the initial eyes acknowledgement.

## Deployment and tests

Deploy the **server** change. No Chrome extension update is required for admission.
Keep the GitHub App subscribed to pull requests, issue comments and pull request
review comments. No PAT replacement or new permissions are required by this change.
Already skipped deliveries are not retroactively rerun; use a new explicit request
after deployment. This PR does not re-open, undraft, close or merge the target PR.
It adds no elapsed-time limit to queueing, generation or collection.

Run:

```sh
npm run test:review-regressions
node --experimental-vm-modules --test tests/review/mentions.e2e.mjs
npm run test:lib
npm run typecheck
npm run build:dev
```

The mention integration suite sends HMAC-signed HTTP webhooks through the production
parser, ingress, worker and bridge. GitHub I/O/settings persistence and watcher
cadence are fixture adapters; no paid model request or production PR mutation is
performed. It verifies admission, bridge claim, final JSON submission and review
posting in those fixtures. It is not a live installed-bot test of the user's PR.

## Unknown head-repository provenance

A missing or null `head.repo` (or a missing/non-boolean `fork` flag) is stored as
`isFork: null`, never inferred from the destination `repository.fork`. Issue
comments likewise have unknown head provenance until PR metadata is fetched.

Ingress can queue an explicit request for metadata resolution. Even when the
webhook already supplies both commit SHAs, the worker resolves unknown provenance
before loading source files, acknowledging with eyes, or exposing reviewer work.
With `skipForks` enabled, a confirmed fork or still-unknown head is skipped with an
operational explanation. A confirmed non-fork proceeds normally, including for a
draft/closed/merged PR. Metadata-only resolution preserves the webhook's pinned
SHAs. Disabling `skipForks` explicitly allows unresolved provenance; signature
validation, mention gating, delivery deduplication and access checks still apply.
