// Historical 1.1.19 (PR #40) v2 collector/runner used only for upgrade regression.
// It deliberately has no repair tracking or receipt consumption. Keep unchanged.
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
