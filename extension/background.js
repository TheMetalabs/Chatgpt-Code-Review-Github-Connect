const POLL_MS = 2500;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const PENDING_JOBS = "pendingReviewJobs";
const CLIENT_KEY = "ashlar:client";
const CLOSED_PREFIX = "ashlar:closed:";
const OWNED_PREFIX = "ashlar:tab:";
const DEFAULT_MAX_REVIEW_TABS = 4;

async function clientId() {
  const old = (await chrome.storage.local.get([CLIENT_KEY]))[CLIENT_KEY];
  if (old) return old;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({[CLIENT_KEY]: id});
  return id;
}

function closedKey(job, provider) {
  return `${CLOSED_PREFIX}${job.jobId}:${provider}:${job.states[provider].runId || "legacy"}`;
}

async function rememberClosedTab(tabId, info) {
  const key = OWNED_PREFIX + tabId;
  const owned = (await chrome.storage.session.get([key]))[key];
  // Only managed tabs; session-scoped records cannot poison a reused ID after restart.
  if (!owned) return;
  if (!info?.isWindowClosing && !owned.closing) {
    await chrome.storage.session.set({[owned.closedKey]: true});
  }
  await chrome.storage.session.remove([key]);
}

async function rememberOwnedTab(job, provider, closing = false) {
  const state = job.states[provider];
  if (state.tabId) await chrome.storage.session.set({[OWNED_PREFIX + state.tabId]: {
    jobId: job.jobId, provider, runId: state.runId, closedKey: closedKey(job, provider), closing,
  }});
}

function formatRetry(until) {
  if (!until) return "later";
  const d = new Date(until);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function settings() {
  const s = await chrome.storage.local.get(["origin", "token", "enabled"]);
  return {
    origin: String(s.origin || "").replace(/\/$/, ""),
    token: String(s.token || ""),
    enabled: s.enabled !== false,
  };
}

async function api(path, body) {
  const { origin, token } = await settings();
  if (!origin || !token) throw new Error("set origin and token in the popup");
  const res = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-ashlar-bridge-token": token,
    },
    body: body ? JSON.stringify({ ...body, token }) : undefined,
    // Bound only bridge control RPCs, never the underlying queue or generation.
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok !== true) {
    const err = new Error(json.error || `http ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function providerUrl(provider, reasoning) {
  if (provider === "grok") return "https://grok.com/";
  if (reasoning === "pro") return "https://chatgpt.com/?temporary-chat=true&model=gpt-6-pro";
  return "https://chatgpt.com/?temporary-chat=true";
}

function noReceiver(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /receiving end does not exist|could not establish connection/i.test(m);
}

async function sendToTab(tabId, msg, files) {
  const once = () =>
    new Promise((resolve, reject) => {
      // ACK deadline is transport-only; it never cancels the page's model request.
      const timer = setTimeout(() => reject(new Error("review tab acknowledgement unavailable")), 10_000);
      try {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  try {
    return await once();
  } catch (e) {
    if (!files?.length || !noReceiver(e)) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await sleep(400);
    return once();
  }
}

async function quotaMap() {
  const s = await chrome.storage.local.get(["quota"]);
  return s.quota && typeof s.quota === "object" ? s.quota : {};
}

function providerOpen(quota, provider) {
  const until = Number(quota[provider] || 0);
  return !until || until < Date.now();
}

async function markQuota(provider) {
  const quota = await quotaMap();
  quota[provider] = Date.now() + (QUOTA_MS[provider] || QUOTA_MS.chatgpt);
  await chrome.storage.local.set({ quota });
  return quota[provider];
}

function contentFiles(provider) {
  return provider === "grok"
    ? ["composer.js", "quota.js", "overlay.js", "model.js", "json.js", "content-grok.js"]
    : ["composer.js", "quota.js", "overlay.js", "model.js", "json.js", "content-chatgpt.js"];
}

/** A tick only exchanges short messages. The content page owns the long model call.
 * Persist intent, tab identity and terminal outcomes before each external boundary.
 * An unacknowledged outcome is replayed to the bridge, never to the model.
 */
async function saveJobs(jobs) {
  await chrome.storage.local.set({ [PENDING_JOBS]: jobs });
}

async function pendingJobs(origin) {
  const local = await chrome.storage.local.get(null);
  const obsolete = Object.keys(local).filter(key => key.startsWith(CLOSED_PREFIX));
  if (obsolete.length) await chrome.storage.local.remove(obsolete);
  if (local[PENDING_JOBS]) return local[PENDING_JOBS];
  // Upgrade from pre-recovery versions: lastJobId alone can already have lost A.
  const old = await chrome.storage.session.get(["tabs"]);
  const jobs = {};
  for (const [key, tabId] of Object.entries(old.tabs || {})) {
    const sep = key.lastIndexOf(":");
    const jobId = key.slice(0, sep), provider = key.slice(sep + 1);
    if (sep < 1 || !["chatgpt", "grok"].includes(provider) || !tabId) continue;
    jobs[jobId] ||= { jobId, origin, providers: [], states: {} };
    jobs[jobId].providers.push(provider);
    jobs[jobId].states[provider] = { tabId, started: true, adoptLegacy: true };
  }
  // Also preserve outboxes written by the alternate follow-up implementation.
  const all = await chrome.storage.local.get(null);
  for (const [key, oldJob] of Object.entries(all)) {
    if (!key.startsWith("ashlar:job:") || !oldJob?.jobId || !oldJob.slots) continue;
    const states = {};
    for (const [provider, slot] of Object.entries(oldJob.slots)) {
      const outcome = slot.raw ? {ok: true, raw: slot.raw}
        : slot.error && slot.error.code !== "disconnected" ? failure(slot.error.code, slot.error.message) : undefined;
      states[provider] = {tabId: slot.tabId, started: slot.dispatched, outcome};
    }
    jobs[oldJob.jobId] = {...oldJob, origin: oldJob.origin || origin, states};
  }
  await saveJobs(jobs);
  return jobs;
}

function isBusyResult(result) {
  if (!result || result.ok) return false;
  if (result.code) return result.code === "busy";
  return result.retry === true || /already running|busy/i.test(String(result.error || ""));
}

function generatingFor(job) {
  // Completion/failure endpoints atomically settle the server state. Until acknowledged,
  // keep the leg pending; an early false heartbeat could race the server's watcher.
  return Object.fromEntries(job.providers.map(p => [p, !job.states[p].delivered]));
}

function failure(code, error) {
  return { ok: false, code, error };
}

function tabMessage(job, provider, type) {
  return {type, jobId: job.jobId, provider, runId: job.states[provider].runId};
}

function matchesJob(result, job, provider) {
  return result?.jobId === job.jobId && result?.provider === provider &&
    (!job.states[provider].runId || result.runId === job.states[provider].runId) &&
    result.code !== "job_mismatch";
}

function allowedTab(tab, provider) {
  try {
    const url = new URL(tab.pendingUrl || tab.url || "about:blank");
    return url.protocol === "https:" && (provider === "grok" ? url.hostname === "grok.com" :
      ["chatgpt.com", "chat.openai.com"].includes(url.hostname));
  } catch { return false; }
}

async function findOriginalTab(job, provider) {
  const urls = provider === "grok" ? ["https://grok.com/*"] : ["https://chatgpt.com/*", "https://chat.openai.com/*"];
  for (const tab of await chrome.tabs.query({url: urls})) {
    if (!allowedTab(tab, provider)) continue;
    try {
      const result = await sendToTab(tab.id, tabMessage(job, provider, "ashlar-harvest"), contentFiles(provider));
      if (matchesJob(result, job, provider)) return tab;
    } catch { /* A messaging outage is not evidence of completion. */ }
  }
  return null;
}

async function tabCapacityAvailable(jobs) {
  const setting = (await chrome.storage.local.get(["maxReviewTabs"])).maxReviewTabs;
  const limit = Number.isInteger(setting) && setting > 0 ? Math.min(setting, 16) : DEFAULT_MAX_REVIEW_TABS;
  // Include cleanup-pending tabs and other configured origins, not only running legs.
  const ids = new Set(Object.values(jobs).flatMap(job => Object.values(job.states)
    .filter(state => state.tabId && !state.cleanupDone).map(state => state.tabId)));
  return ids.size < limit;
}

async function finishTabCleanup(job, provider, jobs, reason) {
  const state = job.states[provider];
  state.cleanupDone = true;
  state.cleanupPending = false;
  if (reason) state.cleanupNote = reason;
  delete state.cleanupError;
  await saveJobs(jobs);
  await chrome.storage.session.remove([OWNED_PREFIX + state.tabId, closedKey(job, provider)]);
}

/** Retryable journal: delivered -> cleanupPending -> closed -> cleanupDone.
 * Never delete the last ownership record before remove() has succeeded.
 */
async function cleanupProvider(job, provider, jobs) {
  const state = job.states[provider];
  if (!state.delivered || state.cleanupDone) return;
  state.cleanupPending = true;
  await saveJobs(jobs);
  if (!state.tabId && !state.started) return finishTabCleanup(job, provider, jobs);
  if ((await chrome.storage.session.get([closedKey(job, provider)]))[closedKey(job, provider)]) {
    return finishTabCleanup(job, provider, jobs, "already closed");
  }
  try {
    let tab;
    try { tab = await chrome.tabs.get(state.tabId); }
    catch {
      tab = await findOriginalTab(job, provider);
      if (!tab) {
        // A previous remove may have succeeded just before the worker stopped.
        if (state.closeRequested) return finishTabCleanup(job, provider, jobs, "close confirmed by absence");
        state.cleanupError = "original tab unavailable; cleanup waits for reconnection";
        await saveJobs(jobs);
        return;
      }
      state.tabId = tab.id;
      await saveJobs(jobs);
    }
    if (!allowedTab(tab, provider)) return finishTabCleanup(job, provider, jobs, "user navigated away; tab preserved");
    if (tab.status && tab.status !== "complete") return;
    const result = await sendToTab(tab.id, tabMessage(job, provider, "ashlar-can-close"), contentFiles(provider));
    if (!matchesJob(result, job, provider)) {
      state.cleanupError = "tab ownership does not match; no tab was closed";
      await saveJobs(jobs);
      return;
    }
    if (result.reason === "repurposed") return finishTabCleanup(job, provider, jobs, "user continued the conversation; tab preserved");
    if (!result.canClose) return; // In particular, no deadline for unfinished generations.
    const current = await chrome.tabs.get(tab.id);
    if (current.pendingUrl || current.url !== result.url || current.status === "loading") return;
    state.closeRequested = true;
    await saveJobs(jobs);
    await rememberOwnedTab(job, provider, true);
    await chrome.tabs.remove(tab.id);
    await finishTabCleanup(job, provider, jobs);
  } catch (e) {
    state.cleanupError = String(e.message || e).slice(0, 240);
    await saveJobs(jobs);
  }
}

async function retireCleanJob(job, jobs) {
  if (!job.providers.every(p => job.states[p].delivered && job.states[p].cleanupDone)) return false;
  const old = await chrome.storage.session.get(["tabs"]);
  const tabs = {...old.tabs};
  for (const p of job.providers) delete tabs[`${job.jobId}:${p}`];
  await chrome.storage.session.set({tabs});
  await chrome.storage.local.remove(["ashlar:job:" + job.jobId]);
  delete jobs[job.jobId];
  await saveJobs(jobs);
  return true;
}

function connectionErrors(job) {
  return Object.fromEntries(job.providers.filter(p => job.states[p].connectionError && !job.states[p].outcome)
    .map(p => [p, {code: "disconnected", message: job.states[p].connectionError}]));
}

async function heartbeat(job, jobs) {
  const body = {action: "ping", jobId: job.jobId, leaseId: job.leaseId,
    generating: generatingFor(job), providerErrors: connectionErrors(job)};
  let result = await api("/api/bridge", body);
  if (result.active === false) {
    job.serverStatus = result.status || "unknown";
    await saveJobs(jobs);
    return false; // Not equivalent to cancellation, receipt, or permission to close.
  }
  delete job.serverStatus;
  if (result.accepted === false || !job.leaseId) {
    const claim = await api("/api/bridge", {action: "claim", jobId: job.jobId, clientId: await clientId()});
    job.leaseId = claim.leaseId;
    await saveJobs(jobs);
    result = await api("/api/bridge", {...body, leaseId: job.leaseId});
    if (result.accepted === false) throw new Error("bridge lease could not be renewed");
  }
  return true;
}

async function pollProvider(job, provider, jobs, observeOnly = false) {
  const state = job.states[provider];
  if (state.outcome || state.delivered) return;
  if (!state.runId) { state.runId = crypto.randomUUID(); await saveJobs(jobs); }
  if (!state.tabId && (state.started || job.resumeProviders?.includes(provider))) {
    const original = await findOriginalTab(job, provider);
    if (original) { state.tabId = original.id; state.started = true; await saveJobs(jobs); }
    else { state.connectionError = "original review tab unavailable; waiting for reconnection"; return; }
  }
  if (!state.tabId) {
    if (observeOnly || !await tabCapacityAvailable(jobs)) return;
    const quota = await quotaMap();
    if (!providerOpen(quota, provider)) {
      state.outcome = failure("quota", "usage limit — waiting for reset");
      await saveJobs(jobs);
      return;
    }
    const created = await chrome.tabs.create({url: providerUrl(provider, job.reasoning?.[provider]), active: true});
    state.tabId = created.id;
    await rememberOwnedTab(job, provider);
    await saveJobs(jobs); // Persist before any prompt dispatch; readiness is polled on later ticks.
  }
  if ((await chrome.storage.session.get([closedKey(job, provider)]))[closedKey(job, provider)]) {
    state.outcome = failure("tab_closed", "review tab was explicitly closed");
    await saveJobs(jobs);
    return;
  }
  let tab;
  try { tab = await chrome.tabs.get(state.tabId); }
  catch {
    tab = await findOriginalTab(job, provider);
    if (!tab) { state.connectionError = "tab connection unknown; waiting for reconnection"; await saveJobs(jobs); return; }
    state.tabId = tab.id; state.started = true; await saveJobs(jobs);
  }
  if (tab.status && tab.status !== "complete") return;
  if (!allowedTab(tab, provider)) {
    state.outcome = failure("context_lost", "review tab navigated away");
    await saveJobs(jobs);
    return;
  }
  const run = { ...tabMessage(job, provider, "ashlar-run"),
    prompt: job.prompts?.[provider] || job.prompt, reasoning: job.reasoning?.[provider], adoptLegacy: state.adoptLegacy };
  let result;
  try {
    if (!state.started && !observeOnly) {
      // The page runner deduplicates a retried start when its acknowledgement was lost.
      result = await sendToTab(state.tabId, run, contentFiles(provider));
      state.started = true;
      await saveJobs(jobs);
    } else {
      result = await sendToTab(state.tabId, tabMessage(job, provider, "ashlar-harvest"), contentFiles(provider));
      if (result?.code === "idle" && !observeOnly) {
        result = await sendToTab(state.tabId, { ...run, resume: true }, contentFiles(provider));
      }
    }
  } catch (e) {
    // A messaging outage is not a model failure. Check tab existence on the next tick.
    await chrome.storage.local.set({ lastError: String(e.message || e).slice(0, 240) });
    return;
  }
  if (result?.code === "disconnected" || !matchesJob(result, job, provider)) {
    state.connectionError = "original job binding unavailable; waiting for reconnection";
    const original = await findOriginalTab(job, provider);
    if (original && original.id !== state.tabId) { state.tabId = original.id; state.started = true; }
    await saveJobs(jobs);
    return;
  }
  await rememberOwnedTab(job, provider);
  delete state.connectionError;
  if (isBusyResult(result)) return;
  if (result?.ok && typeof result.raw === "string" && result.raw.trim()) {
    state.outcome = { ok: true, raw: result.raw };
  } else if (result?.code && result.code !== "idle") {
    state.outcome = failure(result.code, String(result.error || "chat review failed"));
  } else {
    // Older content scripts can say "no json" during generation. Never infer done.
    return;
  }
  await saveJobs(jobs);
  if (state.outcome.code === "quota") await markQuota(provider);
}

async function deliverOutcome(job, provider, jobs) {
  const state = job.states[provider], out = state.outcome;
  if (!out || state.delivered) return;
  const body = out.ok
    ? {action: "complete", jobId: job.jobId, leaseId: job.leaseId, raw: out.raw, results: [{provider, raw: out.raw}]}
    : {action: "failure", jobId: job.jobId, leaseId: job.leaseId, provider, error: `${out.code}: ${out.error}`};
  try { await api("/api/bridge", body); }
  catch (e) {
    if (e.status === 409) { job.leaseId = undefined; await saveJobs(jobs); throw e; }
    if (e.status === 400 && out.ok && !job.serverStatus) {
      state.rejectedRaw = out.raw; // Keep diagnostics until the failure is acknowledged.
      state.outcome = failure("error", `completed review was rejected: ${e.message}`);
      await saveJobs(jobs);
      return;
    }
    // A 404/unknown response is NOT an acknowledgement. Keep the tab and exact outbox.
    throw e;
  }
  state.delivered = true;
  state.cleanupPending = true;
  await saveJobs(jobs);
  await cleanupProvider(job, provider, jobs);
}

async function advanceJob(job, jobs) {
  // Cleanup is independent of server availability once acknowledgement was persisted.
  for (const p of job.providers) await cleanupProvider(job, p, jobs);
  if (await retireCleanJob(job, jobs)) return;
  const active = await heartbeat(job, jobs);
  if (!active && job.serverStatus === "cancelled") {
    for (const p of job.providers) {
      job.states[p].delivered = true; // Explicit cancellation, never elapsed time or 404.
      job.states[p].cleanupPending = true;
    }
    await saveJobs(jobs);
    for (const p of job.providers) await cleanupProvider(job, p, jobs);
    await retireCleanJob(job, jobs);
    return;
  }
  if (!active && !["validator", "posting", "posted", "skipped", "dlq"].includes(job.serverStatus)) return;
  if (active && !job.prompt) {
    const current = await api(`/api/bridge?jobId=${encodeURIComponent(job.jobId)}`);
    Object.assign(job, {prompt: current.prompt, prompts: current.prompts});
    await saveJobs(jobs);
  }
  for (const provider of job.providers) {
    try {
      await pollProvider(job, provider, jobs, !active);
      await deliverOutcome(job, provider, jobs);
      await cleanupProvider(job, provider, jobs);
    } catch (e) {
      // A failing provider must not prevent the others from being collected/closed.
      await chrome.storage.local.set({lastError: String(e.message || e).slice(0, 240)});
    }
  }
  if (active) await heartbeat(job, jobs);
  await retireCleanJob(job, jobs);
}

let tickLock = false;
async function tick() {
  if (tickLock) return;
  tickLock = true;
  try {
    await tickBody();
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message || e).slice(0, 240) });
  } finally {
    tickLock = false;
  }
}

async function tickBody() {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.origin || !cfg.token) return;
  const jobs = await pendingJobs(cfg.origin);
  const recovering = Object.values(jobs).filter(j => j.origin === cfg.origin);
  if (recovering.length) {
    for (const job of recovering) {
      try { await advanceJob(job, jobs); }
      catch (e) { await chrome.storage.local.set({lastError: String(e.message || e).slice(0, 240)}); }
    }
    return; // Never let a newly queued B overwrite recovery of A.
  }
  await api("/api/bridge", { action: "ping" });
  const quota = await quotaMap();
  if (!["chatgpt", "grok"].some(p => providerOpen(quota, p))) return;
  const payload = await api("/api/bridge", { action: "take", clientId: await clientId() });
  if (!payload.job) return;
  const job = { ...payload.job, origin: cfg.origin, states: {} };
  job.providers = (job.providers?.length ? job.providers : [job.provider])
    .filter(p => ["chatgpt", "grok"].includes(p));
  for (const p of job.providers) job.states[p] = {};
  jobs[job.jobId] = job;
  await saveJobs(jobs);
  await chrome.storage.local.set({ lastJobId: job.jobId, lastError: "" });
  await advanceJob(job, jobs);
}

function loop() {
  chrome.alarms.create("ashlar-poll", { periodInMinutes: 1 });
  void tick();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ashlar-poll") void tick();
});
chrome.tabs.onRemoved.addListener((id, info) => void rememberClosedTab(id, info));
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
loop();
setInterval(() => void tick(), POLL_MS);
