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
  return {root, followup: next >= 0, identified: true};
}

async function waitUntilReviewOrQuota(name) {
  let stable = "", hits = 0;
  // No poll-count/elapsed-time failure. Controls can appear before response text is
  // observable. A missing/invalid JSON slice is an observation, never an empty reply.
  for (;;) {
    const submission = typeof readSubmissionJournal === "function" ? await readSubmissionJournal() : null;
    const bound = submission?.phase === "sent" ? boundReviewResponse(submission) : undefined;
    const runner = globalThis.__ashlarRunnerState;
    if (bound?.followup && runner && !runner.tabRepurposed) {
      runner.tabRepurposed = true;
      recordReviewStep("context_changed");
    }
    // A later request's global Stop/quota cannot end or block this older response.
    // Require positive completion controls on the original response itself.
    const stop = bound && !bound.root ? false : bound?.followup ? stopButtonVisible(bound.root) : stopButtonVisible();
    const streaming = typeof responseStreaming === "function" && globalThis.document ? responseStreaming(bound?.root) : false;
    const done = chatGenerationFinished({stopVisible: stop || streaming, replyActionsVisible: replyDoneVisible(bound?.root)});
    const text = assistantCorpus(bound?.root).join("\n\n");
    const json = done ? harvestJson({allowThin: true, root: bound?.root}) : null;
    if (runner?.running) runner.observation = {
      state: !done ? "generating_or_queued" : json ? "json_observed" : text.trim() ? "response_completed_json_invalid" : "waiting_for_response",
      // Diagnostic size bound, NOT a duration bound. Stay local to the bound job.
      text: text.slice(0, 128_000), totalChars: text.length, truncated: text.length > 128_000,
    };
    recordReviewStep(!done ? (stop || streaming ? "generating" : "waiting_for_response") :
      json ? "json_observed" : text.trim() ? "response_completed_json_invalid" : "waiting_for_response");
    if ((!bound || (bound.identified && !bound.followup)) && quotaHit() && !json) {
      const error = new Error(`${name} usage limit`); error.code = "quota"; throw error;
    }
    if (done && json) {
      const current = JSON.stringify([json, text]);
      hits = stable === current ? hits + 1 : 1; stable = current;
      if (hits >= 2) {
        if (runner) runner.responseText = text;
        recordReviewStep("response_collected");
        return json;
      }
    } else { hits = 0; stable = ""; }
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
  if (state.listener && state.protocol === "observed-submission-v2") return;
  if (state.listener) chrome.runtime.onMessage.removeListener(state.listener);
  state.protocol = "observed-submission-v2";
  const busy = () => ({ ok: false, code: "busy", retry: true, error: "generation pending", observation: state.observation });
  state.listener = (msg, _sender, reply) => {
    if (!["ashlar-run", "ashlar-harvest", "ashlar-can-close"].includes(msg?.type)) return;
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
    // Upgrade only an already matching job binding; never adopt an unrelated chat.
    if (state.jobId === msg.jobId && !state.runId && msg.runId) {
      state.runId = msg.runId;
      try { sessionStorage.setItem("ashlar:run", state.runId); } catch { /* in-memory binding remains */ }
    }
    // Also retry after collection is cached: there may no longer be a polling loop.
    if (typeof retrySubmissionPersistence === "function") retrySubmissionPersistence();
    if (msg.type === "ashlar-can-close") {
      const pending = state.running || !state.result || !state.finishedContext || state.submissionPersistencePending;
      const unchanged = !state.tabRepurposed && state.finishedContext === reviewPageContext();
      const busyNow = typeof stopButtonVisible === "function" && stopButtonVisible();
      // User follow-ups/navigation transfer the tab back to the user. Do not close it.
      const draft = typeof composer === "function" && globalThis.document ? composer() : null;
      const hasDraft = Boolean(draft && (draft.value || draft.innerText || draft.textContent || "").trim());
      reply({ok: true, canClose: !pending && unchanged && !busyNow && !hasDraft,
        reason: pending ? "pending" : !unchanged || hasDraft ? "repurposed" : busyNow ? "pending" : "complete",
        url: globalThis.location?.href || ""});
      return;
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
    state.observation = undefined;
    Promise.resolve().then(() => state.run(String(msg.prompt || ""), msg.reasoning, resume))
      .then(raw => { state.finishedContext = reviewPageContext(); state.result = { ok: true, raw, responseText: state.responseText }; })
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
