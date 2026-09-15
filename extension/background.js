const POLL_MS = 2500;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const PENDING_JOBS = "pendingReviewJobs";

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
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
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

async function ensureTab(provider, reasoning) {
  const url = providerUrl(provider, reasoning);
  const tab = await chrome.tabs.create({ url, active: true });
  await waitTab(tab.id);
  await sleep(1500);
  return tab.id;
}

function waitTab(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(ready);
      resolve();
    };
    const ready = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") finish();
      else chrome.tabs.onUpdated.addListener(ready);
    });
    setTimeout(finish, 8000);
  });
}

function noReceiver(err) {
  const m = err instanceof Error ? err.message : String(err);
  return /receiving end does not exist|could not establish connection/i.test(m);
}

async function sendToTab(tabId, msg, files) {
  const once = () =>
    new Promise((resolve, reject) => {
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

async function closeTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already gone */
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
  const local = await chrome.storage.local.get([PENDING_JOBS]);
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
    jobs[jobId].states[provider] = { tabId, started: true };
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

async function pollProvider(job, provider, jobs) {
  const state = job.states[provider];
  if (state.outcome) return;
  if (!state.tabId) {
    const quota = await quotaMap();
    if (!providerOpen(quota, provider)) {
      state.outcome = failure("quota", "usage limit — waiting for reset");
      await saveJobs(jobs);
      return;
    }
    state.tabId = await ensureTab(provider, job.reasoning?.[provider]);
    await saveJobs(jobs); // The tab must be recoverable before sending the prompt.
  }
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    state.outcome = failure("tab_closed", "review tab was closed");
    await saveJobs(jobs);
    return;
  }
  const host = new URL(tab.url || tab.pendingUrl || "about:blank").hostname;
  const allowed = provider === "grok" ? ["grok.com"] : ["chatgpt.com", "chat.openai.com"];
  if (!allowed.includes(host)) {
    state.outcome = failure("context_lost", "review tab navigated away");
    await saveJobs(jobs);
    return;
  }
  const run = { type: "ashlar-run", jobId: job.jobId,
    prompt: job.prompts?.[provider] || job.prompt, reasoning: job.reasoning?.[provider] };
  let result;
  try {
    if (!state.started) {
      // The page runner deduplicates a retried start when its acknowledgement was lost.
      result = await sendToTab(state.tabId, run, contentFiles(provider));
      state.started = true;
      await saveJobs(jobs);
    } else {
      result = await sendToTab(state.tabId, { type: "ashlar-harvest", jobId: job.jobId }, contentFiles(provider));
      if (result?.code === "idle") {
        result = await sendToTab(state.tabId, { ...run, resume: true }, contentFiles(provider));
      }
    }
  } catch (e) {
    // A messaging outage is not a model failure. Check tab existence on the next tick.
    await chrome.storage.local.set({ lastError: String(e.message || e).slice(0, 240) });
    return;
  }
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

async function advanceJob(job, jobs) {
  // Reconcile cancellation/completion, and obtain prompts for migrated tab records.
  // A transport error must retain pending work; only an explicit 404 retires it.
  try {
    const current = await api(`/api/bridge?jobId=${encodeURIComponent(job.jobId)}`);
    if (!job.prompt) Object.assign(job, { prompt: current.prompt, prompts: current.prompts });
  } catch (e) {
    if (e.status === 404) { delete jobs[job.jobId]; await saveJobs(jobs); return; }
    throw e;
  }
  await api("/api/bridge", { action: "ping", jobId: job.jobId, generating: generatingFor(job) });
  for (const provider of job.providers) {
    await pollProvider(job, provider, jobs);
    // Heartbeat does not announce completion before the result is acknowledged.
    await api("/api/bridge", { action: "ping", jobId: job.jobId, generating: generatingFor(job) });
    const state = job.states[provider];
    if (!state.outcome || state.delivered) continue;
    const out = state.outcome;
    const body = out.ok
      ? { action: "complete", jobId: job.jobId, raw: out.raw, results: [{ provider, raw: out.raw }] }
      : { action: "failure", jobId: job.jobId, provider, error: `${out.code}: ${out.error}` };
    try {
      await api("/api/bridge", body);
    } catch (e) {
      // A validation rejection is terminal. Network/5xx errors retain the exact raw.
      if (![400, 404, 409].includes(e.status)) throw e;
      await chrome.storage.local.set({ lastError: String(e.message || e).slice(0, 240) });
    }
    state.delivered = true;
    await saveJobs(jobs);
    await api("/api/bridge", { action: "ping", jobId: job.jobId, generating: generatingFor(job) });
    if (!out.ok) await chrome.storage.local.set({ lastError: out.error });
  }
  if (job.providers.every(p => job.states[p].delivered)) {
    delete jobs[job.jobId];
    await saveJobs(jobs);
  }
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
    for (const job of recovering) await advanceJob(job, jobs);
    return; // Never let a newly queued B overwrite recovery of A.
  }
  await api("/api/bridge", { action: "ping" });
  const quota = await quotaMap();
  if (!["chatgpt", "grok"].some(p => providerOpen(quota, p))) return;
  const payload = await api("/api/bridge", { action: "take" });
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
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
loop();
setInterval(() => void tick(), POLL_MS);
