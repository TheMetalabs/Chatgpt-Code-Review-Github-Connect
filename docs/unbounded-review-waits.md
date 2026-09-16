# Unbounded review waits (extension 1.1.17)

## Reported symptoms and verified code paths

The reported `job-mu3v54le-2` ended with `empty: ChatGPT finished without review
JSON`; the extension also showed `Last work error: signal timed out`. These are
separate paths on main 4c14d45 / 1.1.16:

* `api()` created `AbortSignal.timeout(10_000)` on every bridge request. `complete`
  waited for `submitHarborChat`, including a fresh source snapshot and GitHub
  publication, even though its result had already been stored. Slow downstream
  work could therefore outlast the client timer after model generation ended.
* The DOM loop threw `empty` on its sixth no-JSON poll (800 ms cadence), even for
  changing content or an unobservable response. Reading only the first markdown
  child and using detached clone textContent also missed later JSON/added hidden
  duplicate text. Earlier proposed parsing changes were not on this base.
* Actual Local review generation already used native HTTP with no socket/application
  deadline. A separate `/models` health probe still had five seconds. The unused
  sample xAI tool-agent path had a separate 25-second generation deadline. None of
  this proves which upstream/proxy caused an individual Local error in production.

These are reproduced code defects, not a claim to have read the user's browser
storage, exact failed response, reverse-proxy logs or deployed build.

## Changes

No application abort timer is created for bridge requests, content message replies,
Local generation/health checks or the sample tool agent. Explicit caller cancellation
is preserved. Poll intervals, job lease freshness, provider quota cooldowns, token/turn
budgets and memory size bounds are NOT model-generation deadlines and are unchanged.
Real network failures, HTTP errors and completed Local protocol errors remain errors;
we never silently start another paid model call after an ambiguous network result.

The bridge acknowledges stored results without awaiting validation/GitHub publication.
The existing watcher, validator status lock and idempotent result check own processing.
Later publication failure remains visible in job state/bridge diagnostics; receipt does
not mean GitHub publication succeeded. Storage is still Harbor's **process memory**,
not a new durable database; this patch does not promise survival of a backend restart.

The page reads the entire current assistant message, excluding hidden/control nodes,
and preserves text boundaries. A current completion signal and stable valid JSON are
required for success. There is no no-JSON poll counter. Blank, changing or unparseable
UI content stays pending indefinitely; actual quota errors remain terminal. A completed
non-JSON answer can require operator correction/cancellation rather than an automatic
new prompt. Explicitly completed invalid Local HTTP responses remain distinguishable:
a single semantic correction is allowed only after EOF, not after elapsed time.

A job/provider/run-bound local observation retains up to 128,000 characters and reports
`waiting_for_json`/`waiting_for_response`. Truncation is explicit. It is never submitted
as a final review or exposed in normal worker diagnostics. The popup adds `JSON pending`
and labels historical errors as previous, not live model completion. Transport failures
identify the bridge action/job and that pending work is preserved; successful result
receipt clears the matching retry diagnostic. No system clipboard output collection.
This is not the previously proposed server original-response archive/dashboard feature.

Parallel scheduling, independent heartbeat lanes, request identities, response outboxes,
ACK-gated tab cleanup and tab-capacity limits from #33–#36 are retained. A delayed job
cannot occupy another job's progress/heartbeat lane, and a lost delivery never resends
the model prompt.

## Verification and deployment

New tests exercise eight-hour waits before headers and during bodies, delayed content
ACK, slow GitHub publication separated from receipt, duplicate receipt, non-JSON DOM,
late second-markdown JSON, hidden duplicate text, explicit cancellation and transient
network failures. The existing Local HTTP test holds real loopback requests across
simulated day-long clock advances and checks a zero socket timeout. Large time advances
are virtual-time tests, not real eight-hour model runs. Controlled GitHub/model fixtures
are not signed-in production E2E.

Run `npm run test:review-regressions`,
`node --experimental-vm-modules --test tests/review/long-wait.e2e.mjs`, and the existing
Chromium DOM/MV3 suites. CI also runs full tests, typecheck and build.

Deploy the server, then update/reload the **same** unpacked extension folder to 1.1.17.
Do not reinstall/reset extension storage while pending replies exist. Restarting the
backend still loses its in-memory Jobs. Already skipped historical jobs are not silently
revived; use a fresh explicit mention after rollout for a new request.

Browser service-worker/network limits, the model server, reverse proxy, load balancer
or hosting platform can still close a connection. Removing an application deadline
cannot disable those external limits. For long nonstreaming Local generations, use an
upstream route capable of waiting for that completion; do not label its HTTP 504 or
connection reset as a model-generated empty answer. A six-hour fetch alone would not
solve a shorter proxy/worker limit, which is why the bridge receipt is kept independent
of model/validation/publication duration rather than just enlarged to six hours.

## Operator-provided response example

The pasted HTML sample is JSON rendered inside one paragraph with `<br>` separators,
inline emphasis and nested file-citation controls. In offline Chromium the original
first-markdown extractor parses that standalone sample (two findings and
`REQUEST_CHANGES`), but misses it when a prose markdown block precedes it. The repaired
extractor succeeds in both arrangements, removes citation UI without deleting actual
evidence text, and decodes `&gt;` to `>` through the browser DOM. This does not prove
the production failure used the same wrapper/DOM layout or timeout path.

The actual sample was checked locally; only a synthetic version of its DOM structure
is committed. No original repository findings, file IDs or full transcript are put in
public test fixtures. The extracted text is rendered response text, not a promise to
reconstruct Markdown source markers consumed by ChatGPT's rendering (e.g. emphasis).
