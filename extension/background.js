/** Short, restartable control-plane ticks. The content page owns unbounded generation. */
const POLL_MS = 2500;
const PING_MS = 10_000;
const JOB_PREFIX = "ashlar:job:";
const CLOSED_PREFIX = "ashlar:closed:";
const CLIENT_KEY = "ashlar:client";
let tickLock = false;

async function settings() {
  const value = await chrome.storage.local.get(["origin", "token", "enabled"]);
  return {origin: String(value.origin || "").replace(/\/$/, ""), token: String(value.token || ""), enabled: value.enabled !== false};
}

async function api(body) {
  const config = await settings();
  if (!config.origin || !config.token) throw new Error("set origin and token in the popup");
  // Only this small bridge RPC is bounded. Failure retains the job/outbox unchanged;
  // it never cancels, marks empty, or resubmits the underlying model operation.
  const response = await fetch(`${config.origin}/api/bridge`, {
    method: "POST", headers: {"content-type": "application/json", "x-ashlar-bridge-token": config.token},
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(value.error || `bridge HTTP ${response.status}`);
  return value;
}

async function clientId() {
  const current = (await chrome.storage.local.get(CLIENT_KEY))[CLIENT_KEY];
  if (current) return current;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({[CLIENT_KEY]: id});
  return id;
}

async function tasks() {
  const values = await chrome.storage.local.get(null);
  return Object.entries(values).filter(([key]) => key.startsWith(JOB_PREFIX)).map(([, value]) => value);
}

async function saveTask(task) {
  await chrome.storage.local.set({[JOB_PREFIX + task.jobId]: task});
}

function contentFiles(provider) {
  return ["composer.js", "quota.js", "overlay.js", "model.js", "json.js", `content-${provider}.js`];
}

function providerUrl(provider, reasoning) {
  if (provider === "grok") return "https://grok.com/";
  return reasoning === "pro" ? "https://chatgpt.com/?temporary-chat=true&model=gpt-6-pro" : "https://chatgpt.com/?temporary-chat=true";
}

async function sendToTab(tabId, message, files) {
  const once = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(response);
    });
  });
  try { return await once(); }
  catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error.message)) throw error;
    await chrome.scripting.executeScript({target: {tabId}, files});
    return once();
  }
}

async function findOriginalTab(task, provider) {
  const urls = provider === "grok" ? ["https://grok.com/*"] : ["https://chatgpt.com/*", "https://chat.openai.com/*"];
  for (const tab of await chrome.tabs.query({url: urls})) {
    try {
      const result = await sendToTab(tab.id, {type: "ashlar-harvest", jobId: task.jobId}, contentFiles(provider));
      if (result?.jobId === task.jobId) return tab;
    } catch { /* observe only; never send a prompt during discovery */ }
  }
  return null;
}

async function observeProvider(task, provider) {
  const slot = task.slots[provider];
  if (slot.raw || (slot.error && slot.error.code !== "disconnected")) return;
  const reasoning = task.reasoning?.[provider];
  if (!slot.tabId) {
    if (slot.dispatched || slot.creating || task.resumeProviders?.includes(provider)) {
      const original = await findOriginalTab(task, provider);
      if (original) {slot.tabId = original.id; slot.dispatched = true; await saveTask(task);}
      else {
        slot.error = {code: "disconnected", message: "original review tab unavailable; awaiting reconnection, not restarting generation"};
        return;
      }
    }
    // Persist intent before creating or dispatching. Ambiguous restarts never spend again.
    if (!slot.tabId) {
    slot.creating = true;
    await saveTask(task);
    const tab = await chrome.tabs.create({url: providerUrl(provider, reasoning), active: true});
    slot.tabId = tab.id;
    slot.creating = false;
    await saveTask(task);
    }
  }
  const removed = (await chrome.storage.local.get(CLOSED_PREFIX + slot.tabId))[CLOSED_PREFIX + slot.tabId];
  if (removed === "closed") {slot.error = {code: "tab_closed", message: "review tab explicitly closed"}; return;}
  let tab;
  try {tab = await chrome.tabs.get(slot.tabId);}
  catch {
    // Browser restart may change tab IDs. Absence alone is not proof that generation ended.
    tab = await findOriginalTab(task, provider);
    if (tab) {slot.tabId = tab.id; slot.dispatched = true; await saveTask(task);}
    else {slot.error = {code: "disconnected", message: "original tab not observable; waiting for reconnection"}; return;}
  }
  const url = new URL(tab.url || providerUrl(provider, reasoning));
  const correctHost = provider === "grok" ? url.hostname === "grok.com" : ["chatgpt.com", "chat.openai.com"].includes(url.hostname);
  if (!correctHost) {slot.error = {code: "disconnected", message: "review tab navigated away; waiting for reconnection"}; return;}
  if (tab.status === "loading") {slot.error = {code: "disconnected", message: "review tab loading"}; return;}
  let result;
  try {
    result = await sendToTab(slot.tabId, {type: "ashlar-harvest", jobId: task.jobId}, contentFiles(provider));
    if (result?.code === "job_mismatch") {
      const original = await findOriginalTab(task, provider);
      if (original) {slot.tabId = original.id; slot.dispatched = true;}
      slot.error = {code: "disconnected", message: "tab identity changed; recovering original job"};
      return;
    }
    if (result?.code === "idle") {
      const resume = Boolean(slot.dispatched || task.resumeProviders?.includes(provider));
      slot.dispatched = true;
      await saveTask(task);
      result = await sendToTab(slot.tabId, {
        type: "ashlar-run", jobId: task.jobId, prompt: task.prompts?.[provider] || task.prompt, reasoning, resume, adoptLegacy: slot.legacy === true,
      }, contentFiles(provider));
    }
  } catch (error) {
    slot.error = {code: "disconnected", message: error.message.slice(0, 240)};
    return;
  }
  if (result?.ok && typeof result.raw === "string" && result.raw.trim()) {
    slot.raw = result.raw;
    delete slot.error;
  } else if (result?.code === "busy") {
    delete slot.error;
  } else if (["quota", "empty", "error", "cancelled", "tab_closed"].includes(result?.code)) {
    slot.error = {code: result.code, message: String(result.error || result.code).slice(0, 240)};
  } else {
    slot.error = {code: "disconnected", message: "review state unknown; waiting for current runner"};
  }
}

async function processTask(task, owner) {
  const status = await api({action: "ping", jobId: task.jobId, leaseId: task.leaseId});
  if (status.active === false) {await chrome.storage.local.remove(JOB_PREFIX + task.jobId); return;}
  if (status.accepted === false) {
    const claim = await api({action: "claim", jobId: task.jobId, clientId: owner});
    task.leaseId = claim.leaseId;
    await saveTask(task);
  }
  for (const provider of task.providers) {
    await observeProvider(task, provider);
    await saveTask(task);
  }
  // The persisted raw response is an outbox: repeat delivery, never repeat generation.
  const results = task.providers.filter(p => task.slots[p].raw && !task.slots[p].acknowledged)
    .map(provider => ({provider, raw: task.slots[provider].raw}));
  if (results.length) {
    await api({action: "complete", jobId: task.jobId, leaseId: task.leaseId, raw: results[0].raw, results});
    for (const result of results) task.slots[result.provider].acknowledged = true;
    await saveTask(task);
  }
  const generating = {}, providerErrors = {};
  for (const provider of task.providers) {
    const slot = task.slots[provider];
    if (slot.error) providerErrors[provider] = slot.error;
    // Success is advertised by complete, atomically with its payload, not by this ping.
    if (!slot.raw) generating[provider] = !slot.error || slot.error.code === "disconnected";
  }
  await api({action: "ping", jobId: task.jobId, leaseId: task.leaseId, generating, providerErrors});
  const done = task.providers.every(p => task.slots[p].acknowledged || (task.slots[p].error && task.slots[p].error.code !== "disconnected"));
  if (done) {
    await api({action: "release", jobId: task.jobId, leaseId: task.leaseId});
    await chrome.storage.local.set({lastJobId: task.jobId, lastError: Object.values(providerErrors).map(e => `${e.code}: ${e.message}`).join("; ")});
    await chrome.storage.local.remove(JOB_PREFIX + task.jobId);
  }
}

async function heartbeatAll() {
  const config = await settings();
  if (!config.enabled || !config.origin || !config.token) return;
  // Deliberately outside tickLock. A slow bridge RPC must not suppress other heartbeats.
  await Promise.allSettled((await tasks()).map(task => api({action: "ping", jobId: task.jobId, leaseId: task.leaseId})));
}

async function tick() {
  if (tickLock) return;
  tickLock = true;
  try {
    const config = await settings();
    if (!config.enabled || !config.origin || !config.token) return;
    const owner = await clientId();
    for (const task of await tasks()) {
      try {await processTask(task, owner);}
      catch (error) {await chrome.storage.local.set({lastError: `reconnecting: ${error.message}`});}
    }
    const current = await tasks();
    const {job} = await api({action: "take", clientId: owner, excludeJobIds: current.map(task => task.jobId)});
    if (job) {
      const task = {...job, slots: Object.fromEntries(job.providers.map(p => [p, {}]))};
      // Adopt pre-v2 known tabs when updating an extension during a running review.
      const legacy = (await chrome.storage.session.get("tabs")).tabs || {};
      for (const provider of task.providers) {
        if (legacy[`${job.jobId}:${provider}`]) task.slots[provider] = {tabId: legacy[`${job.jobId}:${provider}`], dispatched: true, legacy: true};
      }
      await saveTask(task);
      await processTask(task, owner);
    }
  } catch (error) {
    await chrome.storage.local.set({lastError: `reconnecting: ${error.message}`});
  } finally {tickLock = false;}
}

chrome.tabs.onRemoved.addListener((tabId, info) => {
  void chrome.storage.local.set({[CLOSED_PREFIX + tabId]: info.isWindowClosing ? "disconnected" : "closed"});
});
chrome.alarms.onAlarm.addListener(() => {void heartbeatAll(); void tick();});
function start() {void chrome.alarms.create("ashlar-poll", {periodInMinutes: 1}); void tick();}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
start();
setInterval(() => void tick(), POLL_MS);
setInterval(() => void heartbeatAll(), PING_MS);
