const POLL_MS = 2500;
const BUSY_MS = 4 * 60_000;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const SESSION = { busy: "busy", jobId: "jobId", busyAt: "busyAt" };

function formatRetry(until) {
  if (!until) return "later";
  const d = new Date(until);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
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

function providerUrl(provider) {
  if (provider === "grok") return "https://grok.com/";
  return "https://chatgpt.com/?temporary-chat=true";
}

async function ensureTab(provider) {
  const url = providerUrl(provider);
  const tab = await chrome.tabs.create({ url, active: true });
  await waitTab(tab.id);
  return tab.id;
}

function waitTab(tabId) {
  return new Promise((resolve) => {
    const ready = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(ready);
        resolve();
      }
    };
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") resolve();
      else chrome.tabs.onUpdated.addListener(ready);
    });
    setTimeout(resolve, 8000);
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chat tab timed out")), 200_000);
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
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

async function runProvider(provider, prompt, jobId) {
  const tabId = await ensureTab(provider);
  try {
    let result;
    try {
      result = await sendToTab(tabId, { type: "ashlar-run", prompt, jobId });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [provider === "grok" ? "content-grok.js" : "content-chatgpt.js"],
      });
      result = await sendToTab(tabId, { type: "ashlar-run", prompt, jobId });
    }
    if (!result?.ok) {
      const err = new Error(`${provider}: ${result?.error || "chat tab returned nothing"}`);
      err.code = result?.code;
      throw err;
    }
    return { provider, raw: result.raw };
  } finally {
    await closeTab(tabId);
  }
}

async function tick() {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.origin || !cfg.token) return;
  const session = await chrome.storage.session.get([SESSION.busy, SESSION.jobId, SESSION.busyAt]);
  const busyAge = session[SESSION.busyAt] ? Date.now() - Number(session[SESSION.busyAt]) : BUSY_MS;
  if (session[SESSION.busy] && busyAge < BUSY_MS) return;
  const quota = await quotaMap();
  if (!providerOpen(quota, "chatgpt") && !providerOpen(quota, "grok")) {
    const until = Math.min(Number(quota.chatgpt || 0), Number(quota.grok || 0));
    chrome.storage.local.set({
      lastError: `both chats at usage limit — retry ${formatRetry(until)}`,
    });
    return;
  }
  let payload;
  try {
    payload = await api("/api/bridge");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    chrome.storage.local.set({ lastError: msg.slice(0, 240) });
    return;
  }
  const job = payload.job;
  if (!job) return;
  await chrome.storage.session.set({ [SESSION.busy]: true, [SESSION.jobId]: job.jobId, [SESSION.busyAt]: Date.now() });
  chrome.storage.local.set({ lastJobId: job.jobId, lastError: "" });
  let claimed = true;
  try {
    const wanted = (Array.isArray(job.providers) && job.providers.length ? job.providers : [job.provider]).filter(
      (p) => p === "chatgpt" || p === "grok",
    );
    const runnable = wanted.filter((p) => providerOpen(quota, p));
    if (!runnable.length) {
      chrome.storage.local.set({ lastError: "waiting for chat quota reset" });
      await api("/api/bridge", { action: "release", jobId: job.jobId });
      return;
    }
    const settled = await Promise.allSettled(
      runnable.map((p) => runProvider(p, (job.prompts && job.prompts[p]) || job.prompt, job.jobId)),
    );
    const results = [];
    let quotaOnly = true;
    for (let i = 0; i < settled.length; i += 1) {
      const row = settled[i];
      if (row.status === "fulfilled") {
        results.push(row.value);
        quotaOnly = false;
        continue;
      }
      const reason = row.reason;
      const code = reason && typeof reason === "object" ? reason.code : "";
      if (code === "quota") {
        await markQuota(runnable[i]);
      } else {
        quotaOnly = false;
      }
    }
    if (results.length) {
      await api("/api/bridge", {
        action: "complete",
        jobId: job.jobId,
        raw: results[0].raw,
        results,
      });
      chrome.storage.local.set({ lastJobId: job.jobId, lastError: "" });
      return;
    }
    const next = await quotaMap();
    const until = Math.max(...runnable.map((p) => Number(next[p] || 0)));
    chrome.storage.local.set({
      lastError: quotaOnly
        ? `usage limit — retry ${formatRetry(until)}`
        : "chat review failed",
    });
    await api("/api/bridge", { action: "release", jobId: job.jobId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e && typeof e === "object" && "status" in e ? e.status : 0;
    chrome.storage.local.set({ lastError: msg.slice(0, 240) });
    if (claimed && status !== 409) {
      try {
        await api("/api/bridge", { action: "release", jobId: job.jobId });
      } catch {
        /* ignore */
      }
    }
  } finally {
    await chrome.storage.session.set({ [SESSION.busy]: false, [SESSION.jobId]: "", [SESSION.busyAt]: 0 });
  }
}

function loop() {
  chrome.alarms.create("ashlar-poll", { periodInMinutes: 0.5 });
  void tick();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ashlar-poll") void tick();
});
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
loop();
setInterval(() => void tick(), POLL_MS);
