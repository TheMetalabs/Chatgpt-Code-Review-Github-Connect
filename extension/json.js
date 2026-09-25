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
  // when it appears rather than staying on the weaker positional fallback. A fix
  // journal (it carries the conversation its send was proven in) records it only
  // while the page still shows that conversation: after an in-page move the turn at
  // the recorded position proves nothing about the send. Review journals: unchanged.
  if (!submission.messageId && user.getAttribute("data-message-id") &&
      (!submission.conversation || submission.conversation === conversationIdentity(globalThis.location?.href))) {
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
  if (bound.followup) state.tabRepurposed = true;
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
  return {text, totalChars:text.length, truncated:false, responseId:bound.responseId, context:reviewPageContext(), completed:true, stable:true};
}

/** Repair acceptance does not transfer ownership of a later user conversation.
 * Preserve the context validated at receipt even across a suspended collector,
 * its completion microtask, and duplicate acknowledgement delivery.
 */
function preserveRepairContext(state) {
  let bound;
  try {
    const submission = state.confirmedSubmission?.record || savedSubmission();
    if (submission?.phase === "sent") bound = boundReviewResponse(submission);
  } catch { /* Unknown identity preserves the tab, not permission to close it. */ }
  const receipt = state.repairReceipt;
  const context = receipt?.context || state.repairedContext;
  const responseId = receipt?.responseId || state.repairedResponseId;
  if (!state.tabRepurposed && (!context || context !== reviewPageContext() ||
      !bound?.identified || !bound.root || bound.followup || bound.responseId !== responseId ||
      (receipt && assistantCorpus(bound.root).join("\n\n") !== receipt.text))) {
    state.tabRepurposed = true;
    recordReviewStep("context_changed");
  }
  return bound;
}

/** A source archive receipt or native completion proof pins the original
 * response separately from mutable collector fields. Capture is NOT parsed JSON.
 */
function sourceReceiptFor(state) {
  const value = state?.captureReceipt;
  return value && value.jobId === state.jobId && value.runId === state.runId && value.provider === state.provider ? value : null;
}
function preserveSourceContext(state, receipt) {
  let bound;
  try {
    const submission = state.confirmedSubmission?.record || savedSubmission();
    if (submission?.phase === "sent") bound = boundReviewResponse(submission);
  } catch { /* Unknown ownership never authorizes closure. */ }
  if (!state.tabRepurposed && (!bound?.identified || !bound.root || bound.followup ||
      bound.responseId !== receipt.responseId || receipt.context !== reviewPageContext() ||
      boundAnswerText(state.kind, bound.root) !== receipt.text)) {
    state.tabRepurposed = true;
    recordReviewStep("context_changed");
  }
  return bound;
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

/** One poll of the response bound to this run's sent prompt: the completion evidence both
 * collectors (review JSON, fix code) decide on. A follow-up turn marks the tab repurposed. A
 * later request's global Stop cannot end or block this older response: completion needs the
 * positive controls on the original response itself. */
async function pollBoundResponse() {
  const runner = globalThis.__ashlarRunnerState;
  const submission = typeof readSubmissionJournal === "function" ? await readSubmissionJournal() : null;
  const bound = submission?.phase === "sent" ? boundReviewResponse(submission) : undefined;
  if (bound?.followup && runner && !runner.tabRepurposed) {
    runner.tabRepurposed = true;
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
    // The full original was secured, not accepted as a review. The worker owns
    // further formatting; no page loop or new model request is needed.
    if (sourceReceiptFor(globalThis.__ashlarRunnerState)) return null;
    if (globalThis.__ashlarRunnerState?.repairedResult) {
      preserveRepairContext(globalThis.__ashlarRunnerState);
      recordReviewStep("repair_accepted");
      return globalThis.__ashlarRunnerState.repairedResult;
    }
    const poll = await pollBoundResponse();
    const {runner, bound, stop, streaming, done} = poll;
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
  if (typeof submission.exact === "string") {
    // A rich-text turn's block boundaries read two ways: one <p> per blank-line paragraph with a <br>
    // per line break (messagePromptText), or one <p> per line, the composer's own structure
    // (losslessText). Either reading can prove it exact; any other whitespace difference is an edit.
    const body = turn.querySelector?.('[data-testid="collapsible-user-message-content"]') || turn;
    return [messagePromptText(turn), losslessText(body)].some(text => fixPromptForm(text) === submission.exact) ? "exact" : "edited";
  }
  return normalizePrompt(messagePromptText(turn)) === submission.expected ? "exact" : "edited";
}

/** The identity of the conversation a page shows: its URL without the fragment (the path names the
 * conversation; the query is part of it too, e.g. ChatGPT's temporary chat). */
function conversationIdentity(href) {
  return typeof href === "string" ? href.split("#")[0] : "";
}

/* A fix's conversation identity is recorded ONCE, when its send is proven: composer.js
 * submissionConfirmed writes `conversation` into the submission journal from the location at that
 * instant (only for a send this page instance clicked, still shown where it was clicked). Every fix
 * decision below only COMPARES the current location with it; none records one. There is no
 * location-based pin or upgrade after the send: a later URL is no evidence of whose conversation it
 * is (the user can move in-page while the old DOM is still rendered), and neither provider's DOM
 * ties a conversation id to the sent turn or its response (both expose only per-message ids). A
 * journal without it (legacy, recorded before this rule, or a confirmation seen only after a
 * reload) is `identity:"unestablished"` for good: never harvested, never closed. The fix provider
 * is ChatGPT only, and a fix tab always opens on its temporary chat (fixChatPage), whose URL never
 * changes: a send-time identity that is not that page (a fix sent anywhere else) is
 * `unestablished` too. Persisted with the journal (sessionStorage), so it survives a reload. */

/** The only conversation a fix run can be proven in: ChatGPT's temporary chat, the page every fix
 * tab is opened on (background.js providerUrl). Its URL never changes after the send. */
function fixChatPage() { return "https://chatgpt.com/?temporary-chat=true"; }

/** Whether the page still shows the conversation its fix was bound in. */
function fixConversationHolds(submission) {
  return submission?.conversation === fixChatPage() && conversationIdentity(globalThis.location?.href) === fixChatPage();
}

/** The send-time conversation of this page's fix run ("" when none is established or readable). */
function sentFixConversation(state) {
  try {
    const submission = state.confirmedSubmission?.record || savedSubmission();
    return typeof submission?.conversation === "string" ? submission.conversation : "";
  } catch { return ""; }
}

/** The answer this fix run collected (what the worker delivers, and what every later close must
 * still see): the native completion proof when the response carried an ID, else the collected text. */
function storedFixCompletion(state) {
  const proof = state.nativeCompletion;
  if (proof && proof.jobId === state.jobId && proof.runId === state.runId && proof.provider === state.provider &&
      typeof proof.text === "string") return {responseId: proof.responseId || "", text: proof.text};
  return state.result?.ok === true && typeof state.result.responseText === "string" ? {responseId: "", text: state.result.responseText} : null;
}

/** THE ownership proof of a fix tab. Every fix decision calls it at the moment it acts and acts
 * only on its verdict: collecting an answer (phase "collect"), replying with a collected answer,
 * restoring a completion proof and closing after a delivered answer ("complete"); a permanent
 * non-owned verdict is also what releases the managed slot. There is no cancel-phase proof: a fix
 * tab is closed only on the proven-success path (background.js cleanupFixTab), and a cancelled fix
 * is always preserved. `journal`: the submission journal the caller just read (default: the
 * confirmed or saved one). `pinned` ("collect"): the response the collector pinned at its first
 * answered observation (waitUntilFixOrQuota).
 *
 * owned = the journaled sent turn is EXACTLY Ashlar's prompt (journaledTurnIntegrity "exact"), no
 * follow-up turn, no user draft, the page still shows the conversation its send was made in,
 * ("collect") the bound response is still the pinned one, and ("complete") the currently bound
 * response is done and still the stored completion (response ID
 * and answer text; `completion` overrides the stored one, for a restore). takenOver = the user's
 * (follow-up, edited turn, draft, another response); unknown = not provable now (journal
 * unreadable, not sent, turn not rendered, identity not recorded at send or moved: `identity`
 * "unestablished" | "changed", still generating). Every takenOver verdict is PERMANENT: it marks the
 * tab repurposed for good (a draft the user later clears, or an edit the user undoes, does not hand
 * the tab back); see fixVerdictPermanent for what ends a run. */
function fixOwnershipProof(state, {phase, completion, journal, pinned} = {}) {
  const verdict = (ownership, reason, extra = {}) => ({ownership, reason, ...extra});
  const takeOver = reason => {
    if (!state.tabRepurposed) { state.tabRepurposed = true; recordReviewStep("context_changed"); }
    return verdict("takenOver", reason);
  };
  if (state.tabRepurposed) return verdict("takenOver", "repurposed");
  let submission = journal;
  if (!submission) {
    try { submission = state.confirmedSubmission?.record || savedSubmission(); } catch { return verdict("unknown", "journal_unreadable"); }
  }
  // Nothing was sent: there is no answer to collect or to close after.
  if (submission?.phase !== "sent") return verdict("unknown", "not_sent");
  // PERMANENT verdicts first: none of them needs the response to be identified, so no transient
  // wait (a turn not rendered or resolved yet, the prompt echoed in the composer) can hide one
  // until the deadline.
  // 1. The conversation. The rendered turn proves its content only; an in-page (SPA) move to another
  // conversation can leave this DOM on screen under the new URL, or remove it: the proof holds only
  // in the conversation recorded when the send was proven (composer.js submissionConfirmed); a
  // journal without one never gains it. Nor does one without its prompt's lossless form (`exact`,
  // recorded by composer.js clickSend when the send is prepared): its turn can never be proven exact.
  if (submission.conversation !== fixChatPage() || typeof submission.exact !== "string") {
    return verdict("unknown", "unestablished", {identity: "unestablished"});
  }
  if (!fixConversationHolds(submission)) return verdict("unknown", "moved", {identity: "changed", conversation: submission.conversation});
  // 2. The journal-addressable sent turn (its message ID, else its recorded position) holds EXACTLY
  // Ashlar's prompt. boundReviewResponse only proves the turn CONTAINS it, and finds no turn at all
  // once the user replaced its text: an edited or replaced turn is the user's, even if undone later.
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  const integrity = journaledTurnIntegrity(submission, users);
  if (integrity === "edited") return takeOver("edited");
  const draftText = composerDraftText();
  const bound = boundReviewResponse(submission);
  const answered = phase === "complete";
  if (bound.followup) return takeOver("followup");
  // 3. A draft in the composer. The just-sent prompt can linger there a moment after the send is
  // confirmed: that text (the journal's own expected prompt) is Ashlar's, not evidence of a user.
  // Any other draft is the user's, decided on the poll that sees it and BEFORE the transient waits
  // below (turn not rendered or not resolvable yet): a draft typed and cleared while the turn is
  // briefly unresolved still latches the takeover.
  if (draftText && normalizePrompt(draftText) !== submission.expected) return takeOver("draft");
  // 4. ("collect") The pinned response. boundReviewResponse always binds the LAST reply after the
  // sent turn, so a response regenerated after the first answered observation would bind instead:
  // any other response (another ID; with no ID, another assistant message node) is the user's.
  // An ID-less pin adopts the ID its own node gains later (renderers can assign it after mounting
  // the text): the same node is the same response, never another one.
  if (pinned && bound.root) {
    if (!pinned.responseId && bound.responseId && bound.message === pinned.message) pinned.responseId = bound.responseId;
    if ((bound.responseId || "") !== pinned.responseId || (!pinned.responseId && bound.message !== pinned.message)) return takeOver("response_changed");
  }
  if (!bound.identified) {
    // A collected answer whose turn is gone was replaced (edited, regenerated or deleted). Still in
    // the recorded conversation with no addressable turn: not rendered yet (transient).
    return answered ? takeOver("response_changed") : verdict("unknown", "turn_unrendered");
  }
  if (integrity === "unknown") return verdict("unknown", "turn_unresolved");
  if (draftText) return verdict("unknown", "composer_echo");
  if (answered) {
    const stored = completion || storedFixCompletion(state);
    if (!stored) return verdict("unknown", "no_completion", {conversation: submission.conversation});
    // A completion collected with no response ID is identified by its text (checked below), so an ID
    // the response gained after collection does not make it another one.
    if (!bound.root || (stored.responseId && (bound.responseId || "") !== stored.responseId)) return takeOver("response_changed");
    const busy = (typeof stopButtonVisible === "function" && stopButtonVisible()) ||
      (typeof responseStreaming === "function" && globalThis.document && responseStreaming(bound.root)) || !replyDoneVisible(bound.root);
    if (busy) return verdict("unknown", "generating", {conversation: submission.conversation});
    if (boundAnswerText("fix", bound.root) !== stored.text) return takeOver("response_changed");
  }
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
  if (!state.tabRepurposed) { state.tabRepurposed = true; recordReviewStep("context_changed"); }
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
    state.restoredCompletion = false;
    return {...state.result, ownership: proof.ownership};
  }
  if (proof.ownership !== "owned") return {...busy(), ownership: proof.ownership, proof: proof.reason};
  return {...value, ownership: "owned"};
}

/** can-close for a fix run: its answer is in hand and the full proof holds right now. A tab the
 * user took over (or one moved off, or never given, its send-time conversation) is released and preserved. */
function fixCanClose(state) {
  const url = globalThis.location?.href || "";
  // A run that ended on a permanent verdict (endFixRun) left a tab that is the user's for good.
  if (state.tabRepurposed) {
    releaseManagedSlot(state);
    return {ok: true, canClose: false, reason: "repurposed", ownership: "takenOver", proof: "repurposed", url};
  }
  if ((!state.restoredCompletion && state.running) || state.result?.ok !== true || state.submissionPersistencePending) {
    return {ok: true, canClose: false, reason: "pending", ownership: "unknown", url};
  }
  const proof = fixOwnershipProof(state, {phase: "complete"});
  if (fixVerdictPermanent(proof)) {
    releaseManagedSlot(state);
    return {ok: true, canClose: false, reason: "repurposed", ownership: proof.ownership, proof: proof.reason, url};
  }
  if (proof.ownership !== "owned") return {ok: true, canClose: false, reason: "pending", ownership: proof.ownership, proof: proof.reason, url};
  return {ok: true, canClose: true, reason: "complete", ownership: "owned", proof: proof.reason, url};
}

/** A review-loop FIX answer is plain text for the server's deterministic fix parser: harvest
 * the bound response's fenced code blocks (literal text, see assistantCodeBlocks) — or, when it
 * has none, a fixed no-JSON line — after the same positive completion controls and two identical stable
 * observations as a review, with no review-JSON requirement and no capture/repair evidence (a
 * fix item has neither lane). It ends on the answer, on quota, on a PERMANENT ownership verdict
 * (fixVerdictPermanent: `taken_over` at once, never at the deadline) or when the server settles the
 * item (the worker's ashlar-fix-cancel); no page timer ends a transient wait: the fix deadline bounds it.
 */
async function waitUntilFixOrQuota(name) {
  // `pinned`: the response this run collects, fixed at its first answered observation and never
  // replaced (a regenerated response ends the run: fixOwnershipProof "collect"); an ID-less pin only
  // gains the ID its own node is assigned later.
  const stability = {stable: "", hits: 0, pinned: undefined};
  for (;;) {
    if (globalThis.__ashlarRunnerState?.fixCancelled) {
      const error = new Error("fix request cancelled by the server"); error.code = "cancelled"; throw error;
    }
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

/** Short message replies keep MV3 workers recoverable; the page owns the long model call.
 * State survives script reinjection and retains terminal outcomes for a restarted worker.
 */
function reviewPageContext() {
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  const last = users.at(-1);
  return JSON.stringify([globalThis.location?.href || "", users.length,
    last?.getAttribute("data-message-id") || "", last?.textContent || ""]);
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
  if (state.listener && state.protocol === "observed-submission-v6") return;
  if (state.listener) chrome.runtime.onMessage.removeListener(state.listener);
  state.protocol = "observed-submission-v6";
  const busy = () => ({ ok: false, code: "busy", retry: true, error: "generation pending", observation: state.observation });
  state.listener = (msg, _sender, reply) => {
    // Read-only inventory: never adopt a page, collect a prompt, or start a run.
    if (msg?.type === "ashlar-tab-status") {
      reply({ok:true,ownershipProtocol:1,jobId:state.jobId || "",runId:state.runId || "",provider:state.provider,
        released:Boolean(state.slotReleased),url:globalThis.location?.href || ""});return;
    }
    if (!["ashlar-run", "ashlar-harvest", "ashlar-can-close", "ashlar-repair-source", "ashlar-repair-accepted",
      "ashlar-capture-accepted", "ashlar-result-saved", "ashlar-fix-cancel"].includes(msg?.type)) return;
    const respond = reply;
    reply = value => respond({...value, jobId: state.jobId, provider: state.provider, runId: state.runId, progress: reviewProgress(),
      // A fix run reports the conversation its send was made in (recorded at send) so the worker keeps it;
      // review replies stay exactly as before.
      ...(msg.kind === "fix" && !value?.conversation && state.jobId && msg.jobId === state.jobId && state.runId && msg.runId === state.runId && sentFixConversation(state)
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
    if (msg.type === "ashlar-fix-cancel") {
      // The worker preserves this fix tab (every end but the proven-success close): stop the run
      // and free the managed slot, or the tab counts against capacity (untracked binding) until the
      // user closes it by hand. It authorises nothing else (never a close), so it carries no
      // ownership verdict. Positive binding only: another page's run is never touched.
      if (!state.jobId || msg.jobId !== state.jobId || !state.runId || msg.runId !== state.runId) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      state.fixCancelled = true;
      releaseManagedSlot(state);
      reply({ok:true,released:true,url:globalThis.location?.href || ""});return;
    }
    // Capture and JSON repair are review-JSON machinery: a fix run never takes part in them.
    if (["ashlar-capture-accepted", "ashlar-repair-source", "ashlar-repair-accepted"].includes(msg.type) && (msg.kind === "fix" || state.kind === "fix")) {
      reply({ok:false,code:"job_mismatch",error:"a fix run has no capture or repair lane"});return;
    }
    if (["ashlar-capture-accepted", "ashlar-result-saved"].includes(msg.type)) {
      if (!state.jobId || !state.runId || msg.runId !== state.runId || msg.provider !== state.provider || msg.committed !== true) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      if (msg.type === "ashlar-capture-accepted") {
        const receipt = sourceReceiptFor(state);
        if (receipt) {
          preserveSourceContext(state,receipt);
          reply(receipt.id === msg.captureId && receipt.responseId === msg.responseId && receipt.text === msg.text && receipt.context === msg.context
            ? {ok:true,accepted:true} : {ok:false,code:"capture_source_changed"});return;
        }
        const source = currentRepairSource();
        if (!source) {
          // A fresh/reloaded page can need another identical observation before
          // source stability is established. Distinguish that from a genuinely
          // repurposed or regenerated response so cleanup can safely preserve it.
          let submission, bound, currentText = "";
          try {
            submission = state.confirmedSubmission?.record || savedSubmission();
            if (submission?.phase === "sent") bound = boundReviewResponse(submission);
            if (bound?.root && !bound.followup && replyDoneVisible(bound.root) && !stopButtonVisible() && !responseStreaming(bound.root))
              currentText = assistantCorpus(bound.root).join("\n\n");
          } catch { /* unavailable remains retryable */ }
          if (typeof msg.context === "string" && (msg.context !== reviewPageContext() || bound?.followup ||
              (currentText && currentText !== msg.text))) {
            releaseManagedSlot(state);
            reply({ok:false,code:"capture_source_changed"});return;
          }
          reply({ok:false,code:"capture_source_unavailable"});return;
        }
        if (!msg.captureId || typeof msg.context !== "string") {reply({ok:false,code:"capture_source_changed"});return;}
        if (source.responseId !== msg.responseId || source.text !== msg.text) {
          // The worker secured its original elsewhere. The replacement is user-owned.
          releaseManagedSlot(state);
          reply({ok:false,code:"capture_source_changed"});return;
        }
        state.captureReceipt = Object.freeze({id:msg.captureId,jobId:state.jobId,runId:state.runId,provider:state.provider,
          responseId:source.responseId,text:source.text,context:msg.context});
        preserveSourceContext(state,state.captureReceipt);
        recordReviewStep("source_archived");
        reply({ok:true,accepted:true});return;
      }
      // Restore only a previously collected+ACKed exact response, not another run
      // or a new DOM result selected just because it happens to be the newest.
      let submission;
      try { submission = state.confirmedSubmission?.record || savedSubmission(); } catch { /* preserved */ }
      if (msg.kind === "fix" || state.kind === "fix") {
        // A permanent fix verdict (moved or unestablished conversation, an edited or replaced sent
        // turn, a follow-up, a draft) needs no rendered response: it is decided BEFORE the response
        // availability below, so a tab the user took over is never answered "unavailable" (retry).
        const early = fixOwnershipProof(state, {phase: "collect", journal: submission});
        if (fixVerdictPermanent(early)) {
          releaseManagedSlot(state);
          reply({ok:false,code:"completion_changed",proof:early.reason});return;
        }
      }
      const bound = submission?.phase === "sent" ? boundReviewResponse(submission) : null;
      if (!bound?.identified || !bound.root || !replyDoneVisible(bound.root) || stopButtonVisible() || responseStreaming(bound.root)) {
        reply({ok:false,code:"completion_unavailable"});return;
      }
      const proof=msg.completion;
      if (msg.kind === "fix" || state.kind === "fix") {
        // A fix answer is its own plain text, and it is restored only while the full ownership proof
        // holds for exactly that completion (fixOwnershipProof "complete").
        if (!proof?.responseId || typeof proof.context !== "string" || typeof msg.text !== "string" || msg.raw !== msg.text) {
          releaseManagedSlot(state);
          reply({ok:false,code:"completion_changed"});return;
        }
        state.kind = "fix"; // later proofs compare this run's fenced answer
        const verdict = fixOwnershipProof(state, {phase: "complete", completion: {responseId: proof.responseId, text: msg.text}});
        if (fixVerdictPermanent(verdict)) {
          releaseManagedSlot(state);
          reply({ok:false,code:"completion_changed",proof:verdict.reason});return;
        }
        if (verdict.ownership !== "owned") { reply({ok:false,code:"completion_unavailable",proof:verdict.reason});return; }
        state.nativeCompletion = Object.freeze({jobId:state.jobId,provider:state.provider,runId:state.runId,
          responseId:proof.responseId,context:proof.context,text:msg.text,raw:msg.raw});
        state.restoredCompletion = true;
        state.finishedContext = proof.context;
        state.result = {ok:true,raw:msg.raw,responseText:msg.text,completion:nativeCleanupProof(state)};
        recordReviewStep("cleanup_restored");reply({ok:true,accepted:true});return;
      }
      // A review result must be the JSON of that text.
      if (!proof?.responseId || typeof proof.context !== "string" || typeof msg.text !== "string" || typeof msg.raw !== "string" ||
          !(extractChatJson(msg.raw) && extractChatJson(msg.raw) === extractChatJson(msg.text)) || bound.followup ||
          bound.responseId !== proof.responseId || proof.context !== reviewPageContext() || boundAnswerText(undefined, bound.root) !== msg.text) {
        releaseManagedSlot(state);
        reply({ok:false,code:"completion_changed"});return;
      }
      state.nativeCompletion = Object.freeze({jobId:state.jobId,provider:state.provider,runId:state.runId,
        responseId:proof.responseId,context:proof.context,text:msg.text,raw:msg.raw});
      state.restoredCompletion = true;
      state.finishedContext = proof.context;
      state.result = {ok:true,raw:msg.raw,responseText:msg.text,completion:nativeCleanupProof(state)};
      recordReviewStep("cleanup_restored");reply({ok:true,accepted:true});return;
    }
    if (["ashlar-repair-source", "ashlar-repair-accepted"].includes(msg.type)) {
      if (!state.jobId || !state.runId || msg.runId !== state.runId || msg.provider !== state.provider) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      if (msg.type === "ashlar-repair-accepted" && repairedCollectionResult(state)) {
        const receipt = state.repairReceipt;
        const same = msg.committed === true && msg.repairId === receipt.repairId &&
          msg.responseId === receipt.responseId && msg.text === receipt.text && msg.raw === receipt.result.raw;
        preserveRepairContext(state);
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
      preserveRepairContext(state);
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
    if (msg.type === "ashlar-can-close") {
      // A fix tab closes only on the full ownership proof, re-established now (fixCanClose).
      if (msg.kind === "fix" || state.kind === "fix") { reply(fixCanClose(state)); return; }
      // Final authorization must recheck the assistant, not just URL/user turns.
      // A cached result can outlive its collector and the displayed response.
      const repaired = repairedCollectionResult(state);
      const captured = sourceReceiptFor(state);
      const native = nativeCleanupProof(state) ? state.nativeCompletion : undefined;
      const bound = (repaired || state.repairedResult) ? preserveRepairContext(state)
        : captured || native ? preserveSourceContext(state,captured || native) : undefined;
      const context = repaired ? state.repairReceipt.context : captured?.context || native?.context || state.finishedContext;
      const pending = (!repaired && !captured && !state.restoredCompletion && state.running) ||
        !(repaired || captured || state.result) || !context || state.submissionPersistencePending;
      const unchanged = !state.tabRepurposed && context === reviewPageContext();
      const busyNow = (typeof stopButtonVisible === "function" && stopButtonVisible()) ||
        Boolean(bound?.root && typeof responseStreaming === "function" && responseStreaming(bound.root)) ||
        Boolean((captured || native) && bound?.root && !replyDoneVisible(bound.root));
      // User follow-ups/navigation transfer the tab back to the user. Do not close it.
      const hasDraft = Boolean(composerDraftText());
      if (!pending && (!unchanged || hasDraft)) releaseManagedSlot(state);
      reply({ok: true, canClose: !pending && unchanged && !busyNow && !hasDraft,
        reason: pending ? "pending" : !unchanged || hasDraft ? "repurposed" : busyNow ? "pending" : "complete",
        url: globalThis.location?.href || ""});
      return;
    }
    const repaired = repairedCollectionResult(state);
    if (repaired) { reply(repaired); return; }
    if (sourceReceiptFor(state)) {reply({ok:false,code:"captured",observation:{state:"source_archived"}});return;}
    if (state.restoredCompletion && state.nativeCompletion) {
      reply(fixAnswerReply(state, msg, {ok:true,raw:state.nativeCompletion.raw,responseText:state.nativeCompletion.text,completion:nativeCleanupProof(state)}, busy));return;
    }
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
    const resume = Boolean(msg.resume || state.jobId);
    state.jobId = String(msg.jobId);
    state.runId = state.runId || String(msg.runId || "");
    try { sessionStorage.setItem("ashlar:run", state.runId); } catch { /* in-memory binding remains */ }
    try { sessionStorage.setItem("ashlar:job", state.jobId); } catch { /* in-memory deduplication remains */ }
    state.running = true;
    // Only a fix item's run message carries its kind; review runs keep kind undefined.
    state.kind = msg.kind === "fix" ? "fix" : undefined;
    state.fixCancelled = false;
    state.nativeCompletion = undefined;
    state.restoredCompletion = false;
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
        if (state.repairedResult) preserveRepairContext(state);
        state.finishedContext = state.repairedContext || state.nativeCompletion?.context || reviewPageContext();
        state.result = { ok: true, raw, responseText: state.responseText, completion:nativeCleanupProof(state) };
      })
      .catch(e => {
        const leaseExpired = e?.code === "stalled"; // expireGeneratingLease (#87)
        recordReviewStep(e?.code === "quota" ? "quota" : leaseExpired ? "lease_expired_generating" : "error");
        state.finishedContext = reviewPageContext();
        state.result = { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code || "error" };
      })
      .finally(() => { state.running = false; });
    reply(busy());
  };
  chrome.runtime.onMessage.addListener(state.listener);
}
