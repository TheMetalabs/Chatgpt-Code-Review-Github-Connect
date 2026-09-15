const POLL_MS = 2500;
const PING_MS = 10_000;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const SESSION = { busy: "busy", jobId: "jobId", busyAt: "busyAt", tabs: "tabs" };

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

async function rememberTab(jobId, provider, tabId) {
  if (!jobId || !tabId) return;
  const s = await chrome.storage.session.get([SESSION.tabs]);
  const tabs = s[SESSION.tabs] && typeof s[SESSION.tabs] === "object" ? { ...s[SESSION.tabs] } : {};
  tabs[`${jobId}:${provider}`] = tabId;
  await chrome.storage.session.set({ [SESSION.tabs]: tabs });
}

async function tabFor(jobId, provider) {
  const s = await chrome.storage.session.get([SESSION.tabs]);
  const tabs = s[SESSION.tabs] && typeof s[SESSION.tabs] === "object" ? s[SESSION.tabs] : {};
  const id = Number(tabs[`${jobId}:${provider}`] || 0);
  return id || null;
}

async function harvestTab(provider, tabId) {
  if (!tabId) return null;
  try {
    const result = await sendToTab(tabId, { type: "ashlar-harvest" }, contentFiles(provider));
    if (result?.ok && result.raw) return { provider, raw: result.raw, tabId };
  } catch {
    /* tab not ready */
  }
  return null;
}

async function runProvider(provider, prompt, jobId, reasoning) {
  const files = contentFiles(provider);
  const known = await tabFor(jobId, provider);
  if (known) {
    const hit = await harvestTab(provider, known);
    if (hit) return { provider, raw: hit.raw };
    try {
      const result = await sendToTab(known, { type: "ashlar-run", prompt, jobId, reasoning }, files);
      if (result?.ok && result.raw) return { provider, raw: result.raw };
    } catch {
      /* fall through to a new tab only if this one is gone */
    }
  }
  const tabId = await ensureTab(provider, reasoning);
  await rememberTab(jobId, provider, tabId);
  try {
    const result = await sendToTab(tabId, { type: "ashlar-run", prompt, jobId, reasoning }, files);
    if (!result?.ok) {
      const again = await harvestTab(provider, tabId);
      if (again) return { provider, raw: again.raw };
      const err = new Error(`${provider}: ${result?.error || "chat tab returned nothing"}`);
      err.code = result?.code;
      throw err;
    }
    return { provider, raw: result.raw };
  } catch (e) {
    const again = await harvestTab(provider, tabId);
    if (again) return { provider, raw: again.raw };
    throw e;
  }
}

async function ping(jobId, generating) {
  try {
    await api("/api/bridge", { action: "ping", jobId: jobId || undefined, generating: generating || undefined });
  } catch {
    /* keep trying */
  }
}

async function recoverDeadWorker() {
  const session = await chrome.storage.session.get([SESSION.busy, SESSION.jobId]);
  await chrome.storage.session.set({ [SESSION.busy]: false, [SESSION.jobId]: session[SESSION.jobId] || "", [SESSION.busyAt]: 0 });
}

async function harvestAndComplete(jobId, providers) {
  if (!jobId) return false;
  const results = [];
  for (const p of providers) {
    const hit = await harvestTab(p, await tabFor(jobId, p));
    if (hit) results.push({ provider: hit.provider, raw: hit.raw });
  }
  if (!results.length) return false;
  await api("/api/bridge", { action: "complete", jobId, raw: results[0].raw, results });
  return true;
}

let tickLock = false;

async function tick() {
  if (tickLock) return;
  tickLock = true;
  try {
    await tickBody();
  } finally {
    tickLock = false;
  }
}

async function tickBody() {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.origin || !cfg.token) return;
  const session = await chrome.storage.session.get([SESSION.busy, SESSION.jobId, SESSION.busyAt]);
  await ping(session[SESSION.jobId]);
  if (session[SESSION.busy]) return;
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
    payload = await api("/api/bridge", { action: "take" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    chrome.storage.local.set({ lastError: msg.slice(0, 240) });
    return;
  }
  const job = payload.job;
  if (!job) {
    const last = await chrome.storage.local.get(["lastJobId"]);
    if (last.lastJobId) {
      try {
        await harvestAndComplete(String(last.lastJobId), ["chatgpt", "grok"]);
      } catch {
        /* still no json */
      }
    }
    return;
  }
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
    const generating = {};
    const keepAlive = setInterval(() => void ping(job.jobId, generating), PING_MS);
    const results = [];
    let quotaOnly = true;
    try {
      const settled = await Promise.allSettled(
        runnable.map(async (p) => {
          generating[p] = true;
          void ping(job.jobId, generating);
          try {
            const value = await runProvider(
              p,
              (job.prompts && job.prompts[p]) || job.prompt,
              job.jobId,
              (job.reasoning && job.reasoning[p]) || (p === "grok" ? "heavy" : "pro"),
            );
            generating[p] = false;
            void ping(job.jobId, generating);
            results.push(value);
            quotaOnly = false;
            try {
              await api("/api/bridge", {
                action: "complete",
                jobId: job.jobId,
                raw: value.raw,
                results: results.slice(),
              });
            } catch {
              /* already posted or not awaiting */
            }
            return value;
          } catch (e) {
            generating[p] = false;
            void ping(job.jobId, generating);
            const code = e && typeof e === "object" && "code" in e ? e.code : "";
            if (code === "quota") await markQuota(p);
            else quotaOnly = false;
            throw e;
          }
        }),
      );
      if (results.length) {
        chrome.storage.local.set({ lastJobId: job.jobId, lastError: "" });
        return;
      }
      void settled;
      const next = await quotaMap();
      const until = Math.max(...runnable.map((p) => Number(next[p] || 0)));
      chrome.storage.local.set({
        lastError: quotaOnly ? `usage limit — retry ${formatRetry(until)}` : "chat review failed",
      });
      await api("/api/bridge", { action: "release", jobId: job.jobId });
    } finally {
      clearInterval(keepAlive);
    }
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
  chrome.alarms.create("ashlar-poll", { periodInMinutes: 1 });
  void recoverDeadWorker().then(() => tick());
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ashlar-poll") void tick();
});
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
loop();
setInterval(() => void tick(), POLL_MS);
