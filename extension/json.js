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

/** Read all rendered blocks from the current assistant message. A detached clone's
 * textContent includes hidden duplicate text and the first markdown may be prose.
 */
function cleanTurnText(el) {
  if (!el) return "";
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.matches("button, [role='button'], svg, script, style, template, [hidden], [aria-hidden='true'], [data-content-reference-start]")) return "";
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(walk).join("");
    return /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.tagName) ? `\n${text}\n` : text;
  };
  return walk(el).trim();
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
      const text = (pre.querySelector("code") || pre).textContent || "";
      if (text.trim()) blocks.push(text);
    }
  }
  return blocks;
}

/** Whether `el` is visible up to `root` (cleanTurnText's exclusions: hidden, aria-hidden,
 * template, display:none, visibility:hidden, opacity 0). */
function renderedIn(el, root) {
  for (let node = el; node && node !== root.parentElement; node = node.parentElement) {
    if (node.matches?.("[hidden], [aria-hidden='true'], template")) return false;
    const style = globalThis.window?.getComputedStyle ? window.getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
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
  // when it appears rather than staying on the weaker positional fallback.
  if (!submission.messageId && user.getAttribute("data-message-id")) {
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
  return {root, followup: next >= 0, identified: true, responseId: message.getAttribute("data-message-id") || ""};
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
  return {runner, bound, stop, streaming, done};
}

/** A quota banner ends the run only while no answer is in hand and the banner can belong to it
 * (no bound response yet, or the identified response with no follow-up). */
function throwIfQuota(name, bound, answered) {
  if ((!bound || (bound.identified && !bound.followup)) && quotaHit() && !answered) {
    const error = new Error(`${name} usage limit`); error.code = "quota"; throw error;
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
  // No poll-count/elapsed-time failure. Controls can appear before response text is
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
 * "unknown": the turn is not rendered/resolvable. Independent of the composer draft. */
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
  return normalizePrompt(messagePromptText(turn)) === submission.expected ? "exact" : "edited";
}

/** A review-loop FIX answer is plain text for the server's deterministic fix parser: harvest
 * the bound response's fenced code blocks (literal text, see assistantCodeBlocks) — or, when it
 * has none, a fixed no-JSON line — after the same positive completion controls and two identical stable
 * observations as a review, with no review-JSON requirement and no capture/repair evidence (a
 * fix item has neither lane). No page timer ends it: the server's fix deadline cancels the item
 * and the worker's ashlar-fix-cancel stops this collector.
 */
async function waitUntilFixOrQuota(name) {
  const stability = {stable: "", hits: 0};
  let edited = false;
  for (;;) {
    if (globalThis.__ashlarRunnerState?.fixCancelled) {
      const error = new Error("fix request cancelled by the server"); error.code = "cancelled"; throw error;
    }
    // Same completion evidence, quota rule and stability as a review (shared helpers above).
    const poll = await pollBoundResponse();
    const {runner, bound, stop, streaming, done} = poll;
    // Only the response identified as the answer to THIS run's sent prompt is a fix answer. With no
    // sent journal or no identified response, the page-global fallbacks would read whatever chat
    // is on screen: that is never an answer (a review keeps its legacy unbound observation).
    // The bound match only proves the sent turn CONTAINS the prompt: a fix answer also needs the
    // journaled turn to be EXACTLY Ashlar's prompt. A turn the user edited is theirs: the tab is
    // repurposed and its response is never a fix answer, even if the edit is later undone. An
    // unresolvable turn is not harvested yet.
    let integrity = "unknown";
    if (bound?.identified && bound.root && !edited) {
      const submission = typeof readSubmissionJournal === "function" ? await readSubmissionJournal() : null;
      integrity = journaledTurnIntegrity(submission, globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : []);
      if (integrity === "edited") {
        edited = true;
        if (runner && !runner.tabRepurposed) { runner.tabRepurposed = true; recordReviewStep("context_changed"); }
      }
    }
    const own = integrity === "exact" ? bound.root : null;
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
      if (settleStableAnswer(stability, text, poll, {text, raw: text})) return text;
    } else { stability.hits = 0; stability.stable = ""; }
    await (typeof waitForPageChange === "function" ? waitForPageChange(800) : sleep(800));
  }
}

/** May a cancelled fix item's tab be force-closed? Only while it shows nothing but Ashlar's own
 * work. Before the prompt is confirmed sent, the fresh chat Ashlar opened holds at most Ashlar's
 * own prompt: in the composer (a draft then is Ashlar's half-typed prompt) or as the just-clicked,
 * not yet confirmed turn. After confirmation the bound response is identified, no follow-up turn
 * exists and the composer holds no user draft. Anything unknown preserves the tab — a user's
 * conversation is never closed.
 */
/** Who holds a cancelled fix tab: "owned" (only Ashlar's work in it), "takenOver" (the user sent a
 * follow-up, typed a draft or opened another conversation) or "unknown" (the journal is
 * unreadable, or the sent turn is not rendered yet after a reload): the worker asks again. */
function fixTabOwnership(state) {
  if (state.tabRepurposed) return {ownership: "takenOver"};
  let submission;
  try { submission = state.confirmedSubmission?.record || savedSubmission(); } catch { return {ownership: "unknown"}; }
  const users = globalThis.document ? [...document.querySelectorAll('[data-message-author-role="user"]')] : [];
  const draftText = composerDraftText();
  if (submission?.phase !== "sent") {
    // Before the send is confirmed the composer may still hold Ashlar's own prompt, and the
    // just-clicked turn is Ashlar's prompt. Ownership needs the EXACT prompt (the same test
    // clickSend applies before sending): any text beyond it — a prefix, a suffix, an edit — is
    // the user's, and the tab is preserved.
    const ashlars = text => Boolean(submission?.expected) && normalizePrompt(text) === submission.expected;
    if (draftText && !ashlars(draftText)) return {ownership: "takenOver"};
    // No turn and at most Ashlar's own draft: the content proves nothing about WHICH page this is
    // (an empty conversation the user moved to looks the same), so the verdict is `blank` and the
    // worker also requires the page the fix tab was opened on.
    if (!users.length) return {ownership: "owned", blank: true};
    return {ownership: submission?.baseline === 0 && users.length === 1 && ashlars(messagePromptText(users[0])) ? "owned" : "takenOver"};
  }
  const bound = boundReviewResponse(submission);
  if (bound.followup) return {ownership: "takenOver"};
  if (!bound.identified) return {ownership: users.length ? "takenOver" : "unknown"};
  // The bound match only proves the sent turn CONTAINS Ashlar's prompt; an edited turn (a prefix
  // or suffix the user added) is the user's. Ownership needs the journaled turn (its message ID,
  // pinned by the bound match, else its recorded position) to hold EXACTLY the prompt.
  const integrity = journaledTurnIntegrity(submission, users);
  if (integrity === "unknown") return {ownership: "unknown"};
  if (integrity === "edited") return {ownership: "takenOver"};
  return {ownership: draftText ? "takenOver" : "owned"};
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
    reply = value => respond({...value, jobId: state.jobId, provider: state.provider, runId: state.runId, progress: reviewProgress()});
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
      // Positive binding only: an unbound page is never evidence that this tab is Ashlar's —
      // except the tab the worker opened for this fix and never sent its run (undispatched):
      // that one is Ashlar's only while it holds nothing of the user's (no turn, no draft).
      if (msg.undispatched === true && !state.jobId && !state.runId) {
        const turns = globalThis.document ? document.querySelectorAll('[data-message-author-role="user"]').length : 0;
        const blank = !turns && !composerDraftText();
        reply({ok:true,owned:blank,ownership:blank ? "owned" : "takenOver",blank,url:globalThis.location?.href || ""});return;
      }
      if (!state.jobId || msg.jobId !== state.jobId || !state.runId || msg.runId !== state.runId) {
        reply({ok:false,code:"job_mismatch"});return;
      }
      state.fixCancelled = true; // The server settled this fix; stop collecting an answer for it.
      const {ownership, blank = false} = fixTabOwnership(state);
      // A tab the user took over (or one the worker gives up identifying: preserve) stays open but
      // is no longer Ashlar's: free its managed slot, or it counts against tab capacity (untracked
      // binding) until the user closes it by hand.
      if (ownership === "takenOver" || msg.preserve === true) releaseManagedSlot(state);
      reply({ok:true,owned:ownership === "owned",ownership,blank,url:globalThis.location?.href || ""});return;
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
      const bound = submission?.phase === "sent" ? boundReviewResponse(submission) : null;
      if (!bound?.identified || !bound.root || !replyDoneVisible(bound.root) || stopButtonVisible() || responseStreaming(bound.root)) {
        reply({ok:false,code:"completion_unavailable"});return;
      }
      const proof=msg.completion;
      // A fix answer is its own plain text; a review result must be the JSON of that text.
      if (!proof?.responseId || typeof proof.context !== "string" || typeof msg.text !== "string" || typeof msg.raw !== "string" ||
          !(msg.kind === "fix" ? msg.raw === msg.text : extractChatJson(msg.raw) && extractChatJson(msg.raw) === extractChatJson(msg.text)) || bound.followup ||
          bound.responseId !== proof.responseId || proof.context !== reviewPageContext() || boundAnswerText(msg.kind, bound.root) !== msg.text) {
        releaseManagedSlot(state);
        reply({ok:false,code:"completion_changed"});return;
      }
      state.nativeCompletion = Object.freeze({jobId:state.jobId,provider:state.provider,runId:state.runId,
        responseId:proof.responseId,context:proof.context,text:msg.text,raw:msg.raw});
      if (msg.kind === "fix") state.kind = "fix"; // later proofs compare this run's fenced answer
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
      reply({ok:true,raw:state.nativeCompletion.raw,responseText:state.nativeCompletion.text,completion:nativeCleanupProof(state)});return;
    }
    if (state.result) { reply(state.result); return; }
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
        recordReviewStep(e?.code === "quota" ? "quota" : "error");
        state.finishedContext = reviewPageContext();
        state.result = { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code || "error" };
      })
      .finally(() => { state.running = false; });
    reply(busy());
  };
  chrome.runtime.onMessage.addListener(state.listener);
}
