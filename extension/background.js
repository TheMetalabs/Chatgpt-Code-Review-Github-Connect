const POLL_MS = 2500;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const PENDING_JOBS = "pendingReviewJobs";
const CLIENT_KEY = "ashlar:client";
const CLOSED_PREFIX = "ashlar:closed:";
const OWNED_PREFIX = "ashlar:tab:";
const DEFAULT_MAX_REVIEW_TABS = 4;
const HEARTBEAT_MS = 10_000;
const HEALTH_KEY = "bridgeHealth";
const WORKER_STATUS_KEY = "bridgeWorkerStatus";

// Locks are ephemeral; identities, replies and allocation intent remain in storage.
// All lanes share one loaded registry, so concurrent jobs never write stale maps.
const jobLanes = new Map();
const heartbeatLanes = new Map();
const admissionLanes = new Map();
let registryPromise;
let clientPromise;
let storageTail = Promise.resolve();
let allocationTail = Promise.resolve();

function singleFlight(lanes, key, operation) {
  if (lanes.has(key)) return lanes.get(key);
  const pending = Promise.resolve().then(operation).finally(() => {
    if (lanes.get(key) === pending) lanes.delete(key);
  });
  lanes.set(key, pending);
  return pending;
}

async function joinLanes(promises) {
  // Keep the owning job lock until EVERY sibling settles, including on storage errors.
  const outcomes = await Promise.allSettled(promises);
  const failed = outcomes.find(outcome => outcome.status === "rejected");
  if (failed) throw failed.reason;
}

function writeInOrder(operation) {
  const pending = storageTail.then(operation);
  storageTail = pending.catch(() => {}); // A failed write must not poison later retries.
  return pending;
}

function workerJobs(origin) {
  if (!registryPromise) registryPromise = pendingJobs(origin).catch(error => {
    registryPromise = undefined;
    throw error;
  });
  return registryPromise;
}

async function clientId() {
  if (!clientPromise) clientPromise = (async () => {
    const old = (await chrome.storage.local.get([CLIENT_KEY]))[CLIENT_KEY];
    if (old) return old;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({[CLIENT_KEY]: id});
    return id;
  })().catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
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

function bridgeTransportError(cause, body) {
  const error = new Error(`Bridge ${body?.action || "read"} (${body?.jobId || "connection"}) transport interrupted; pending work is preserved, model generation was not cancelled (${cause?.name || "network error"}).`);
  error.transport = true;
  return error;
}

async function api(path, body, expectedOrigin) {
  const { origin, token } = await settings();
  if (!origin || !token) throw new Error("set origin and token in the popup");
  if (expectedOrigin && expectedOrigin !== origin) throw new Error("bridge origin changed; original job preserved");
  let res;
  try {
    // Model completion and saved-result delivery have NO application deadline.
    // Browser/network failures retain the outbox; separate per-job/heartbeat lanes
    // keep unrelated work moving. Server ACK is independent of publication below.
    res = await fetch(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: {"content-type": "application/json", "x-ashlar-bridge-token": token},
      body: body ? JSON.stringify({...body, token}) : undefined,
    });
  } catch (cause) {
    throw bridgeTransportError(cause, body);
  }
  let json;
  try { json = await res.json(); }
  catch (cause) { throw bridgeTransportError(cause, body); }
  if (!res.ok || json?.ok !== true) {
    const err = new Error(json?.error || `http ${res.status}`);
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json;
}

/** Transport liveness is independent of job recovery and never mutates a job/lease.
 * A 200 ping is NOT evidence that a new job has been claimed.
 */
let healthFlight;
function probeBridge() {
  if (healthFlight) return healthFlight;
  healthFlight = (async () => {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.origin || !cfg.token) return false;
    const checkedAt = Date.now();
    const extensionVersion = chrome.runtime.getManifest?.().version || "unknown";
    try {
      const result = await api("/api/bridge", {action: "ping", extensionVersion}, cfg.origin);
      const bridge = result.bridge || {};
      // Persist an allowlist, not the whole response (which can contain private prompts).
      await chrome.storage.local.set({[HEALTH_KEY]: {
        origin: cfg.origin, checkedAt, ok: true, extensionVersion,
        serverInstanceId: typeof bridge.serverInstanceId === "string" ? bridge.serverInstanceId.slice(0, 80) : undefined,
        protocolVersion: Number.isInteger(bridge.protocolVersion) ? bridge.protocolVersion : undefined,
        pendingJobs: Number.isInteger(bridge.pendingJobs) && bridge.pendingJobs >= 0 ? bridge.pendingJobs : undefined,
        lastTakeAt: Number.isFinite(bridge.lastTakeAt) ? bridge.lastTakeAt : undefined,
      }});
      return true;
    } catch (e) {
      await chrome.storage.local.set({[HEALTH_KEY]: {
        origin: cfg.origin, checkedAt, ok: false, extensionVersion,
        httpStatus: e.status, error: String(e.message || e).slice(0, 240),
      }});
      return false;
    }
  })().catch(() => false).finally(() => { healthFlight = undefined; });
  return healthFlight;
}

// For diagnostics only: an active job is NEVER an admission gate.
function activelyReviewing(job) {
  if (job.serverStatus || job.recoveryError) return false;
  return job.providers.some(p => {
    const state = job.states[p];
    return !state.delivered && !state.outcome && !state.connectionError;
  });
}

async function recordWorkerStatus(jobs, origin, phase) {
  const relevant = Object.values(jobs).filter(job => job.origin === origin);
  phase ||= relevant.some(activelyReviewing) ? "reviewing" : relevant.length ? "recovering" : "idle";
  await chrome.storage.local.set({[WORKER_STATUS_KEY]: {
    origin, checkedAt: Date.now(), phase,
    activeJobs: relevant.filter(activelyReviewing).length,
    recoveringJobs: relevant.filter(job => !activelyReviewing(job)).length,
    pendingCleanup: relevant.reduce((n, job) => n + job.providers.filter(p => job.states[p].delivered && !job.states[p].cleanupDone).length, 0),
    waitingForJson: relevant.reduce((n, job) => n + job.providers.filter(p => !job.states[p].delivered && job.states[p].observation?.state === "waiting_for_json").length, 0),
    savedReplies: relevant.reduce((n, job) => n + job.providers.filter(p => job.states[p].outcome?.ok && !job.states[p].delivered).length, 0),
    // Identifiers/status only: never response text, prompts or credentials.
    recovery: relevant.filter(job => !activelyReviewing(job)).slice(0, 8).map(job => ({
      jobId: job.jobId, status: job.serverStatus || (job.recoveryError ? "connection_error" : "reconnecting_or_cleanup"),
    })),
  }});
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
      // Content scripts acknowledge immediately. Do not turn a delayed browser
      // message into a model failure; runtime disconnection is retried on that tab.
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
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
  return writeInOrder(async () => {
    const quota = await quotaMap();
    quota[provider] = Date.now() + (QUOTA_MS[provider] || QUOTA_MS.chatgpt);
    await chrome.storage.local.set({ quota });
    return quota[provider];
  });
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
  // Snapshot now, write in invocation order. Later snapshots include other lanes'
  // mutations because they reference the same registry throughout this worker.
  const snapshot = JSON.parse(JSON.stringify(jobs));
  await writeInOrder(() => chrome.storage.local.set({ [PENDING_JOBS]: snapshot }));
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

async function tabCapacityAvailable(jobs, reservePending = false) {
  const setting = (await chrome.storage.local.get(["maxReviewTabs"])).maxReviewTabs;
  const limit = Number.isInteger(setting) && setting > 0 ? Math.min(setting, 16) : DEFAULT_MAX_REVIEW_TABS;
  const tabs = await chrome.tabs.query({});
  const live = new Map(tabs.map(tab => [tab.id, tab]));
  const session = await chrome.storage.session.get(null);
  const ids = new Set();
  const restoring = {chatgpt: 0, grok: 0}, allocating = {chatgpt: 0, grok: 0};
  let reserved = 0;
  for (const job of Object.values(jobs)) for (const p of job.providers) {
    const state = job.states[p];
    if (state.cleanupDone || session[closedKey(job, p)]) continue;
    if (state.tabId && live.has(state.tabId) && allowedTab(live.get(state.tabId), p)) {
      ids.add(state.tabId);
    } else if (state.allocating) {
      allocating[p]++;
    } else if (state.started || job.resumeProviders?.includes(p)) {
      restoring[p]++; // IDs can change after restart; do not ignore restored tabs.
    } else if (reservePending && !state.tabId && !state.delivered && !state.outcome &&
               !job.serverStatus && !job.recoveryError) {
      reserved++; // An admitted provider awaiting creation already owns admission space.
    }
  }
  let used = ids.size + reserved;
  for (const p of ["chatgpt", "grok"]) {
    const unknownTabs = tabs.filter(tab => !ids.has(tab.id) && allowedTab(tab, p)).length;
    used += allocating[p] + Math.min(restoring[p], Math.max(0, unknownTabs - allocating[p]));
  }
  return used < limit;
}

async function allocateProviderTab(job, provider, jobs) {
  // Serialize only the short capacity/create boundary, never model or bridge RPCs.
  const operation = allocationTail.then(async () => {
    const state = job.states[provider];
    if (state.tabId || state.allocating || !await tabCapacityAvailable(jobs)) return;
    state.allocating = true;
    try { await saveJobs(jobs); }
    catch (error) { delete state.allocating; throw error; } // No create was attempted.
    try {
      const created = await chrome.tabs.create({url: providerUrl(provider, job.reasoning?.[provider]), active: true});
      state.tabId = created.id;
      await rememberOwnedTab(job, provider);
      delete state.allocating;
      await saveJobs(jobs); // Durable binding before any prompt dispatch.
    } catch (error) {
      if (!state.tabId) { delete state.allocating; await saveJobs(jobs); }
      throw error;
    }
  });
  allocationTail = operation.catch(() => {});
  return operation;
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
  await writeInOrder(async () => {
    const old = await chrome.storage.session.get(["tabs"]);
    const tabs = {...old.tabs};
    for (const p of job.providers) delete tabs[`${job.jobId}:${p}`];
    await chrome.storage.session.set({tabs});
    await chrome.storage.local.remove(["ashlar:job:" + job.jobId]);
  });
  delete jobs[job.jobId];
  await saveJobs(jobs);
  return true;
}

function connectionErrors(job) {
  return Object.fromEntries(job.providers.filter(p => job.states[p].connectionError && !job.states[p].outcome)
    .map(p => [p, {code: "disconnected", message: job.states[p].connectionError}]));
}

function heartbeat(job, jobs) {
  return singleFlight(heartbeatLanes, `${job.origin}:${job.jobId}`, () => refreshJobHeartbeat(job, jobs));
}

async function refreshJobHeartbeat(job, jobs) {
  const body = {action: "ping", jobId: job.jobId, leaseId: job.leaseId,
    generating: generatingFor(job), providerErrors: connectionErrors(job)};
  let result = await api("/api/bridge", body, job.origin);
  if (result.active === false) {
    job.serverStatus = result.status || "unknown";
    await saveJobs(jobs);
    return false; // Not equivalent to cancellation, receipt, or permission to close.
  }
  delete job.serverStatus;
  if (result.accepted === false || !job.leaseId) {
    const claim = await api("/api/bridge", {action: "claim", jobId: job.jobId, clientId: await clientId()}, job.origin);
    job.leaseId = claim.leaseId;
    await saveJobs(jobs);
    result = await api("/api/bridge", {...body, leaseId: job.leaseId}, job.origin);
    if (result.accepted === false) throw new Error("bridge lease could not be renewed");
  }
  return true;
}

async function pollProvider(job, provider, jobs, observeOnly = false) {
  const state = job.states[provider];
  if (state.outcome || state.delivered) return;
  if (!state.runId) { state.runId = crypto.randomUUID(); await saveJobs(jobs); }
  if (state.allocating && !state.tabId) {
    // Creation may have succeeded before a worker restart. Recover a recorded owner;
    // if none can be established, keep the intent instead of opening another tab.
    const session = await chrome.storage.session.get(null);
    const owner = Object.entries(session).find(([key, value]) => key.startsWith(OWNED_PREFIX) &&
      value?.jobId === job.jobId && value.provider === provider && value.runId === state.runId);
    if (owner) state.tabId = Number(owner[0].slice(OWNED_PREFIX.length));
    else {
      const original = await findOriginalTab(job, provider);
      if (original) { state.tabId = original.id; state.started = true; }
    }
    if (!state.tabId) {
      state.connectionError = "tab creation outcome unknown; original allocation preserved";
      await saveJobs(jobs);
      return;
    }
    delete state.allocating;
    await saveJobs(jobs);
  }
  if (!state.tabId && (state.started || job.resumeProviders?.includes(provider))) {
    const original = await findOriginalTab(job, provider);
    if (original) { state.tabId = original.id; state.started = true; await saveJobs(jobs); }
    else { state.connectionError = "original review tab unavailable; waiting for reconnection"; await saveJobs(jobs); return; }
  }
  if (!state.tabId) {
    if (observeOnly) return;
    const quota = await quotaMap();
    if (!providerOpen(quota, provider)) {
      state.outcome = failure("quota", "usage limit — waiting for reset");
      await saveJobs(jobs);
      return;
    }
    await allocateProviderTab(job, provider, jobs);
    if (!state.tabId) return;
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
    // A messaging outage is not a model failure or a global admission lock.
    state.connectionError = String(e.message || e).slice(0, 240);
    await saveJobs(jobs);
    await chrome.storage.local.set({ lastError: state.connectionError });
    return;
  }
  if (result?.code === "disconnected" || !matchesJob(result, job, provider)) {
    state.connectionError = "original job binding unavailable; waiting for reconnection";
    const original = await findOriginalTab(job, provider);
    if (original && original.id !== state.tabId) { state.tabId = original.id; state.started = true; }
    await saveJobs(jobs);
    return;
  }
  if (result.observation && typeof result.observation === "object") {
    const item = result.observation;
    const text = typeof item.text === "string" ? item.text.slice(0, 128_000) : "";
    state.observation = {state: String(item.state || "unknown").slice(0, 80), text,
      totalChars: Number.isSafeInteger(item.totalChars) ? item.totalChars : text.length,
      truncated: Boolean(item.truncated)};
    await saveJobs(jobs);
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
  try { await api("/api/bridge", body, job.origin); }
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
  const previousError = (await chrome.storage.local.get(["lastError"])).lastError;
  if (typeof previousError === "string" && previousError.startsWith(`Bridge ${body.action} (${job.jobId}) transport interrupted`)) {
    await chrome.storage.local.set({lastError: ""});
  }
  state.cleanupPending = true;
  await saveJobs(jobs);
  await cleanupProvider(job, provider, jobs);
}

async function advanceJob(job, jobs) {
  // Cleanup is independent of server availability once acknowledgement was persisted.
  await joinLanes(job.providers.map(p => cleanupProvider(job, p, jobs)));
  if (await retireCleanJob(job, jobs)) return;
  const active = await heartbeat(job, jobs);
  if (!active && job.serverStatus === "cancelled") {
    for (const p of job.providers) {
      job.states[p].delivered = true; // Explicit cancellation, never elapsed time or 404.
      job.states[p].cleanupPending = true;
    }
    await saveJobs(jobs);
    await joinLanes(job.providers.map(p => cleanupProvider(job, p, jobs)));
    await retireCleanJob(job, jobs);
    return;
  }
  const canDeliver = active || ["validator", "posting", "posted", "skipped", "dlq"].includes(job.serverStatus);
  // Missing is not ACK: observe and preserve the original response without redelivery.
  if (active && !job.prompt) {
    const current = await api(`/api/bridge?jobId=${encodeURIComponent(job.jobId)}`, undefined, job.origin);
    Object.assign(job, {prompt: current.prompt, prompts: current.prompts});
    await saveJobs(jobs);
  }
  await joinLanes(job.providers.map(async provider => {
    try {
      await pollProvider(job, provider, jobs, !active);
      if (canDeliver) await deliverOutcome(job, provider, jobs);
      await cleanupProvider(job, provider, jobs);
    } catch (e) {
      // A failing provider must not prevent the others from being collected/closed.
      await chrome.storage.local.set({lastError: String(e.message || e).slice(0, 240)});
    }
  }));
  if (active) await heartbeat(job, jobs);
  await retireCleanJob(job, jobs);
}

function progressJob(job, jobs) {
  if (jobs[job.jobId] !== job) return Promise.resolve();
  return singleFlight(jobLanes, `${job.origin}:${job.jobId}`, async () => {
    try {
      await advanceJob(job, jobs);
      if (job.recoveryError) { delete job.recoveryError; await saveJobs(jobs); }
    } catch (error) {
      job.recoveryError = String(error.message || error).slice(0, 240);
      await saveJobs(jobs);
      await chrome.storage.local.set({lastError: job.recoveryError});
    } finally { await recordWorkerStatus(jobs, job.origin); }
  });
}

function admitJob(cfg, jobs) {
  return singleFlight(admissionLanes, cfg.origin, async () => {
    if (!await tabCapacityAvailable(jobs, true)) {
      await recordWorkerStatus(jobs, cfg.origin, "tab_capacity"); return null;
    }
    const quota = await quotaMap();
    if (!["chatgpt", "grok"].some(p => providerOpen(quota, p))) {
      await recordWorkerStatus(jobs, cfg.origin, "provider_quota"); return null;
    }
    const payload = await api("/api/bridge", {
      action: "take", clientId: await clientId(), excludeJobIds: Object.keys(jobs),
    }, cfg.origin).catch(async error => {
      await recordWorkerStatus(jobs, cfg.origin, "disconnected"); throw error;
    });
    if (!payload.job || jobs[payload.job.jobId]) return null;
    const job = {...payload.job, origin: cfg.origin, states: {}};
    job.providers = [...new Set(job.providers?.length ? job.providers : [job.provider])]
      .filter(p => ["chatgpt", "grok"].includes(p));
    if (!job.providers.length) throw new Error("bridge returned no supported review providers");
    for (const p of job.providers) job.states[p] = {};
    jobs[job.jobId] = job;
    await saveJobs(jobs); // Provider intents reserve admission space before this lock opens.
    await chrome.storage.local.set({lastJobId: job.jobId, lastError: ""});
    return job;
  });
}

async function tick() {
  try { await tickBody(); }
  catch (error) { await chrome.storage.local.set({lastError: String(error.message || error).slice(0, 240)}); }
}

async function tickBody() {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.origin || !cfg.token) return;
  void probeBridge();
  const jobs = await workerJobs(cfg.origin);
  await recordWorkerStatus(jobs, cfg.origin);
  // There is deliberately NO global work lock or "any active job" return. A later
  // wakeup can advance B/admit C even while A's short transport attempt is pending.
  const work = Object.values(jobs)
    .filter(j => j.origin === cfg.origin && !jobLanes.has(`${j.origin}:${j.jobId}`))
    .map(job => progressJob(job, jobs));
  // Do not add another waiter to an already-running lane on every alarm/timer tick.
  if (!admissionLanes.has(cfg.origin)) {
    work.push(admitJob(cfg, jobs).then(job => job && progressJob(job, jobs)));
  }
  await joinLanes(work);
}

async function heartbeatTick() {
  try {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.origin || !cfg.token) return;
    void probeBridge();
    const jobs = await workerJobs(cfg.origin);
    const current = Object.values(jobs).filter(j => j.origin === cfg.origin);
    // Job-specific lease pings, not just a misleading profile-level connection ping.
    if (current.length) await Promise.allSettled(current
      .filter(job => !heartbeatLanes.has(`${job.origin}:${job.jobId}`))
      .map(job => heartbeat(job, jobs)));
    else if (!heartbeatLanes.has(cfg.origin)) {
      await singleFlight(heartbeatLanes, cfg.origin, () => api("/api/bridge", {action: "ping"}, cfg.origin));
    }
  } catch (error) { await chrome.storage.local.set({lastError: String(error.message || error).slice(0, 240)}); }
}

function loop() {
  chrome.alarms.create("ashlar-poll", { periodInMinutes: 1 });
  void heartbeatTick();
  void tick();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ashlar-poll") { void heartbeatTick(); void tick(); }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ashlar-poll-now") return;
  void probeBridge();
  void heartbeatTick();
  void tick();
  sendResponse({ok: true, scheduled: true});
});
chrome.tabs.onRemoved.addListener((id, info) => void rememberClosedTab(id, info));
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
loop();
setInterval(() => void tick(), POLL_MS);

setInterval(() => void heartbeatTick(), HEARTBEAT_MS);
