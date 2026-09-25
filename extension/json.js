function isReviewObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "findings" in value || "merge_recommendation" in value || "keep" in value;
}

function parseReviewSlice(slice) {
  try {
    const parsed = JSON.parse(slice);
    return isReviewObject(parsed) ? slice : null;
  } catch {
    return null;
  }
}

function lastReviewJson(text) {
  const s = String(text || "");
  for (let end = s.lastIndexOf("}"); end >= 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i -= 1) {
      const c = s[i];
      if (c === '"') {
        let slashes = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "}") depth += 1;
      else if (c === "{") {
        depth -= 1;
        if (depth === 0) {
          const hit = parseReviewSlice(s.slice(i, end + 1));
          if (hit) return hit;
          break;
        }
      }
    }
  }
  return null;
}

function extractChatJson(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  // The last complete object wins, not an older fenced example.
  return lastReviewJson(s);
}

/** Whether `node` itself is hidden from the reader: the ONE visibility rule every harvest shares
 * (review corpus, fix code blocks): hidden, aria-hidden, template, display:none,
 * visibility:hidden, opacity 0. */
function hiddenNode(node) {
  if (node.matches?.("[hidden], [aria-hidden='true'], template")) return true;
  const style = globalThis.window?.getComputedStyle ? window.getComputedStyle(node) : null;
  return Boolean(style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0));
}

/** The text a reader sees in `el`: every hidden descendant, control and reference marker is
 * dropped (a detached clone's textContent includes hidden duplicate text). */
function visibleText(el) {
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.matches("button, [role='button'], svg, script, style, [data-content-reference-start]") || hiddenNode(node)) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(walk).join("");
    return /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.tagName) ? `\n${text}\n` : text;
  };
  return el ? walk(el).trim() : "";
}

/** Read all rendered blocks from the current assistant message; the first markdown may be prose. */
function cleanTurnText(el) {
  return visibleText(el);
}

function assistantCorpus(root = currentAssistantRoot()) {
  if (!root) return [];
  const turns = root.matches('[data-message-author-role="assistant"]')
    ? [root]
    : [...root.querySelectorAll('[data-message-author-role="assistant"]')];
  const chunks = [];
  for (const turn of turns) {
    const text = cleanTurnText(turn);
    if (text) chunks.push(text);
  }
  return chunks;
}

/** The fenced code blocks of the assistant turn(s) as LITERAL text. A fix answer carries file
 * content, and rendered markdown rewrites it (backslash escapes, emphasis, links) while it still
 * parses as JSON, so a fix is read from code blocks only. */
function assistantCodeBlocks(root = currentAssistantRoot()) {
  if (!root) return [];
  const turns = root.matches('[data-message-author-role="assistant"]')
    ? [root]
    : [...root.querySelectorAll('[data-message-author-role="assistant"]')];
  const blocks = [];
  for (const turn of turns) {
    for (const pre of turn.querySelectorAll("pre")) {
      if (!renderedIn(pre, turn)) continue; // a hidden/stale block the renderer kept is not the answer
      // Only a code element that is itself visible is the answer (a renderer can keep a stale,
      // hidden <code> beside the live one); a block whose code is all hidden yields nothing. Its
      // text is read with the same visibility rule as a review's corpus (visibleText).
      const codes = [...pre.querySelectorAll("code")];
      const visible = codes.length ? codes.filter(code => renderedIn(code, turn) && !codes.some(outer => outer !== code && outer.contains(code))) : [pre];
      for (const source of visible) {
        const text = visibleText(source);
        if (text) blocks.push(text);
      }
    }
  }
  return blocks;
}

/** Whether `el` and every ancestor up to `root` is visible (hiddenNode). */
function renderedIn(el, root) {
  for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
    if (hiddenNode(node)) return false;
  }
  return true;
}

/** A bound response's canonical answer text, what its collector harvested and what every later
 * completion proof must match: a review's full rendered corpus, a fix's fenced code only (or a
 * fixed no-JSON line when it has none, so the server's fix parser fails closed). */
function boundAnswerText(kind, root) {
  const prose = assistantCorpus(root).join("\n\n");
  if (kind !== "fix" || !prose.trim()) return prose;
  const blocks = assistantCodeBlocks(root);
  return blocks.length ? blocks.join("\n\n") : "(no fenced code block in the answer; the fix JSON must be inside a ```json fence)";
}

function harvestJson(opts) {
  const allowThin = Boolean(opts && opts.allowThin);
  const chunks = assistantCorpus(opts?.root);
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const hit = extractChatJson(chunks[i]);
    if (hit && (allowThin || !findingsJsonTooThin(hit))) return hit;
  }
  const hit = extractChatJson(chunks.join("\n"));
  if (hit && (allowThin || !findingsJsonTooThin(hit))) return hit;
  return null;
}

/** Metadata only. The browser journal survives reload; raw text is not a step log. */
function recordReviewStep(stage) {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.jobId || !state.runId) return;
  const key = `ashlar:steps:${state.jobId}:${state.runId}`;
  if (!state.steps) {
    try { state.steps = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { /* local journal unavailable */ }
    if (!state.steps || !Array.isArray(state.steps.events)) state.steps = {sequence: 0, events: []};
  }
  if (state.steps.events.at(-1)?.stage === stage) return;
  const event = {source: "page", sequence: ++state.steps.sequence, stage, at: Date.now()};
  state.steps.events = [...state.steps.events, event].slice(-128);
  try { sessionStorage.setItem(key, JSON.stringify(state.steps)); } catch { state.steps.persistenceError = true; }
}

function reviewProgress() {
  const state = globalThis.__ashlarRunnerState;
  return state?.steps ? {runId: state.runId, events: state.steps.events, sequence: state.steps.sequence,
    observedAt: Date.now(), persistenceError: Boolean(state.steps.persistenceError || state.submissionPersistencePending)} : undefined;
}

/** Scope to the response after the confirmed user message and before any later
 * user turn. A known ID disappearing never authorizes fallback to the newest chat.
 * Older pages without IDs require both the recorded position and matching text.
 */
function boundReviewResponse(submission) {
  const messages = [...document.querySelectorAll('[data-message-author-role]')]
    .filter(node => ["user", "assistant"].includes(node.getAttribute("data-message-author-role")));
  const users = messages.filter(node => node.getAttribute("data-message-author-role") === "user");
  let user;
  if (submission.messageId) {
    const matches = users.filter(node => node.getAttribute("data-message-id") === submission.messageId);
    if (matches.length === 1) user = matches[0];
  } else if (Number.isSafeInteger(submission.submittedUsers) && submission.submittedUsers > submission.baseline) {
    user = users[submission.submittedUsers - 1];
  }
  if (!user || !submission.expected || !normalizePrompt(typeof messagePromptText === "function" ? messagePromptText(user) : user.textContent || user.innerText).includes(submission.expected)) {
    return {root: null, followup: false, identified: false};
  }
  // Some renderers assign message IDs after mounting the text. Pin that identity
  // when it appears rather than staying on the weaker positional fallback. A journal
  // that carries its conversation (a fix's or a review's, recorded at send or pinned
  // by a new-chat review) records it only while the page still shows that
  // conversation (samePage: the query is not the page): after an in-page move the
  // turn at the recorded position proves nothing about the send. A journal with no
  // conversation yet (a review on a new chat before its pin): unchanged.
  if (!submission.messageId && user.getAttribute("data-message-id") &&
      (!submission.conversation || fixConversationHolds(submission))) {
    submission.messageId = user.getAttribute("data-message-id");
    const state = globalThis.__ashlarRunnerState;
    if (state?.confirmedSubmission?.record === submission) {
      state.submissionPersistencePending = true;
      if (typeof retrySubmissionPersistence === "function") retrySubmissionPersistence();
    }
  }
  const start = messages.indexOf(user) + 1;
  const next = messages.findIndex((node, index) => index >= start && node.getAttribute("data-message-author-role") === "user");
  const replies = messages.slice(start, next < 0 ? messages.length : next);
  const message = replies.at(-1);
  if (!message) return {root: null, followup: next >= 0, identified: true};
  const container = message.closest('[data-testid^="conversation-turn-"], article, section');
  // Completion controls may be siblings of the assistant node. A surrounding root
  // is safe only when it contains no user or unrelated response messages.
  const root = container && [...container.querySelectorAll('[data-message-author-role]')].every(node => replies.includes(node))
    ? container : message;
  return {root, followup: next >= 0, identified: true, responseId: message.getAttribute("data-message-id") || "", message};
}

/** Each call is a fresh observation; the tracker also runs after native JSON
 * collection, when a late response ID or a 422 needs a stable full source.
 * Missing identity/completion resets evidence rather than reviving a stale cache.
 */
function trackCompletedSource(state, bound, done, text = "") {
  if (!done || !bound?.identified || !bound.root || !bound.responseId ||
      !text.trim() || text.length > 500_000) {
    state.completionTracking = undefined;
    state.completedSource = undefined;
    return null;
  }
  const previous = state.completionTracking;
  const count = previous?.text === text && previous.responseId === bound.responseId
    ? Math.min(previous.count + 1, 2) : 1;
  state.completionTracking = {text, responseId: bound.responseId, count};
  state.completedSource = count >= 2 ? {text, responseId: bound.responseId} : undefined;
  return state.completedSource || null;
}

/** Private full source, requested only by the owning worker's repair lane.
 * Stable content is additional evidence, NEVER a replacement for completion controls.
 */
function currentRepairSource() {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.jobId || !state.runId) return null;
  const unavailable = () => {
    trackCompletedSource(state, null, false);
    if (state.repairProbeTracker) trackCompletedSource(state.repairProbeTracker, null, false);
    return null;
  };
  let submission;
  try { submission = state.confirmedSubmission?.record || savedSubmission(); }
  catch { return unavailable(); }
  if (submission?.phase !== "sent") return unavailable();
  const bound = boundReviewResponse(submission);
  if (!bound.identified || !bound.root || !bound.responseId) return unavailable();
  if (bound.followup) { state.tabRepurposed = true; state.takeoverCause ||= "user_turn"; }
  const stop = bound.followup ? stopButtonVisible(bound.root) : stopButtonVisible();
  const done = !stop && !responseStreaming(bound.root) && replyDoneVisible(bound.root);
  const text = done ? assistantCorpus(bound.root).join("\n\n") : "";
  if (!done || !text.trim() || text.length > 500_000) return unavailable();
  // A replaced listener is not a replaced async invocation. Only a collector
  // which entered the tracking-capable loop can own these observations.
  const owner = state.sourceTrackingOwner;
  const tracksSource = owner?.jobId === state.jobId && owner.runId === state.runId && owner.provider === state.provider;
  // Unknown/legacy running loops may still mutate their old tracking fields.
  // Keep probe observations separate so two different producers cannot combine
  // first sightings into a stable source during a listener-only upgrade.
  const tracker = state.running && !tracksSource ? (state.repairProbeTracker ||= {}) : state;
  if (!state.running || !tracksSource) trackCompletedSource(tracker, bound, done, text);
  if (tracker.completedSource?.text !== text || tracker.completedSource.responseId !== bound.responseId) return null;
  // The regeneration pager as it was when this completed source was first taken: an answer secured by
  // a capture or a repair (ashlar-capture-accepted / ashlar-repair-accepted read it here) never
  // settled in the native collector, which records it otherwise (settleStableAnswer). Kept once.
  if (typeof state.collectedVariant !== "string") state.collectedVariant = responseVariant(bound.root);
  return {text, totalChars:text.length, truncated:false, responseId:bound.responseId, context:reviewPageContext(), completed:true, stable:true};
}

/** A source archive receipt pins the original response separately from mutable collector
 * fields. Capture is NOT parsed JSON.
 */
function sourceReceiptFor(state) {
  const value = state?.captureReceipt;
  return value && value.jobId === state.jobId && value.runId === state.runId && value.provider === state.provider ? value : null;
}
function nativeCleanupProof(state) {
  const proof = state.nativeCompletion;
  return proof?.responseId && proof.jobId === state.jobId && proof.runId === state.runId && proof.provider === state.provider
    ? {responseId:proof.responseId,context:proof.context} : undefined;
}

/** A committed receipt is authoritative even if an old invocation later writes
 * its native result/catch/finally into the retained runner object. These fields
 * are separate from the mutable fields known to pre-repair collectors.
 */
function repairedCollectionResult(state) {
  const receipt = state.repairReceipt;
  return receipt && receipt.jobId === state.jobId && receipt.runId === state.runId && receipt.provider === state.provider
    ? receipt.result : null;
}

/** Unsent text in the chat composer ("" when none): a user draft is the user's, never Ashlar's. */
function composerDraftText() {
  const draft = typeof composer === "function" && globalThis.document ? composer() : null;
  return (draft && (draft.value || draft.innerText || draft.textContent || "") || "").trim();
}

/** Files staged in the chat composer that are not this run's own attachments: a file the user added
 * before typing is a draft too. Only BEFORE the send is confirmed can a chip be the run's own (by
 * name: its journal's, or the ones fillComposer is uploading). A confirmed send took its attachments
 * out of the composer with the sent turn, so afterwards every chip there is the user's, whatever its
 * name: a file named like the run's old upload is the user's new one (Ashlar 4101062749). The chips
 * are every chip the send barrier accepts (composer.js fileChips, shared with attachmentsReady:
 * title-only chips included, Ashlar 4101623051, a control's tooltip title never), in the composer's
 * own form, and a chip is the run's own when any name it gives matches, as the barrier reads it. A
 * group that wraps the editor or the send control is the composer, not a file, and a named element
 * inside a chip that names a file (its remove control's title) is part of that chip, not another
 * file. */
function composerStagedFiles(state, submission) {
  const editor = typeof composer === "function" && globalThis.document ? composer() : null;
  const form = editor?.closest?.("form");
  if (!form) return [];
  const own = new Set(submission?.phase === "sent" ? [] : [...(Array.isArray(submission?.attachments) ? submission.attachments : []),
    ...(Array.isArray(state?.pendingAttachments) ? state.pendingAttachments : [])]);
  const shown = chip => (typeof renderedControl === "function" ? renderedControl(chip) : !hiddenNode(chip));
  // Names first, then the fold: only a chip that names a file takes in the elements inside it. An
  // unnamed element (an empty or blank title or label) is no chip, so a wrapper like that never hides
  // the named chip inside it (Ashlar, review of 5af999fd: the user's staged file closed with the tab).
  const named = fileChips(form)
    .filter(chip => !chip.contains(editor) && !chip.querySelector('[contenteditable="true"], textarea, button[type="submit"], [data-testid="send-button"], #composer-submit-button') && shown(chip))
    .map(chip => ({chip, names: fileChipNames(chip).filter(name => name.trim())}))
    .filter(({names}) => names.length);
  return named.filter(({chip}) => !named.some(outer => outer.chip !== chip && outer.chip.contains(chip)))
    .filter(({names}) => !names.some(name => own.has(name)))
    .map(({names}) => names[0]);
}

/** The response's variant pager: what the provider shows on an answer once it was regenerated (a
 * "2/2" counter between Previous/Next response buttons), "" when there is none. Read outside the
 * message text (never the answer's own content). Compared with the pager at collection only. */
function responseVariant(root) {
  if (!root?.querySelectorAll) return "";
  const buttons = [...root.querySelectorAll("button[aria-label], [role='button'][aria-label]")]
    .some(el => /previous response|next response|이전 응답|다음 응답/i.test(el.getAttribute("aria-label") || ""));
  const counters = [...root.querySelectorAll("div, span")]
    .filter(el => !el.children.length && !el.closest("[data-message-author-role], pre, code") && /^\d+\s*\/\s*\d+$/.test((el.textContent || "").trim()))
    .map(el => el.textContent.replace(/\s+/g, ""));
  return [...(buttons ? ["pager"] : []), ...counters].join(" ");
}

/** Whether this page completed Ashlar's answer for its run (collected, repaired or archived): what
 * the provider generates in the tab after that is a new cycle, not Ashlar's run. */
function answerCompleted(state) {
  return Boolean(state.nativeCompletion || state.result?.ok === true || repairedCollectionResult(state) || sourceReceiptFor(state));
}

/** Whether the bound response is being generated again, or was, after this page completed Ashlar's
 * answer: a Stop control or a streaming flag is back, or the variant pager differs from the one at
 * collection. Neither Ashlar nor a provider redraw starts a generation cycle on a finished answer; the
 * user's regenerate or retry does (Ashlar 4101062754). A redraw that only changes the answer's text,
 * fences, labels or message id is not one. With no pager recorded at collection (collectedVariant is
 * recorded by the native collector, and by the first completed source a capture or repair took), any
 * pager on the bound response counts: a kept tab is recoverable, a closed one is not. `secured`: the
 * worker's word that this run's answer was completed and taken, for a page that no longer remembers
 * it (reloaded, or re-injected, after the answer was secured: a fresh runner). */
function regeneratedAfterCompletion(state, submission, secured = false) {
  if (!(secured || answerCompleted(state)) || typeof boundReviewResponse !== "function") return false;
  const bound = boundReviewResponse(submission);
  if (typeof stopButtonVisible === "function" && stopButtonVisible()) return true;
  if (!bound.root) return false;
  if (typeof responseStreaming === "function" && responseStreaming(bound.root)) return true;
  return responseVariant(bound.root) !== (typeof state.collectedVariant === "string" ? state.collectedVariant : "");
}

/** One poll of the response bound to this run's sent prompt: the completion evidence both
 * collectors (review JSON, fix code) decide on. A follow-up turn marks the tab repurposed. A
 * later request's global Stop cannot end or block this older response: completion needs the
 * positive controls on the original response itself. */
async function pollBoundResponse() {
  const runner = globalThis.__ashlarRunnerState;
  const submission = typeof readSubmissionJournal === "function" ? await readSubmissionJournal() : null;
  const bound = submission?.phase === "sent" ? boundReviewResponse(submission) : undefined;
  // The run's sent turn is on this page: its response can be observed here (the worker's proof that
  // a page loaded again after a discard resumed the run, background.js discardedRunProven).
  if (bound?.identified && runner) runner.boundObserved = true;
  if (bound?.followup && runner && !runner.tabRepurposed) {
    runner.tabRepurposed = true;
    runner.takeoverCause = "user_turn";
    recordReviewStep("context_changed");
  }
  const stop = bound && !bound.root ? false : bound?.followup ? stopButtonVisible(bound.root) : stopButtonVisible();
  const streaming = typeof responseStreaming === "function" && globalThis.document ? responseStreaming(bound?.root) : false;
  const done = chatGenerationFinished({stopVisible: stop || streaming, replyActionsVisible: replyDoneVisible(bound?.root)});
  return {runner, bound, stop, streaming, done, submission};
}

/** A quota banner ends the run only while no answer is in hand and the banner can belong to it
 * (no bound response yet, or the identified response with no follow-up). */
function throwIfQuota(name, bound, answered) {
  if ((!bound || (bound.identified && !bound.followup)) && quotaHit() && !answered) {
    const error = new Error(`${name} usage limit`); error.code = "quota"; throw error;
  }
}

/** Generating lease (#82 section 4.5, #87), review runs only. Once the bound answer is mounted and
 * not yet complete, its response ID or Stop/streaming state must change, or its text grow past its
 * longest length so far, within 15 min; otherwise the run fails as `stalled`. ChatGPT ends a
 * reasoning run at ~29.5 min by mounting a turn that never gets completion controls (8/8 field
 * runs). Healthy runs: answer mount to completion took at most 154 s in 367 runs. Growth, not any
 * text change: a label re-rendered in place (a ticking timer) is not progress. No bound answer yet
 * (thinking), a follow-up or a completed turn clears the lease: none of them has a deadline.
 * Only observed time counts: a poll gap over 3 min is a host sleep or a frozen tab, whose first
 * poll on resume still sees the pre-pause answer, so the lease moves forward by that gap. Chrome
 * wakes a hidden tab's timers about once a minute, so throttled polls still count. */
function expireGeneratingLease(lease, name, {bound, stop, streaming, done}, text) {
  // Declared here, not at top level: content scripts are re-injected.
  const GENERATING_LEASE_MS = 15 * 60_000, POLLING_SUSPENDED_MS = 3 * 60_000;
  const now = Date.now(), gap = lease.polled ? now - lease.polled : 0;
  lease.polled = now;
  if (gap > POLLING_SUSPENDED_MS) lease.at += gap;
  if (done || !bound?.root || bound.followup) { lease.state = ""; return; }
  const state = JSON.stringify([bound.responseId || "", Boolean(stop), Boolean(streaming)]);
  if (state !== lease.state) Object.assign(lease, {state, chars: text.length, at: now});
  else if (text.length > lease.chars) Object.assign(lease, {chars: text.length, at: now});
  else if (now - lease.at >= GENERATING_LEASE_MS) {
    const error = new Error(`${name} answer unchanged for ${GENERATING_LEASE_MS / 60_000} min without completion controls`);
    error.code = "stalled"; throw error;
  }
}

/** Collection needs two identical stable observations (`key`). On the second one the runner
 * records the answer and, for an identified response, its native completion proof. */
function settleStableAnswer(stability, key, poll, {text, raw}) {
  stability.hits = stability.stable === key ? stability.hits + 1 : 1;
  stability.stable = key;
  if (stability.hits < 2) return false;
  const {runner, bound} = poll;
  if (runner) {
    runner.responseText = text;
    // The regeneration pager as it was when the answer was collected (tabOwnership: "regenerated").
    runner.collectedVariant = responseVariant(bound?.root);
    if (bound?.identified && bound.responseId) runner.nativeCompletion = Object.freeze({
      jobId:runner.jobId,provider:runner.provider,runId:runner.runId,
      responseId:bound.responseId,context:reviewPageContext(),text,raw,
    });
  }
  recordReviewStep("response_collected");
  return true;
}

async function waitUntilReviewOrQuota(name) {
  // A review-loop fix item is harvested as plain text; everything below is review-only.
  if (globalThis.__ashlarRunnerState?.kind === "fix") return waitUntilFixOrQuota(name);
  const owner = globalThis.__ashlarRunnerState;
  // Stamp the executing loop, never installReviewRunner's listener replacement.
  if (owner) owner.sourceTrackingOwner = {jobId: owner.jobId, runId: owner.runId, provider: owner.provider};
  const stability = {stable: "", hits: 0};
  const lease = {state: "", chars: 0, at: 0, polled: 0};
  // No poll-count failure and no deadline before the answer mounts (expireGeneratingLease bounds
  // only a mounted answer that stops progressing). Controls can appear before response text is
  // observable. A missing/invalid JSON slice is an observation, never an empty reply.
  for (;;) {
    throwIfStopped();
    // The full original was secured, not accepted as a review. The worker owns
    // further formatting; no page loop or new model request is needed.
    if (sourceReceiptFor(globalThis.__ashlarRunnerState)) return null;
    if (globalThis.__ashlarRunnerState?.repairedResult) {
      recordReviewStep("repair_accepted");
      return globalThis.__ashlarRunnerState.repairedResult;
    }
    const poll = await pollBoundResponse();
    const {runner, bound, stop, streaming, done, submission} = poll;
    // Like a fix run, a review is bound to a conversation: a later page in another conversation is
    // the user's (tab release). A review sent on a conversation page recorded it at its send
    // (composer.js submissionConfirmed). A review sent on a new chat (namesNoConversation: ChatGPT's
    // "/", Grok's home) had none to record: the provider moves that URL to the conversation it
    // assigns while it answers, which is not the user's doing (#82). Only a move this page saw
    // happen while the run was in flight is pinned (newChatPin): its exact sent turn shown on the
    // new chat after the send (or its Send clicked there), then on a conversation page before the
    // answer completed. A conversation URL first seen with the answer complete, or by a collector
    // that never saw the new chat after the send (a resumed or reloaded page), is not a URL the
    // send produced (the user may have moved in-page while the old DOM was still rendered, Ashlar
    // 4101062732): no pin, and the release verdict keeps the tab. On the new chat itself it pins
    // once its answer is complete (the page it was collected on).
    if (bound?.identified && !runner?.tabRepurposed && !submission.conversation &&
        journaledTurnIntegrity(submission, globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : []) === "exact") {
      if (newChatPin(runner, done, Boolean(bound.root))) pinNewChatReview(submission);
    }
    const text = assistantCorpus(bound?.root).join("\n\n");
    const json = done ? harvestJson({allowThin: true, root: bound?.root}) : null;
    if (runner) trackCompletedSource(runner, bound, done, text);
    if (runner?.running) runner.observation = {
      state: !done ? "generating_or_queued" : json ? "json_observed" : text.trim() ? "response_completed_json_invalid" : "waiting_for_response",
      // Diagnostic size bound, NOT a duration bound. Stay local to the bound job.
      text: text.slice(0, 128_000), totalChars: text.length, truncated: text.length > 128_000,
    };
    recordReviewStep(!done ? (stop || streaming ? "generating" : "waiting_for_response") :
      json ? "json_observed" : text.trim() ? "response_completed_json_invalid" : "waiting_for_response");
    throwIfQuota(name, bound, Boolean(json));
    expireGeneratingLease(lease, name, poll, text);
    if (done && json) {
      if (settleStableAnswer(stability, JSON.stringify([json, text]), poll, {text, raw: json})) return json;
    } else { stability.hits = 0; stability.stable = ""; }
    await (typeof waitForPageChange === "function" ? waitForPageChange(800) : sleep(800));
  }
}

/** Does the journaled sent turn hold EXACTLY Ashlar's prompt? boundReviewResponse identifies the
 * turn by containment, so a turn the user edited (a prefix or suffix around the prompt) still
 * binds. "exact": the turn (by its journaled message ID when exactly one matches, else by its
 * recorded position) is the prompt; "edited": it holds more or other text, so it is the user's;
 * "unknown": the turn is not rendered/resolvable. Independent of the composer draft. A fix journal
 * compares its prompt's lossless form (`exact`, composer.js fixPromptForm): a turn whose whitespace
 * differs from the prompt in any other way is not it; a review journal compares normalized text. */
function journaledTurnIntegrity(submission, users) {
  if (!submission?.expected) return "unknown";
  let turn;
  if (submission.messageId) {
    const matches = users.filter(node => node.getAttribute("data-message-id") === submission.messageId);
    if (matches.length === 1) turn = matches[0];
  } else if (Number.isSafeInteger(submission.submittedUsers) && submission.submittedUsers > submission.baseline) {
    turn = users[submission.submittedUsers - 1];
  }
  if (!turn) return "unknown";
  if (typeof submission.exact === "string") return fixTurnExact(turn, submission.exact) ? "exact" : "edited";
  return normalizePrompt(messagePromptText(turn)) === submission.expected ? "exact" : "edited";
}

/** Whether a fix's sent turn holds its prompt's lossless form `exact` (composer.js fixPromptForm). A
 * rich-text turn's block boundaries read two ways: one <p> per blank-line paragraph with a <br> per
 * line break (messagePromptText), or one <p> per line, the composer's own structure (losslessText).
 * Either reading can prove it exact; any other whitespace difference is an edit. */
function fixTurnExact(turn, exact) {
  const body = turn.querySelector?.('[data-testid="collapsible-user-message-content"]') || turn;
  return [messagePromptText(turn), losslessText(body)].some(text => fixPromptForm(text) === exact);
}

/** The identity of the conversation a page shows: its URL without the fragment (the path names the
 * conversation; the query is part of it too, e.g. ChatGPT's temporary chat). */
function conversationIdentity(href) {
  return typeof href === "string" ? href.split("#")[0] : "";
}

/* A run's conversation identity is recorded ONCE, when its send is proven: composer.js
 * submissionConfirmed writes `conversation` into the submission journal from the location at that
 * instant (only for a send this page instance clicked, still shown where it was clicked). A fix
 * always records it there; so does a review sent on a page that names a conversation. Every later
 * decision only COMPARES the current location with it (samePage); none records one. There is no
 * location-based pin or upgrade after the send: a later URL is no evidence of whose conversation it
 * is (the user can move in-page while the old DOM is still rendered), and neither provider's DOM
 * ties a conversation id to the sent turn or its response (both expose only per-message ids). A fix
 * journal without it (legacy, recorded before this rule, or a confirmation seen only after a
 * reload) is `identity:"unestablished"` for good: never harvested, never closed. The identity is
 * persisted with the journal (sessionStorage), so it survives a reload.
 *
 * A FIX is proven only in ChatGPT's temporary chat (#77: the chat fix provider is ChatGPT only, and
 * every fix tab opens on `/?temporary-chat=true`, fixChatPage). A fix whose send-time identity is
 * not exactly that page (sent on a bare new chat, `?temporary-chat=false`, an existing conversation)
 * is `identity:"unestablished"` too, even where the page never moved: never collected, its run ends
 * `taken_over`, its tab is preserved. The query is part of that send-time check (it names the mode
 * the fix was sent in); after the send, the page is compared by samePage (origin and path, the query
 * ignored, #82), for both kinds.
 *
 * A fix whose page changes path after the send is `identity:"changed"`, whoever moved it. The
 * temporary chat keeps its path only while ChatGPT honours it. When it does not, ChatGPT itself
 * moves the new chat to /c/<id>, and such a fix run ends `taken_over` ("the tab moved to another
 * conversation") and its tab is preserved as navigated, although the user did nothing. This is a
 * known #77 vs #82 contradiction: the send-time identity cannot tell the provider's move from the
 * user's in-page move to their own conversation while the old DOM is still rendered, which is the
 * case it guards (a review on a new chat pins instead, below).
 *
 * The one exception (#82) is a REVIEW whose journal has no send-time conversation: a review sent on
 * a new chat (namesNoConversation: ChatGPT's "/" or a temporary chat it does not honour, Grok's home,
 * the page every Ashlar tab opens on) has no conversation yet when its send is proven; the provider
 * assigns one while it answers, which is not the user's doing. It pins where the provider put it
 * (pinNewChatReview), but only when this page saw that move happen while the run was in flight
 * (newChatPin); a URL it did not see the send produce is never pinned. A review without a pinned
 * conversation is released as `unpinned` only on the new chat its tab was opened on; on any other
 * page it has left it with no trustworthy identity and is kept (`identity: "changed"`), never
 * "unestablished". */

/** Whether a review collector poll may pin its new-chat run's conversation here (the journaled turn
 * is shown, EXACTLY Ashlar's prompt): on the new chat once the answer is complete; on a conversation
 * page only while the answer is still in flight, and only when this page instance saw the run on the
 * new chat after its send (sawNewChatAfterSend): the provider's move, observed as it happened. A
 * poll on the new chat while generating records that sighting. */
function newChatPin(runner, done, answered) {
  if (namesNoConversation(globalThis.location?.href)) {
    if (!done && runner) { try { runner.newChatSeen = submissionKey(); } catch { /* unbound: no sighting */ } }
    return done && answered;
  }
  return !done && sawNewChatAfterSend(runner);
}

/** Whether this page instance saw its run on a new-chat page after the send: it clicked Send there
 * (composer.js sendAttempt), or a collector poll found the exact sent turn there while generating.
 * In memory only: a reloaded page has not seen it (its later URL is no evidence of the move). */
function sawNewChatAfterSend(runner) {
  let key;
  try { key = submissionKey(); } catch { return false; }
  return runner?.newChatSeen === key ||
    (runner?.sendAttempt?.key === key && namesNoConversation(runner.sendAttempt.conversation));
}

/** Pin a review's conversation identity that its send did not record (see above): only the review
 * collector calls it (newChatPin): on the conversation page the provider moved the run to while this
 * page watched it answer, or on the new chat once its answer is complete. Pinned ONCE and never
 * replaced: a later URL is compared with it (samePage). A fix never pins here: its identity is the
 * send-time one. */
function pinNewChatReview(submission) {
  if (!submission || submission.phase !== "sent" || submission.conversation) return;
  const identity = conversationIdentity(globalThis.location?.href);
  if (!identity) return;
  submission.conversation = identity;
  const state = globalThis.__ashlarRunnerState;
  if (state?.confirmedSubmission?.record === submission) {
    state.submissionPersistencePending = true;
    if (typeof retrySubmissionPersistence === "function") retrySubmissionPersistence();
  } else {
    try { sessionStorage.setItem(submissionKey(), JSON.stringify(submission)); } catch { /* re-pinned from memory next poll */ }
  }
}

/** Whether two URLs show the same page for tab ownership: origin and path (trailing slashes
 * ignored). The query and fragment are not the page (ChatGPT's `?temporary-chat=true` names a
 * mode, not another conversation), so a plain "/" and the temporary chat are the same page. */
function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const path = url => url.pathname.replace(/\/+$/, "");
    return x.origin === y.origin && path(x) === path(y);
  } catch { return false; }
}

/** Whether `href` is a provider's new-chat page, which names no conversation (its path is the site
 * root: ChatGPT's "/" with or without `?temporary-chat=true`, Grok's home). */
function namesNoConversation(href) {
  try { return new URL(href).pathname.replace(/\/+$/, "") === ""; } catch { return false; }
}

/** The only conversation a fix run can be proven in (#77): ChatGPT's temporary chat, the page every
 * fix tab is opened on (background.js providerUrl). A function, so the content script stays
 * re-injectable. */
function fixChatPage() { return "https://chatgpt.com/?temporary-chat=true"; }

/** Whether a fix run was sent in the temporary chat (its send-time identity is exactly fixChatPage):
 * the only send a fix answer can be proven for, and the only one whose tab may close. */
function fixSentInTemporaryChat(submission) {
  return submission?.conversation === fixChatPage();
}

/** Whether the page still shows the conversation its run was bound in (samePage). Not established = false. */
function fixConversationHolds(submission) {
  return Boolean(submission?.conversation) && samePage(submission.conversation, globalThis.location?.href);
}

/** The conversation this page's run is bound to (recorded at send, or a new-chat review's pin): ""
 * when none is established or readable. */
function sentFixConversation(state) {
  try {
    const submission = state.confirmedSubmission?.record || savedSubmission();
    return typeof submission?.conversation === "string" ? submission.conversation : "";
  } catch { return ""; }
}

/** The answer this fix run collected (what the worker delivers): the native completion proof when
 * the response carried an ID, else the collected text. */
function storedFixCompletion(state) {
  const proof = state.nativeCompletion;
  if (proof && proof.jobId === state.jobId && proof.runId === state.runId && proof.provider === state.provider &&
      typeof proof.text === "string") return {responseId: proof.responseId || "", text: proof.text};
  return state.result?.ok === true && typeof state.result.responseText === "string" ? {responseId: "", text: state.result.responseText} : null;
}

/** THE ownership proof a fix ANSWER needs: collecting it (phase "collect") and handing a collected
 * answer to the worker ("complete"). The tab-release decisions (can-close, cancel) of both kinds use
 * tabOwnership instead, which asks for positive user evidence only. `journal`: the submission
 * journal the caller just read (default: the confirmed or saved one). `pinned` ("collect"): the
 * response the collector pinned at its first answered observation (waitUntilFixOrQuota).
 *
 * owned = the fix was sent in the temporary chat (fixSentInTemporaryChat, #77) and the page still
 * shows it, the journaled sent turn is EXACTLY Ashlar's prompt (journaledTurnIntegrity "exact", in
 * its lossless form `exact`), no follow-up turn, no user draft, ("collect") the bound response is
 * still the pinned one and ("complete") an answer was collected. Nothing about the collected answer
 * itself is compared: ChatGPT keeps redrawing a finished answer (the closing code fence after the
 * action bar, labels, re-keyed ids, streaming flags), and requiring the collected text again would
 * keep the answer, and then the tab, forever (#82). The collector's pin is no such comparison: it
 * names WHICH response is collected (its ID, else its message node) while the run collects, never
 * its text. takenOver = the user's (follow-up, edited turn, draft: typed text or a staged file,
 * another response while collecting); unknown = not provable now (journal unreadable, turn not
 * rendered, the just-sent prompt still echoed in the composer, identity or lossless form not
 * recorded at send, not the temporary chat, or moved: `identity` "unestablished" | "changed").
 * PERMANENT verdicts are decided before any transient one (#77): the conversation, the exact sent
 * turn and a user draft need no rendered response, so no transient wait (a turn not rendered or
 * resolved yet, the prompt echoed in the composer) hides them until the fix deadline. Every
 * takenOver verdict is PERMANENT: it marks the tab repurposed for good (a draft the user later
 * clears, or an edit the user undoes, does not hand the tab back); see fixVerdictPermanent for what
 * ends a run. */
function fixOwnershipProof(state, {phase, journal, pinned} = {}) {
  const verdict = (ownership, reason, extra = {}) => ({ownership, reason, ...extra});
  const takeOver = (reason, cause) => {
    if (!state.tabRepurposed) { state.tabRepurposed = true; state.takeoverCause = cause; recordReviewStep("context_changed"); }
    return verdict("takenOver", reason);
  };
  if (state.tabRepurposed) return verdict("takenOver", "repurposed");
  let submission = journal;
  if (!submission) {
    try { submission = state.confirmedSubmission?.record || savedSubmission(); } catch { return verdict("unknown", "journal_unreadable"); }
  }
  // Nothing was sent: there is no answer to collect or to hand out.
  if (submission?.phase !== "sent") return verdict("unknown", "not_sent");
  // 1. The conversation. The rendered turn proves its content only; an in-page (SPA) move to another
  // conversation can leave this DOM on screen under the new URL, or remove it: the proof holds only
  // in the conversation recorded when the send was proven (composer.js submissionConfirmed), which
  // must be the temporary chat; a journal without one never gains it. Nor does one without its
  // prompt's lossless form (`exact`, recorded by composer.js clickSend when the send is prepared):
  // its turn can never be proven exact.
  if (!fixSentInTemporaryChat(submission) || typeof submission.exact !== "string") {
    return verdict("unknown", "unestablished", {identity: "unestablished"});
  }
  if (!fixConversationHolds(submission)) return verdict("unknown", "moved", {identity: "changed", conversation: submission.conversation});
  // 2. The journal-addressable sent turn (its message ID, else its recorded position) holds EXACTLY
  // Ashlar's prompt. boundReviewResponse only proves the turn CONTAINS it, and finds no turn at all
  // once the user replaced its text: an edited or replaced turn is the user's, even if undone later.
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  const integrity = journaledTurnIntegrity(submission, users);
  if (integrity === "edited") return takeOver("edited", "edited");
  const bound = boundReviewResponse(submission);
  if (bound.followup) return takeOver("followup", "user_turn");
  // 3. A draft in the composer: typed text or a staged file (after a confirmed send every file chip
  // is the user's, composerStagedFiles). The just-sent prompt can linger there a moment after the
  // send is confirmed: that text (the journal's own expected prompt) is Ashlar's, not evidence of a
  // user. Any other draft is the user's, decided on the poll that sees it and BEFORE the transient
  // waits below (turn not rendered or not resolvable yet): a draft typed and cleared while the turn
  // is briefly unresolved still latches the takeover.
  const draftText = composerDraftText();
  const staged = composerStagedFiles(state, submission);
  if (staged.length || (draftText && normalizePrompt(draftText) !== submission.expected)) return takeOver("draft", "draft");
  // 4. ("collect") The pinned response. boundReviewResponse always binds the LAST reply after the
  // sent turn, so a response regenerated after the first answered observation would bind instead:
  // any other response (another ID; with no ID, another assistant message node) is the user's.
  // An ID-less pin adopts the ID its own node gains later (renderers can assign it after mounting
  // the text): the same node is the same response, never another one.
  if (pinned && bound.root) {
    if (!pinned.responseId && bound.responseId && bound.message === pinned.message) pinned.responseId = bound.responseId;
    if ((bound.responseId || "") !== pinned.responseId || (!pinned.responseId && bound.message !== pinned.message)) {
      return takeOver("response_changed", "regenerated");
    }
  }
  if (!bound.identified) {
    // A collected answer whose sent turn no longer holds Ashlar's prompt: the user edited it. Still in
    // the recorded conversation with no addressable turn before that: not rendered yet (transient).
    return phase === "complete" ? takeOver("turn_changed", "edited") : verdict("unknown", "turn_unrendered");
  }
  if (integrity === "unknown") return verdict("unknown", "turn_unresolved");
  // Only Ashlar's own just-sent prompt can still be in the composer here (a user draft latched above).
  if (draftText) return verdict("unknown", "composer_echo");
  if (phase === "complete" && !storedFixCompletion(state)) return verdict("unknown", "no_completion", {conversation: submission.conversation});
  return verdict("owned", "exact", {conversation: submission.conversation});
}

/** Whether a fix ownership verdict can never turn back into "owned" (bridge-fix.server.ts
 * LIFECYCLE, terminal verdicts): the user's (takenOver: follow-up, edited turn, draft, replaced
 * response), the page moved off the conversation its send was made in (a recorded identity never
 * comes back by waiting), or its sent journal carries no send-time identity (recorded only when the
 * send is proven, so it can never be established later). The same in every phase. Everything else
 * "unknown" is transient (journal unreadable, turn not rendered yet, still generating, the sent
 * prompt still echoed in the composer). */
function fixVerdictPermanent(proof) {
  return proof.ownership === "takenOver" || proof.identity === "changed" || proof.identity === "unestablished";
}

/** End a fix run on a permanent verdict, at once: the tab is the user's for good (every later proof
 * says so), its managed slot is freed, and the run's outcome is a distinct terminal `taken_over`
 * failure the worker delivers right away (the server fails the item and the runtime retries or
 * escalates now, not at the fix deadline). Returns that outcome. */
function endFixRun(state, proof) {
  if (!state.tabRepurposed) {
    state.tabRepurposed = true;
    // Why the tab is kept (the release verdict's cause; takeOver already named a takenOver one).
    state.takeoverCause ||= proof.identity === "changed" ? "navigated" : proof.identity === "unestablished" ? "ownership_unknown" : "user_turn";
    recordReviewStep("context_changed");
  }
  releaseManagedSlot(state);
  const detail = proof.identity === "changed" ? "the tab moved to another conversation" :
    proof.identity === "unestablished" ? "the fix conversation cannot be identified" : `the user took over the fix tab (${proof.reason})`;
  return {ok: false, code: "taken_over", error: `fix run ended: ${detail}; tab preserved`, proof: proof.reason};
}

/** A collected fix answer is handed to the worker only while the tab still proves it
 * (fixOwnershipProof "complete"); a transient verdict tells the worker to wait, a permanent one
 * ends the run (taken_over), so an answer is never delivered from a tab the user took over and the
 * run never waits for its deadline instead. Review results pass through unchanged. */
function fixAnswerReply(state, msg, value, busy) {
  if (value?.ok !== true || !(msg.kind === "fix" || state.kind === "fix")) return value;
  const proof = fixOwnershipProof(state, {phase: "complete"});
  if (fixVerdictPermanent(proof)) {
    state.result = endFixRun(state, proof);
    state.nativeCompletion = undefined;
    return {...state.result, ownership: proof.ownership};
  }
  if (proof.ownership !== "owned") return {...busy(), ownership: proof.ownership, proof: proof.reason};
  return {...value, ownership: "owned"};
}

/** A review-loop FIX answer is plain text for the server's deterministic fix parser: harvest
 * the bound response's fenced code blocks (literal text, see assistantCodeBlocks) — or, when it
 * has none, a fixed no-JSON line — after the same positive completion controls and two identical stable
 * observations as a review, with no review-JSON requirement and no capture/repair evidence (a
 * fix item has neither lane). It ends on the answer, on quota, on a PERMANENT ownership verdict
 * (fixVerdictPermanent: `taken_over` at once, never at the deadline) or when the server settles the
 * item (the worker's ashlar-fix-cancel stops it: throwIfStopped); no page timer ends a transient
 * wait: the fix deadline bounds it.
 */
async function waitUntilFixOrQuota(name) {
  // `pinned`: the response this run collects, fixed at its first answered observation and never
  // replaced (a regenerated response ends the run: fixOwnershipProof "collect"); an ID-less pin only
  // gains the ID its own node is assigned later.
  const stability = {stable: "", hits: 0, pinned: undefined};
  for (;;) {
    throwIfStopped();
    // Same completion evidence, quota rule and stability as a review (shared helpers above).
    const poll = await pollBoundResponse();
    const {runner, bound, stop, streaming, done} = poll;
    // Only the response identified as the answer to THIS run's sent prompt, in a tab the full
    // ownership proof holds for right now, is a fix answer (fixOwnershipProof "collect": exact
    // journaled turn, send-time conversation still shown, no follow-up, no draft). With no sent journal
    // or no identified response the page-global fallbacks would read whatever chat is on screen:
    // never an answer (a review keeps its legacy unbound observation). An edited turn repurposes
    // the tab for good; after an in-page move the lingering DOM is not harvested there.
    const proof = runner ? fixOwnershipProof(runner, {phase: "collect", journal: poll.submission, pinned: stability.pinned}) : {ownership: "unknown"};
    // A permanent verdict ends the run NOW (endFixRun: slot freed, `taken_over`); only a transient
    // "unknown" keeps polling, bounded by the server's fix deadline.
    if (runner && fixVerdictPermanent(proof)) {
      const ended = endFixRun(runner, proof);
      const error = new Error(ended.error); error.code = ended.code; throw error;
    }
    const own = proof.ownership === "owned" && bound?.identified ? bound.root : null;
    const text = done && own ? boundAnswerText("fix", own) : "";
    const answered = done && Boolean(text.trim());
    // Local diagnostics only: the answer text is never copied into an observation.
    if (runner?.running) runner.observation = {
      state: !done ? "generating_or_queued" : answered ? "answer_observed" : "waiting_for_response",
      text: "", totalChars: text.length, truncated: false,
    };
    if (!answered) recordReviewStep(!done && (stop || streaming) ? "generating" : "waiting_for_response");
    throwIfQuota(name, bound, answered);
    if (answered) {
      // Its ID (its message node when it has none): the only response a later poll may collect.
      stability.pinned ||= {responseId: bound.responseId || "", message: bound.message};
      if (settleStableAnswer(stability, text, poll, {text, raw: text})) return text;
    } else { stability.hits = 0; stability.stable = ""; }
    await (typeof waitForPageChange === "function" ? waitForPageChange(800) : sleep(800));
  }
}

/** Who holds this run's tab (review or fix), by one rule: once its result is secured or unwanted
 * the tab is Ashlar's to close unless the user positively took it over, shown by signals the
 * provider never changes by itself:
 *  - a user turn after Ashlar's journaled turn ("user_turn"), or that turn edited ("edited");
 *  - a composer draft that is not Ashlar's own prompt ("draft");
 *  - another conversation or site (samePage against the pinned conversation: "navigated");
 *  - the answer generated again after this page completed it, or after the worker says it was
 *    secured (`secured`, for a page reloaded since) ("regenerated": a Stop control or a streaming flag
 *    back, or a new variant pager; regeneratedAfterCompletion).
 * Nothing else about the ANSWER is compared (text, fences, labels, message id): ChatGPT keeps
 * redrawing a finished answer, and that is not the user's activity.
 * "owned" carries how it was proven: `blank` (nothing on the page), `unsent` (only Ashlar's
 * just-clicked prompt), `legacy` (a run observed without a journal), `unpinned` (a review sent,
 * no pinned conversation) or the recorded `conversation`; the worker then checks the page it
 * expects. "unknown": not provable yet (the journal is unreadable, or the page has not rendered its
 * turns after a reload), `identity: "changed"`, or (`fix`: a fix run's tab) `identity:
 * "unestablished"`, a sent fix whose send recorded no conversation; the worker asks again or
 * preserves the tab. */
function tabOwnership(state, allocationUrl, fix = false, secured = false) {
  if (state.tabRepurposed) return {ownership: "takenOver", cause: state.takeoverCause || "user_turn"};
  // Every takeover is permanent (as for a fix run's answer, fixOwnershipProof): a draft the user
  // clears again or an edit the user undoes does not hand the tab back.
  const takeOver = cause => {
    if (!state.tabRepurposed) { state.tabRepurposed = true; state.takeoverCause = cause; recordReviewStep("context_changed"); }
    return {ownership: "takenOver", cause};
  };
  let submission;
  try { submission = state.confirmedSubmission?.record || (typeof savedSubmission === "function" ? savedSubmission() : null); }
  catch { return {ownership: "unknown", cause: "journal_unreadable"}; }
  const norm = text => typeof normalizePrompt === "function" ? normalizePrompt(text) : String(text || "").replace(/\s+/g, " ").trim();
  const promptOf = turn => norm(typeof messagePromptText === "function" ? messagePromptText(turn) : turn.textContent);
  const href = globalThis.location?.href || "";
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  // Ashlar's own prompt in the composer (before or after the send) is not a user draft; anything
  // else there is the user's, including Ashlar's prompt with text added around it.
  const draft = composerDraftText();
  if (draft && norm(draft) !== norm(submission?.expected || state.pendingPrompt || "")) return takeOver("draft");
  if (composerStagedFiles(state, submission).length) return takeOver("draft");
  if (submission?.phase !== "sent") {
    if (!submission && typeof state.finishedContext === "string") {
      // A run observed without a journal (a legacy page): compare with what it recorded when it finished.
      let recorded;
      try { recorded = JSON.parse(state.finishedContext); } catch { recorded = null; }
      if (Array.isArray(recorded)) {
        if (users.length > recorded[1]) return takeOver("user_turn");
        if (!samePage(href, recorded[0])) return takeOver("navigated");
        return {ownership: "owned", legacy: true};
      }
    }
    // Before the send is confirmed the page holds at most Ashlar's own prompt. No turn: `blank`
    // (content proves nothing about WHICH page this is). The just-clicked turn, exactly the prompt:
    // `unsent`. The worker also requires the page the tab was opened on for both.
    if (!users.length) return {ownership: "owned", blank: true};
    if (submission?.baseline === 0 && users.length === 1 && promptOf(users[0]) === submission.expected) return {ownership: "owned", unsent: true};
    return takeOver("user_turn");
  }
  // An in-page (SPA) move can leave this DOM on screen under another conversation's URL: once the
  // run's conversation is recorded (at send, or a new-chat review's pin), the page must still show it.
  const pinned = typeof submission.conversation === "string" ? submission.conversation : "";
  if (pinned && !samePage(pinned, href)) return {ownership: "unknown", identity: "changed", cause: "navigated", conversation: pinned};
  // A review with no pin has no trustworthy conversation: it is Ashlar's only on the new chat its tab
  // was opened on. Any other page is one its send was not seen to produce (a move the collector did
  // not watch happen in flight, or the user's own conversation with the old DOM still on screen,
  // Ashlar 4101062732): kept, never closed on the page's word. (A fix without one: unestablished.)
  if (!pinned && !fix && !(namesNoConversation(href) && (!allocationUrl || samePage(href, allocationUrl)))) {
    return {ownership: "unknown", identity: "changed", cause: "navigated"};
  }
  // A FIX records its conversation only when its send is proven (composer.js submissionConfirmed),
  // and only the temporary chat proves it (#77, fixSentInTemporaryChat): a sent fix journal without
  // one (a legacy journal, a send confirmed only after a reload) or with another page can never
  // establish it, so its tab is never closed. The worker preserves it at once. Nor can one without its
  // prompt's lossless form (`exact`, #77: recorded by composer.js clickSend), whose turn can never be
  // proven exact. A review has no such rule: it may pin later (pinNewChatReview), and until then it
  // is `unpinned`.
  const unestablished = fix && (!fixSentInTemporaryChat(submission) || typeof submission.exact !== "string")
    ? {ownership: "unknown", identity: "unestablished", cause: "ownership_unknown"} : null;
  // The journaled turn: its message ID (one match), else its recorded position (a provider that
  // re-keys the turn is not the user).
  let turn;
  if (submission.messageId) {
    const matches = users.filter(node => node.getAttribute("data-message-id") === submission.messageId);
    if (matches.length === 1) turn = matches[0];
  }
  if (!turn && Number.isSafeInteger(submission.submittedUsers) && submission.submittedUsers > submission.baseline) turn = users[submission.submittedUsers - 1];
  const sent = turn ? promptOf(turn) : "";
  if (!sent) {
    // A reloaded temporary chat renders nothing: blank on the page it was opened on. A conversation
    // page that has not rendered its turns yet proves nothing. (A fix with no send-time identity is
    // never closed, blank or not.)
    if (unestablished) return unestablished;
    return !users.length && samePage(href, allocationUrl) ? {ownership: "owned", blank: true} : {ownership: "unknown", cause: "not_rendered"};
  }
  // The journaled turn must hold EXACTLY Ashlar's prompt (normalized), pinned or not: a review's
  // send-time record and its pin need an exact turn, a fix's collector ends on any other, and an
  // unpinned turn that merely contains the prompt may be the user's edit around it (Ashlar
  // 4101062732). Any other text is an edit.
  if (sent !== submission.expected) return takeOver("edited");
  // A fix turn is also held to its prompt's lossless form (#77, fixTurnExact): a fix prompt inlines
  // source whose whitespace is content, so a turn whose whitespace alone changed is an edit too.
  if (fix && typeof submission.exact === "string" && typeof fixPromptForm === "function" && !fixTurnExact(turn, submission.exact)) {
    return takeOver("edited");
  }
  if (users.indexOf(turn) < users.length - 1) return takeOver("user_turn");
  if (regeneratedAfterCompletion(state, submission, secured)) return takeOver("regenerated");
  if (unestablished) return unestablished;
  return pinned ? {ownership: "owned", conversation: pinned} : {ownership: "owned", unpinned: true};
}

/** Short message replies keep MV3 workers recoverable; the page owns the long model call.
 * State survives script reinjection and retains terminal outcomes for a restarted worker.
 */
function reviewPageContext() {
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  const last = users.at(-1);
  return JSON.stringify([globalThis.location?.href || "", users.length,
    last?.getAttribute("data-message-id") || "", last?.textContent || ""]);
}

/** The server no longer wants this run (cancelled, superseded, forgotten): nothing is sent or
 * collected for it again. The marker is per (job, run) in sessionStorage, so a reload that
 * re-binds the page (and a late "ashlar-run" for the same run) stays stopped. */
function stopRun(state) {
  if (!state.runStopped) recordReviewStep("cancelled");
  state.runStopped = true;
  try { sessionStorage.setItem(`ashlar:stopped:${state.jobId}:${state.runId}`, "true"); } catch { /* in-memory stop remains */ }
}

/** Stop a run this page is not bound to: the tab the worker opened for a run it never sent
 * (undispatched), either kind. A late "ashlar-run" for it (a dispatch the worker gave up on) binds
 * the page stopped (runStoppedFor), also when the marker cannot be written. */
function fenceRun(state, jobId, runId) {
  if (!jobId || !runId) return;
  state.fencedRuns = [...(state.fencedRuns || []), JSON.stringify([jobId, runId])].slice(-16);
  try { sessionStorage.setItem(`ashlar:stopped:${jobId}:${runId}`, "true"); } catch { /* the in-memory fence remains */ }
}

function runStoppedFor(jobId, runId) {
  if (!jobId || !runId) return false;
  if (globalThis.__ashlarRunnerState?.fencedRuns?.includes(JSON.stringify([jobId, runId]))) return true;
  try { return sessionStorage.getItem(`ashlar:stopped:${jobId}:${runId}`) === "true"; }
  catch { return false; }
}

/** Why this page is no longer the fresh page a new run may start on (X2, #85; `page`: the page its
 * tab was opened on, or the one the run was accepted on): "navigated" when it shows another page,
 * "user_turn" once it holds a user turn (a message the user sent there), "draft" once its composer
 * holds the user's unsent text or file (Ashlar 4103758186: never typed over, never sent along);
 * "" while it still is. Ashlar's own attachments are not a draft, nor its own text once it started
 * typing (composer.js fillComposer: composerTyping; clickSend sends only the exact prompt). */
function freshPageLeft(page, state) {
  if (!samePage(globalThis.location?.href || "", page)) return "navigated";
  if (globalThis.document?.querySelector('[data-message-author-role="user"]')) return "user_turn";
  if (composerStagedFiles(state, null).length) return "draft";
  return !state?.composerTyping && composerDraftText() ? "draft" : "";
}

/** The one stop fence: every send and collect loop (composer.js and both collectors) calls it
 * before acting, so a stopped run ends as "cancelled" instead of clicking Send or harvesting. A new
 * run also ends ("taken_over") once its tab stops being the fresh page it was accepted on, until its
 * Send is clicked (composer.js clickSend clears freshPage then): nothing more is typed or clicked in
 * a conversation the user opened, or wrote in, meanwhile. */
function throwIfStopped() {
  const state = globalThis.__ashlarRunnerState;
  if (state?.runStopped) {
    const error = new Error("the run was stopped: its job was cancelled or forgotten"); error.code = "cancelled"; throw error;
  }
  const left = state?.freshPage ? freshPageLeft(state.freshPage, state) : "";
  if (!left) return;
  const error = new Error(`${left === "user_turn" ? "a user message appeared in the tab" : left === "draft" ? "a user draft appeared in the tab" : "the tab left its new chat"} before the prompt was sent; nothing was sent`);
  error.code = "taken_over"; throw error;
}

function releaseManagedSlot(state) {
  state.slotReleased = true;
  try { sessionStorage.setItem(`ashlar:released:${state.jobId}:${state.runId}`, "true"); } catch { /* Only causes conservative recount on reload. */ }
}

function installReviewRunner(name, run) {
  let boundJob = "";
  try { boundJob = sessionStorage.getItem("ashlar:job") || ""; } catch { /* unavailable storage */ }
  const state = globalThis.__ashlarRunnerState || globalThis.__ashlarRunner ||
    { running: false, jobId: boundJob, result: null };
  globalThis.__ashlarRunnerState = state;
  state.run = run;
  state.provider = name.toLowerCase();
  if (!state.runId) {
    try { state.runId = sessionStorage.getItem("ashlar:run") || ""; } catch { /* unavailable storage */ }
  }
  try { state.slotReleased ||= sessionStorage.getItem(`ashlar:released:${state.jobId}:${state.runId}`) === "true"; } catch { /* Unknown remains managed. */ }
  state.runStopped ||= runStoppedFor(state.jobId, state.runId);
  if (state.listener && state.protocol === "observed-submission-v8") return;
  if (state.listener) chrome.runtime.onMessage.removeListener(state.listener);
  state.protocol = "observed-submission-v8";
  const busy = () => ({ ok: false, code: "busy", retry: true, error: "generation pending", observation: state.observation,
    observing: state.boundObserved === true });
  state.listener = (msg, _sender, reply) => {
    // Read-only inventory: never adopt a page, collect a prompt, or start a run.
    if (msg?.type === "ashlar-tab-status") {
      reply({ok:true,ownershipProtocol:1,jobId:state.jobId || "",runId:state.runId || "",provider:state.provider,
        released:Boolean(state.slotReleased),url:globalThis.location?.href || ""});return;
    }
    if (!["ashlar-run", "ashlar-harvest", "ashlar-can-close", "ashlar-repair-source", "ashlar-repair-accepted",
      "ashlar-capture-accepted", "ashlar-fix-cancel"].includes(msg?.type)) return;
    const respond = reply;
    reply = value => respond({...value, jobId: state.jobId, provider: state.provider, runId: state.runId, progress: reviewProgress(),
      // A run (review or fix) reports the conversation it was bound in (once recorded) so the worker keeps it.
      ...(!value?.conversation && state.jobId && msg.jobId === state.jobId && state.runId && msg.runId === state.runId && sentFixConversation(state)
        ? {conversation: sentFixConversation(state)} : {})});
    if (!msg.jobId) {
      reply({ ok: false, code: "job_mismatch", error: "jobId is required" });
      return;
    }
    if ((state.jobId && msg.jobId !== state.jobId) ||
        (msg.provider && msg.provider !== state.provider) ||
        (state.runId && msg.runId && msg.runId !== state.runId)) {
      reply({ ok: false, code: "job_mismatch", error: "tab belongs to another job" });
      return;
    }
    // Capture and JSON repair are review-JSON machinery: a fix run never takes part in them.
    if (["ashlar-capture-accepted", "ashlar-repair-source", "ashlar-repair-accepted"].includes(msg.type) && (msg.kind === "fix" || state.kind === "fix")) {
      reply({ok:false,code:"job_mismatch",error:"a fix run has no capture or repair lane"});return;
    }
    if (msg.type === "ashlar-capture-accepted") {
      if (!state.jobId || !state.runId || msg.runId !== state.runId || msg.provider !== state.provider || msg.committed !== true) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      const receipt = sourceReceiptFor(state);
      if (receipt) {
        reply(receipt.id === msg.captureId && receipt.responseId === msg.responseId && receipt.text === msg.text && receipt.context === msg.context
          ? {ok:true,accepted:true} : {ok:false,code:"capture_source_changed"});return;
      }
      const source = currentRepairSource();
      if (!source) {
        // A fresh/reloaded page can need another identical observation before
        // source stability is established. A changed page answers "changed"; neither
        // answer decides who holds the tab (the release verdict does).
        let submission, bound, currentText = "";
        try {
          submission = state.confirmedSubmission?.record || savedSubmission();
          if (submission?.phase === "sent") bound = boundReviewResponse(submission);
          if (bound?.root && !bound.followup && replyDoneVisible(bound.root) && !stopButtonVisible() && !responseStreaming(bound.root))
            currentText = assistantCorpus(bound.root).join("\n\n");
        } catch { /* unavailable remains retryable */ }
        if (typeof msg.context === "string" && (msg.context !== reviewPageContext() || bound?.followup ||
            (currentText && currentText !== msg.text))) {
          reply({ok:false,code:"capture_source_changed"});return;
        }
        reply({ok:false,code:"capture_source_unavailable"});return;
      }
      if (!msg.captureId || typeof msg.context !== "string") {reply({ok:false,code:"capture_source_changed"});return;}
      if (source.responseId !== msg.responseId || source.text !== msg.text) {
        // The worker secured its original elsewhere; who holds the tab is the release verdict's call.
        reply({ok:false,code:"capture_source_changed"});return;
      }
      state.captureReceipt = Object.freeze({id:msg.captureId,jobId:state.jobId,runId:state.runId,provider:state.provider,
        responseId:source.responseId,text:source.text,context:msg.context});
      recordReviewStep("source_archived");
      reply({ok:true,accepted:true});return;
    }
    if (["ashlar-repair-source", "ashlar-repair-accepted"].includes(msg.type)) {
      if (!state.jobId || !state.runId || msg.runId !== state.runId || msg.provider !== state.provider) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      if (msg.type === "ashlar-repair-accepted" && repairedCollectionResult(state)) {
        const receipt = state.repairReceipt;
        const same = msg.committed === true && msg.repairId === receipt.repairId &&
          msg.responseId === receipt.responseId && msg.text === receipt.text && msg.raw === receipt.result.raw;
        reply(same ? {ok:true,accepted:true} : {ok:false,code:"repair_source_changed"});
        return;
      }
      const source = currentRepairSource();
      if (!source) { reply({ok:false,code:"repair_source_unavailable"});return; }
      if (msg.type === "ashlar-repair-source") { reply({ok:true,source});return; }
      if (msg.committed !== true || !msg.repairId || msg.responseId !== source.responseId || msg.text !== source.text ||
          typeof msg.raw !== "string" || !extractChatJson(msg.raw)) {
        reply({ok:false,code:"repair_source_changed"});return;
      }
      // The server ACK identifies this exact original. This is not another model
      // response or an extra Local reviewer vote, and never authorizes a send.
      state.repairedContext ||= reviewPageContext();
      state.repairedResponseId ||= source.responseId;
      state.repairedResult = msg.raw;
      state.responseText = source.text;
      state.repairReceipt = Object.freeze({jobId: state.jobId, runId: state.runId, provider: state.provider,
        repairId: msg.repairId, context: state.repairedContext, responseId: state.repairedResponseId, text: source.text,
        result: Object.freeze({ok:true,raw:msg.raw,responseText:source.text})});
      recordReviewStep("repair_accepted");
      // Receipt handoff does not wait for an older collector to understand the
      // new protocol. Preserve running as invocation liveness, not result state.
      state.finishedContext = state.repairedContext;
      state.result = state.repairReceipt.result;
      reply({ok:true,accepted:true});return;
    }
    // Upgrade only an already matching job binding; never adopt an unrelated chat.
    if (state.jobId === msg.jobId && !state.runId && msg.runId) {
      state.runId = msg.runId;
      try { sessionStorage.setItem("ashlar:run", state.runId); } catch { /* in-memory binding remains */ }
    }
    // Also retry after collection is cached: there may no longer be a polling loop.
    if (typeof retrySubmissionPersistence === "function") retrySubmissionPersistence();
    if (msg.type === "ashlar-can-close" || msg.type === "ashlar-fix-cancel") {
      // A secured leg asks can-close; a cancelled or forgotten review asks ashlar-fix-cancel, which also
      // stops the run. Both get the same ownership verdict (tabOwnership). A FIX tab is closed only on
      // the proven-success path (#77, background.js forceCloseFixTab): its page is asked to cancel
      // only when the worker keeps the tab, so that reply stops the run, frees the managed slot and
      // authorises nothing (no ownership verdict), and no fix page ever answers for an unbound tab.
      const fixRun = msg.kind === "fix" || state.kind === "fix";
      if (msg.type === "ashlar-fix-cancel" && msg.undispatched === true && !state.jobId && !state.runId) {
        // The tab the worker opened for a run it never sent (undispatched), either kind: a late run
        // message for it stays stopped. A fix page stops there: the worker keeps an undispatched fix
        // tab (#77), so the page refuses the release like any unbound page and vouches for nothing.
        fenceRun(state, msg.jobId, msg.runId);
        if (fixRun) { reply({ok:false,code:"job_mismatch"});return; }
        // Positive binding only: an unbound page is never evidence that this tab is Ashlar's, except
        // the tab the worker opened for a review it never sent: Ashlar's only while it holds nothing
        // of the user's (no turn, no draft).
        const turns = globalThis.document ? document.querySelectorAll('[data-message-author-role="user"]').length : 0;
        const draft = Boolean(composerDraftText()) || composerStagedFiles(null, null).length > 0;
        const blank = !turns && !draft;
        reply({ok:true,releaseProtocol:1,owned:blank,canClose:blank,ownership:blank ? "owned" : "takenOver",
          ...(blank ? {} : {cause: draft ? "draft" : "user_turn"}),blank,unsent:false,url:globalThis.location?.href || ""});return;
      }
      if (!state.jobId || msg.jobId !== state.jobId || (state.runId || "") !== (msg.runId || "")) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      if (msg.type === "ashlar-fix-cancel" && fixRun) {
        if (!state.runId) { reply({ok:false,code:"job_mismatch"});return; } // positive binding only
        stopRun(state);
        releaseManagedSlot(state);
        reply({ok:true,released:true,stopped:true,url:globalThis.location?.href || ""});return;
      }
      if (msg.type === "ashlar-fix-cancel") stopRun(state);
      const verdict = tabOwnership(state, msg.allocationUrl, fixRun, msg.secured === true);
      const owned = verdict.ownership === "owned";
      // A tab on a permanent verdict (taken over, moved off its recorded conversation, or a fix whose
      // send recorded none: fixVerdictPermanent) or one the worker gives up identifying (preserve)
      // stays open but is no longer Ashlar's: free its managed slot, or it counts against tab
      // capacity (untracked binding) until the user closes it by hand.
      const permanent = fixVerdictPermanent(verdict);
      // A review leg the generating lease failed (#87) under a Stop that never clears can never prove
      // a close: the tab is kept ("stalled", preserved and retired like a takeover), and its managed
      // slot freed so it stops holding tab capacity.
      const stalled = owned && !fixRun && msg.type === "ashlar-can-close" && state.result?.code === "stalled" &&
        typeof stopButtonVisible === "function" && stopButtonVisible();
      if (permanent || stalled || msg.preserve === true) releaseManagedSlot(state);
      reply({ok:true,releaseProtocol:1,blank:false,unsent:false,...verdict,owned:owned && !stalled,canClose:owned && !stalled,
        reason:stalled ? "stalled" : owned ? "complete" : permanent ? "repurposed" : "pending",
        running:Boolean(state.running),hasResult:Boolean(state.result || repairedCollectionResult(state) || sourceReceiptFor(state)),
        stopped:Boolean(state.runStopped),url:globalThis.location?.href || ""});
      return;
    }
    const repaired = repairedCollectionResult(state);
    if (repaired) { reply(repaired); return; }
    if (sourceReceiptFor(state)) {reply({ok:false,code:"captured",observation:{state:"source_archived"}});return;}
    if (state.result) { reply(fixAnswerReply(state, msg, state.result, busy)); return; }
    if (state.running) { reply(busy()); return; }
    if (msg.type === "ashlar-harvest") {
      reply({ ok: false, code: "idle", error: "no active review in this page" });
      return;
    }
    if (msg.resume && !state.jobId && !msg.adoptLegacy) {
      reply({ok: false, code: "disconnected", error: "original job binding is unavailable"});
      return;
    }
    // A new run message that arrives after its `until` (a delivery the worker stopped waiting for:
    // X4, #85) starts nothing: nothing is bound, stored or fenced, and the worker asks again. A
    // resume, or a copy for the run this page is already bound to, is not a new run.
    if (!msg.resume && !state.jobId && !(Number(msg.until) >= Date.now())) {
      reply({ok: false, code: "stale_run", retry: true, error: "the run message arrived after the worker stopped waiting for it; nothing was started"});
      return;
    }
    // A new ChatGPT run starts only on the fresh page its tab was opened on (the worker's
    // allocationUrl), with no user turn (X2, #85): a tab the user moved to their own conversation, or
    // sent a message in, before Ashlar's prompt went out is theirs. Nothing is bound, typed or sent
    // there, and the run is fenced, so a later copy of this message binds stopped. (Grok's runner
    // starts a new chat itself.)
    let freshPage;
    if (!msg.resume && !state.jobId && state.provider === "chatgpt") {
      const cause = freshPageLeft(msg.allocationUrl, null);
      if (cause) {
        fenceRun(state, msg.jobId, msg.runId);
        reply({ok: false, code: "taken_over", cause, error: "the tab is no longer the new chat it was opened on; nothing was sent"});
        return;
      }
      freshPage = globalThis.location?.href || "";
    }
    const resume = Boolean(msg.resume || state.jobId);
    state.freshPage = freshPage;
    state.jobId = String(msg.jobId);
    state.runId = state.runId || String(msg.runId || "");
    try { sessionStorage.setItem("ashlar:run", state.runId); } catch { /* in-memory binding remains */ }
    try { sessionStorage.setItem("ashlar:job", state.jobId); } catch { /* in-memory deduplication remains */ }
    state.running = true;
    // Only a fix item's run message carries its kind; review runs keep kind undefined.
    state.kind = msg.kind === "fix" ? "fix" : undefined;
    // A page is bound to one (job, run) for life: a stop already taken (even one whose marker could
    // not be written) holds, and a reload re-reads the marker.
    state.runStopped ||= runStoppedFor(state.jobId, state.runId);
    state.nativeCompletion = undefined;
    state.sourceTrackingOwner = undefined;
    state.repairProbeTracker = undefined;
    state.repairReceipt = undefined;
    state.observation = undefined;
    state.completedSource = undefined;
    state.completionTracking = undefined;
    state.repairedResult = undefined;
    state.repairedContext = undefined;
    state.repairedResponseId = undefined;
    Promise.resolve().then(() => state.run(String(msg.prompt || ""), msg.reasoning, resume))
      .then(raw => {
        if (sourceReceiptFor(state)) return; // Captured original is not parsed JSON.
        state.finishedContext = state.repairedContext || state.nativeCompletion?.context || reviewPageContext();
        state.result = { ok: true, raw, responseText: state.responseText, completion:nativeCleanupProof(state) };
      })
      .catch(e => {
        // A new run whose tab stopped being its fresh page before the send (throwIfStopped).
        const takenOver = e?.code === "taken_over";
        const leaseExpired = e?.code === "stalled"; // expireGeneratingLease (#87)
        recordReviewStep(e?.code === "quota" ? "quota" : e?.code === "cancelled" ? "cancelled" : takenOver ? "context_changed" :
          leaseExpired ? "lease_expired_generating" : "error");
        state.finishedContext = reviewPageContext();
        state.result = { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code || "error" };
      })
      .finally(() => { state.running = false; });
    reply(busy());
  };
  chrome.runtime.onMessage.addListener(state.listener);
}
