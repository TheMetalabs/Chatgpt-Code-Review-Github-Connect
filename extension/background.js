const POLL_MS = 2500;
const QUOTA_MS = { chatgpt: 5 * 60 * 60 * 1000, grok: 7 * 24 * 60 * 60 * 1000 };
const PENDING_JOBS = "pendingReviewJobs";
const CLIENT_KEY = "ashlar:client";
const CLOSED_PREFIX = "ashlar:closed:";
const OWNED_PREFIX = "ashlar:tab:";
// A fix run whose tab the worker preserved without the page's own release (it never answered):
// the inventory treats that page's binding as released, so it is never an orphan holding capacity,
// and completes the release handshake as soon as the page can answer (see completePreservedRelease).
const PRESERVED_PREFIX = "ashlar:preserved:";
const preservedKey = (jobId, provider, runId) => `${PRESERVED_PREFIX}${jobId}:${provider}:${runId || "legacy"}`;
// Fix deliveries this profile opened a tab for: {jobId: {deliveryId, at, provider, phase, tabId}}.
// The server's offer names its delivery (a fresh hand-out mints it; a lost-take replay repeats it,
// bridge-fix.server.ts), and the worker opens at most ONE tab per jobId + deliveryId. Two phases: a
// `creating` record (the intent) is written before chrome.tabs.create and promoted to `created`
// with the tabId once the tab exists. The record outlives the job registry (a hard reset or a lost
// registry): only a record a tab still proves (reconcileFixDeliveries) keeps a replayed delivery out,
// so a delivery whose tab may already hold the run is never submitted a second time (recovery
// resumes that tab), and an intent that never became a tab never strands it. Kept longer than the
// longest fix deadline (6 h), dropped when the job retires.
const FIX_DELIVERIES_KEY = "ashlar:fixDeliveries";
const FIX_DELIVERY_RETAIN_MS = 7 * 60 * 60 * 1000;
const DEFAULT_MAX_REVIEW_TABS = 4;
const HEARTBEAT_MS = 10_000;
const HEALTH_KEY = "bridgeHealth";
const WORKER_STATUS_KEY = "bridgeWorkerStatus";
// The last legs this worker retired (metadata only: ids, stage, preserve cause, fixed cleanup note),
// shown in the popup so a kept or closed tab can be explained after its job is gone. Never uploaded.
const RECENT_RETIRED_KEY = "bridgeRecentRetired";
const MAINTENANCE_KEY = "extensionMaintenance";

// Locks are ephemeral; identities, replies and allocation intent remain in storage.
// All lanes share one loaded registry, so concurrent jobs never write stale maps.
const jobLanes = new Map();
const heartbeatLanes = new Map();
const observationLanes = new Map();
const repairLanes = new Map();
const captureLanes = new Map();
const capturePersistence = new Set();
const cleanupLanes = new Map();
const statusLanes = new Map();
const inventoryLanes = new Map();
const tabOwners = new Map();
const tabEpochs = new Map();
const inventoryUpgrades = new Map();
const admissionLanes = new Map();
const admissionReports = new Map();
let registryPromise;
let clientPromise;
let storageTail = Promise.resolve();
let allocationTail = Promise.resolve();
let maintenanceTail = Promise.resolve();

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

function maintenanceInOrder(operation) {
  const pending = maintenanceTail.then(operation);
  maintenanceTail = pending.catch(() => {}); // Keep later maintenance transitions usable after a failure.
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
  invalidateTabInventory(tabId);
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

/** Whether this browser session recorded `tabId` as this leg's tab (allocateProviderTab writes the
 * record right after it creates the tab). Chrome tab ids are unique only within one browser session
 * and the job registry outlives it (storage.local), while this record does not (storage.session is
 * cleared by a browser restart or an extension reload): a leg's stored tab id without it can name a
 * tab the user opened since. An unbound page is Ashlar's only in the tab this proves. */
async function tabCreatedForLeg(job, provider, tabId) {
  const key = OWNED_PREFIX + tabId;
  const owned = Number.isInteger(tabId) ? (await chrome.storage.session.get([key]))[key] : undefined;
  return owned?.jobId === job.jobId && owned.provider === provider && owned.runId === job.states[provider].runId;
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

async function api(path, body, expectedOrigin, signal) {
  const { origin, token } = await settings();
  if (!origin || !token) throw new Error("set origin and token in the popup");
  if (expectedOrigin && expectedOrigin !== origin) throw new Error("bridge origin changed; original job preserved");
  let res;
  try {
    // Model completion and saved-result delivery have NO application deadline.
    // Browser/network failures retain the outbox; separate per-job/heartbeat lanes
    // keep unrelated work moving. Server ACK is independent of publication below.
    // A caller MAY pass a signal to cancel (e.g. the periodic sweep's watchdog); normal callers omit it.
    // fixProtocol:1 on EVERY bridge request: this worker handles review-loop fix items, and the
    // server refuses every fix operation (and skips fix recovery) without it. Review requests ignore it.
    res = await fetch(body ? `${origin}${path}` : `${origin}${path}${path.includes("?") ? "&" : "?"}fixProtocol=1`, {
      method: body ? "POST" : "GET",
      headers: {"content-type": "application/json", "x-ashlar-bridge-token": token},
      body: body ? JSON.stringify({...body, fixProtocol: 1, token}) : undefined,
      signal,
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
      const local = (await chrome.storage.local.get([WORKER_STATUS_KEY]))[WORKER_STATUS_KEY];
      // Never forward local blockers, raw observations, prompts, token or URLs.
      const capacity = local?.origin === cfg.origin ? local.capacity : undefined;
      const workerStatus = capacity ? {
        checkedAt: local.checkedAt, admissionPhase: local.admissionPhase,
        activeJobs: local.activeJobs, pendingCleanup: local.pendingCleanup,
        sourceCaptured: local.sourceCaptured, waitingForJson: local.waitingForJson,
        capacity: Object.fromEntries(["limit","used","managedTabs","reserved","restorationReserved","providerTabs","unverifiedTabs","orphanTabs","unknownReserved"].map(key=>[key,capacity[key]])),
      } : undefined;
      const result = await api("/api/bridge", {action: "ping", extensionVersion, workerStatus}, cfg.origin);
      const bridge = result.bridge || {};
      // Persist an allowlist, not the whole response (which can contain private prompts).
      await chrome.storage.local.set({[HEALTH_KEY]: {
        origin: cfg.origin, checkedAt, ok: true, extensionVersion,
        serverInstanceId: typeof bridge.serverInstanceId === "string" ? bridge.serverInstanceId.slice(0, 80) : undefined,
        protocolVersion: Number.isInteger(bridge.protocolVersion) ? bridge.protocolVersion : undefined,
        recoveryProtocol: bridge.recoveryProtocol===1 ? 1 : undefined,
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
    return !state.delivered && !state.outcome && !state.connectionError && !sourceArchiveDurable(state);
  });
}

async function recordWorkerStatus(jobs, origin, admissionPhase) {
  const capacity = await tabCapacityReport(jobs, true);
  // Admission and execution are independent writers. A finishing work lane must
  // not erase the reason another request is waiting for a slot or connection.
  if (admissionPhase) admissionReports.set(origin, {phase: admissionPhase, checkedAt: Date.now()});
  return writeInOrder(async () => {
    const relevant = Object.values(jobs).filter(job => job.origin === origin);
    const phase = relevant.some(activelyReviewing) ? "reviewing" : relevant.length ? "recovering" : "idle";
    const admission = admissionReports.get(origin);
    const retired = (await chrome.storage.local.get([RECENT_RETIRED_KEY]))[RECENT_RETIRED_KEY];
    await chrome.storage.local.set({[WORKER_STATUS_KEY]: {
      origin, checkedAt: Date.now(), phase, capacity,
      admissionPhase: admission?.phase || "not_checked",
      admissionCheckedAt: admission?.checkedAt,
      sourceCaptured: relevant.reduce((n,job)=>n+job.providers.filter(p=>sourceArchiveDurable(job.states[p]) && !job.states[p].delivered).length,0),
      activeJobs: relevant.filter(activelyReviewing).length,
      recoveringJobs: relevant.filter(job => !activelyReviewing(job)).length,
      pendingCleanup: relevant.reduce((n, job) => n + job.providers.filter(p => (job.states[p].delivered || sourceArchiveDurable(job.states[p])) && !job.states[p].cleanupDone).length, 0),
      waitingForJson: relevant.reduce((n, job) => n + job.providers.filter(p => !job.states[p].delivered && ["waiting_for_json", "response_completed_json_invalid"].includes(job.states[p].observation?.state)).length, 0),
      stages: relevant.slice(0, 8).flatMap(job => job.providers.map(provider => ({jobId:job.jobId,provider,
        stage: progressFor(job)[provider]?.events.at(-1)?.stage || "submission_unknown"}))),
      savedReplies: relevant.reduce((n, job) => n + job.providers.filter(p => job.states[p].outcome?.ok && !job.states[p].delivered).length, 0),
      // Identifiers/status only: never response text, prompts or credentials.
      recovery: relevant.filter(job => !activelyReviewing(job)).slice(0, 8).map(job => ({
        jobId: job.jobId, status: job.serverStatus || (job.recoveryError ? "connection_error" : "reconnecting_or_cleanup"),
      })),
      retired: Array.isArray(retired) ? retired : [],
    }});
  });
}

function providerUrl(provider, _reasoning) {
  if (provider === "grok") return "https://grok.com/";
  // Never pin a model slug in the URL. The effort/model is chosen from the composer pill after load
  // (selectReasoning). A stale slug that no longer exists (e.g. gpt-6-pro) makes ChatGPT serve a
  // logged-out-looking landing page with no composer, so the runner hangs even while signed in.
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

/** How long a release message (can-close, cancel, preserve) or an ownership probe may go
 * unanswered: a page that accepted it but never runs its handler (a frozen tab, a hung page) then
 * counts as unreachable, instead of holding its single-flight cleanup lane (and the bounded
 * ownership wait that only starts after a reply) forever. */
const PAGE_REPLY_MS = 15_000;

/** One reply deadline (a function so tests can replace the timer; cancelled once the reply came). */
function pageReplyDeadline(ms = PAGE_REPLY_MS) {
  let timer;
  const promise = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the page did not answer in time")), ms); });
  return {promise, cancel: () => clearTimeout(timer)};
}

/** sendToTab for the tab-release path and ownership probes, bounded by pageReplyDeadline. */
async function askPage(tabId, msg, files) {
  const deadline = pageReplyDeadline();
  try { return await Promise.race([sendToTab(tabId, msg, files), deadline.promise]); }
  finally { deadline.cancel(); }
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
  if (result.code) return result.code === "busy" || result.code === "captured";
  return result.retry === true || /already running|busy/i.test(String(result.error || ""));
}

function workerStep(job, provider, stage) {
  const state=job.states[provider];
  if(!state.runId || state.workerEvents?.at(-1)?.stage===stage)return;
  state.workerSequence=(state.workerSequence||0)+1;
  state.workerEvents=[...(state.workerEvents||[]),{source:"worker",sequence:state.workerSequence,stage,at:Date.now()}].slice(-128);
}

/** Copy the page's step journal from a matching reply (poll or cleanup): untrusted input, so only
 * primitive metadata is kept (the server sanitizes it again). True when it was taken. */
function ingestPageProgress(state, result) {
  if (result?.progress?.runId !== state.runId || !Array.isArray(result.progress.events)) return false;
  state.pageEvents = result.progress.events.slice(-128).filter(e => e && e.source === "page" &&
    Number.isSafeInteger(e.sequence) && typeof e.stage === "string" && e.stage.length < 80 && Number.isFinite(e.at))
    .map(e => ({source: "page", sequence: e.sequence, stage: e.stage, at: e.at}));
  return true;
}

function progressFor(job) {
  return Object.fromEntries(job.providers.flatMap(provider=>{
    const state=job.states[provider];
    const events=[...(state.pageEvents||[]),...(state.workerEvents||[])].sort((a,b)=>a.at-b.at);
    return state.runId && events.length ? [[provider,{runId:state.runId,events,
      extensionVersion:chrome.runtime.getManifest?.().version || "unknown"}]] : [];
  }));
}

async function flushProgress(job, signal) {
  const progress=progressFor(job);
  if(Object.keys(progress).length)await api("/api/bridge",{action:"progress",jobId:job.jobId,leaseId:job.leaseId,progress},job.origin,signal);
}

async function archiveObservation(job, provider, jobs) {
  const state=job.states[provider], observation=state.observation;
  if(state.outcome || !["waiting_for_json","response_completed_json_invalid"].includes(observation?.state) || !observation.text) return;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(observation.text))))
    .map(byte=>byte.toString(16).padStart(2,"0")).join("");
  if(state.archivedObservation===digest)return;
  // Establish the authenticated run before sending private, unparsed evidence.
  await flushProgress(job);
  await api("/api/bridge",{action:"observe",jobId:job.jobId,leaseId:job.leaseId,provider,runId:state.runId,
    text:observation.text,totalChars:observation.totalChars,truncated:observation.truncated},job.origin);
  state.archivedObservation=digest;
  delete state.observationError;
  await saveJobs(jobs);
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
  const message = {type, jobId: job.jobId, provider, runId: job.states[provider].runId};
  // Only review-loop fix items carry their kind; review messages stay exactly as before.
  if (job.kind === "fix") message.kind = "fix";
  return message;
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
    // A frozen tab runs no handler until the user brings it back: it cannot answer now.
    if (!allowedTab(tab, provider) || tab.frozen === true) continue;
    try {
      const result = await askPage(tab.id, tabMessage(job, provider, "ashlar-harvest"), contentFiles(provider));
      if (matchesJob(result, job, provider)) return tab;
    } catch { /* A messaging outage is not evidence of completion. */ }
  }
  return null;
}

function invalidateTabInventory(tabId) {
  tabOwners.delete(tabId);
  inventoryUpgrades.delete(tabId);
  tabEpochs.set(tabId,(tabEpochs.get(tabId) || 0)+1);
}
function knownTabOwner(tab) {
  const known=tabOwners.get(tab.id);
  return known?.url === tab.url && !tab.pendingUrl && tab.status !== "loading" ? known : undefined;
}
/** Ownership-only probes have independent lanes. An unresponsive tab remains
 * uncertain; it cannot hold the admission/cleanup scheduler or cause fan-out.
 */
async function refreshTabInventory() {
  const tabs=await chrome.tabs.query({});
  const live=new Set(tabs.map(tab=>tab.id));
  for(const id of tabOwners.keys())if(!live.has(id))invalidateTabInventory(id);
  // Removed IDs need no permanent tombstone once their single-flight probe ended.
  for(const id of tabEpochs.keys())if(!live.has(id) && !inventoryLanes.has(id)){tabEpochs.delete(id);inventoryUpgrades.delete(id);}
  for(const tab of tabs) {
    const provider=["chatgpt","grok"].find(p=>allowedTab(tab,p));
    if(!provider || tab.status === "loading" || tab.pendingUrl || inventoryLanes.has(tab.id))continue;
    const epoch=tabEpochs.get(tab.id) || 0;
    void singleFlight(inventoryLanes,tab.id,async()=>{
      let result=await sendToTab(tab.id,{type:"ashlar-tab-status"},contentFiles(provider));
      if(result?.ownershipProtocol!==1 && inventoryUpgrades.get(tab.id)!==epoch) {
        inventoryUpgrades.set(tab.id,epoch);
        await chrome.scripting.executeScript({target:{tabId:tab.id},files:contentFiles(provider)});
        result=await sendToTab(tab.id,{type:"ashlar-tab-status"},contentFiles(provider));
      }
      const current=await chrome.tabs.get(tab.id);
      if((tabEpochs.get(tab.id) || 0)!==epoch || current.status==="loading" || current.pendingUrl ||
          current.url!==tab.url || result?.url!==tab.url || result?.ownershipProtocol!==1 || result.provider!==provider ||
          typeof result.jobId!=="string" || typeof result.runId!=="string")return;
      tabOwners.set(tab.id,{url:tab.url,jobId:result.jobId,provider,runId:result.runId,released:result.released === true});
      await completePreservedRelease(tab,provider,result);
    }).catch(()=>{tabOwners.delete(tab.id);});
  }
  // A preserved record whose tab is gone has nothing left to release.
  const session=await chrome.storage.session.get(null);
  const stale=Object.entries(session).filter(([key,value])=>key.startsWith(PRESERVED_PREFIX) && Number.isInteger(value?.tabId) && !live.has(value.tabId)).map(([key])=>key);
  if(stale.length)await chrome.storage.session.remove(stale);
}

/** The preserve handshake a review tab always completes before its job retires (the page frees
 * its own managed slot: can-close "repurposed", capture/result "changed"). A fix tab preserved while
 * it could not answer (still loading, unreachable, or its reply was lost) retired on the worker's
 * backstop record instead; once the inventory reaches that page and it still reports the binding
 * unreleased, the page is asked to release it (and to stop collecting). The record is dropped
 * only when the page itself reports the binding released. */
async function completePreservedRelease(tab, provider, status) {
  const key=preservedKey(status.jobId,provider,status.runId);
  const record=(await chrome.storage.session.get([key]))[key];
  if(!record)return;
  if(status.released===true){await chrome.storage.session.remove([key]);return;}
  const ack=await askPage(tab.id,{type:"ashlar-fix-cancel",jobId:status.jobId,provider,runId:status.runId,kind:"fix",preserve:true},contentFiles(provider)).catch(()=>null);
  if(ack?.ok===true && ack.jobId===status.jobId && ack.runId===status.runId && ack.provider===provider) {
    const known=tabOwners.get(tab.id);
    if(known?.jobId===status.jobId && known.runId===status.runId)tabOwners.set(tab.id,{...known,released:true});
  }
}
function sourceArchiveDurable(state) {
  return state.sourceCapture?.archiveDurable === true || state.sourceCapture?.confirmed === true;
}
function sourceCleanupProofConfirmed(state) {
  return state.sourceCapture?.cleanupProofConfirmed === true || state.sourceCapture?.confirmed === true;
}

function slotReason(state) {
  if(state.cleanupDone)return "released";
  if(state.delivered || sourceArchiveDurable(state))return state.cleanupWaitReason || "cleanup_pending";
  if(state.captureError)return "source_archive_pending";
  if(state.sourceCapture?.id)return "source_receipt_pending";
  if(state.formatError || state.observation?.state === "response_completed_json_invalid")return "completed_json_invalid";
  if(state.outcome)return "result_delivery_pending";
  if(state.connectionError)return "ownership_or_connection_unknown";
  return state.started ? "generation_or_observation_pending" : "allocation_pending";
}
async function tabCapacityReport(jobs, reservePending = false) {
  const setting=(await chrome.storage.local.get(["maxReviewTabs"])).maxReviewTabs;
  const limit=Number.isInteger(setting) && setting>0 ? Math.min(setting,16) : DEFAULT_MAX_REVIEW_TABS;
  const tabs=await chrome.tabs.query({}), live=new Map(tabs.map(tab=>[tab.id,tab]));
  const session=await chrome.storage.session.get(null), ids=new Set();
  const restoring={chatgpt:0,grok:0};let allocating=0,reserved=0;
  const slots=Object.values(jobs).flatMap(job=>job.providers.map(provider=>({job,provider,state:job.states[provider]})))
    .filter(({job,provider,state})=>!state.cleanupDone && !session[closedKey(job,provider)]);
  for(const {job,provider,state} of slots) {
    const found=tabs.filter(tab=>{const owner=knownTabOwner(tab);return allowedTab(tab,provider) && owner?.jobId===job.jobId && owner.provider===provider &&
      owner.released !== true && (!state.runId || !owner.runId || owner.runId===state.runId);});
    if(found.length){for(const tab of found)ids.add(tab.id);continue;}
    const tab=live.get(state.tabId);
    // An allocated-but-not-dispatched tab is still owned even before page binding.
    if(tab && allowedTab(tab,provider) && (!state.started || !knownTabOwner(tab))){ids.add(tab.id);continue;}
    if(state.allocating)allocating++;
    else if(state.started || job.resumeProviders?.includes(provider))restoring[provider]++;
    else if(reservePending && !state.tabId && !state.delivered && !state.outcome && !job.serverStatus && !job.recoveryError)reserved++;
  }
  // An identified but untracked managed tab is NOT a personal tab. Protect/count
  // it until its matching job is recovered or a secured cleanup releases it.
  const orphanTabs = tabs.filter(tab=>{
    const owner=knownTabOwner(tab);
    if(!owner?.jobId || owner.released || ids.has(tab.id) || session[preservedKey(owner.jobId,owner.provider,owner.runId)])return false;
    const registered=jobs[owner.jobId]?.states?.[owner.provider];
    return !registered?.cleanupDone;
  });
  for(const tab of orphanTabs)ids.add(tab.id);
  let restorationReserved=0;
  for(const provider of ["chatgpt","grok"]) {
    const uncertain=tabs.filter(tab=>!ids.has(tab.id) && allowedTab(tab,provider) && !knownTabOwner(tab)).length;
    restorationReserved+=Math.min(restoring[provider],uncertain);
  }
  const unknownReserved=tabs.filter(tab=>!ids.has(tab.id) && (allowedTab(tab,"chatgpt") || allowedTab(tab,"grok")) && !knownTabOwner(tab)).length;
  // Census uncertainty cannot silently overbook an already running orphan. This
  // reservation is released by positive unbound/released evidence, never age.
  const used=ids.size+allocating+reserved+unknownReserved;
  return {limit,used,unknownReserved,orphanTabs:orphanTabs.length,available:Math.max(0,limit-used),managedTabs:ids.size,reserved:allocating+reserved,
    restorationReserved,providerTabs:tabs.filter(tab=>allowedTab(tab,"chatgpt") || allowedTab(tab,"grok")).length,
    unverifiedTabs:tabs.filter(tab=>(allowedTab(tab,"chatgpt") || allowedTab(tab,"grok")) && !knownTabOwner(tab)).length,
    blockers:[...slots.map(({job,provider,state})=>({jobId:job.jobId,provider,tabId:state.tabId,reason:slotReason(state)})),
      ...orphanTabs.map(tab=>({jobId:knownTabOwner(tab).jobId,provider:knownTabOwner(tab).provider,tabId:tab.id,reason:"untracked_binding_requires_recovery"}))].slice(0,32)};
}
async function tabCapacityAvailable(jobs, reservePending = false) {
  const report=await tabCapacityReport(jobs,reservePending);
  return report.used < report.limit;
}

async function maintenanceState() {
  const state=(await chrome.storage.local.get([MAINTENANCE_KEY]))[MAINTENANCE_KEY];
  return state?.active===true && typeof state.id==="string" ? state : null;
}
async function maintenanceHeld() { return Boolean(await maintenanceState()); }

/** The fix deliveries this profile opened (or began opening) a tab for (see FIX_DELIVERIES_KEY),
 * expired ones dropped. A record is {deliveryId, at, provider, phase: "creating" | "created", tabId}. */
async function fixDeliveries() {
  const stored = (await chrome.storage.local.get([FIX_DELIVERIES_KEY]))[FIX_DELIVERIES_KEY];
  const now = Date.now();
  return Object.fromEntries(Object.entries(stored && typeof stored === "object" ? stored : {})
    .filter(([, value]) => typeof value?.deliveryId === "string" && Number.isFinite(value.at) && now - value.at < FIX_DELIVERY_RETAIN_MS));
}

function updateFixDeliveries(change) {
  return writeInOrder(async () => {
    const all = await fixDeliveries();
    change(all);
    await chrome.storage.local.set({[FIX_DELIVERIES_KEY]: all});
  });
}

/** Phase 1 of a fix delivery record, written BEFORE its tab is created: `creating` is an intent,
 * never proof that a tab exists (reconcileFixDeliveries clears it unless a tab or binding proves it). */
function beginFixDelivery(job, provider) {
  if (job.kind !== "fix" || typeof job.deliveryId !== "string" || !job.deliveryId) return Promise.resolve();
  return updateFixDeliveries(all => { all[job.jobId] = {deliveryId: job.deliveryId, provider, phase: "creating", at: Date.now()}; });
}

/** Phase 2, written only after chrome.tabs.create returned the tab and its owned-tab record is
 * stored: `created`, naming that tab. */
function promoteFixDelivery(job, provider, tabId) {
  if (job.kind !== "fix" || typeof job.deliveryId !== "string" || !job.deliveryId) return Promise.resolve();
  return updateFixDeliveries(all => {
    all[job.jobId] = {deliveryId: job.deliveryId, provider, phase: "created", tabId, at: all[job.jobId]?.at ?? Date.now()};
  });
}

function forgetFixDelivery(job) {
  if (job.kind !== "fix") return Promise.resolve();
  return updateFixDeliveries(all => { delete all[job.jobId]; });
}

/** The fix deliveries that locally PROVE a tab: what admission lists in excludeJobIds and never
 * opens again. A record of a job this worker still holds is its own allocation (the registry's
 * allocation journal decides it; the job is excluded anyway). Any other record counts only while a
 * tab proves it by its BINDING: a live tab on the provider that this browser session's owned-tab
 * record or the tab inventory (the page's own binding) names the job for; a `creating` record proven
 * that way (the worker stopped after the create, before the promotion) is promoted. A `created`
 * record's tab id alone proves nothing: tab ids are unique only within one browser session, and the
 * record outlives it (storage.local), so after a browser restart the id can name the user's own tab
 * (as for tabCreatedForLeg, #82). While that tab's page has not been read yet (no session record for
 * it, the inventory still probing it, or it cannot answer: discarded, loading) the record is kept as
 * it is: after an extension reload the same id can still be the tab holding the run, and clearing
 * it then would send the prompt a second time. A record nothing proves (the worker stopped or was
 * reset between the intent and chrome.tabs.create, its tab is gone, or the page in it names no
 * binding of this job) is cleared, so the server replays that delivery and it is opened once,
 * instead of stranding the fix until its deadline. */
async function reconcileFixDeliveries(jobs) {
  const records = await fixDeliveries();
  if (!Object.keys(records).length) return records;
  const tabs = await chrome.tabs.query({}), live = new Map(tabs.map(tab => [tab.id, tab]));
  const session = await chrome.storage.session.get(null);
  const onProvider = (tab, provider) => Boolean(tab) && (!provider || allowedTab(tab, provider));
  const boundTab = (jobId, provider) => {
    for (const [key, value] of Object.entries(session)) {
      const tab = key.startsWith(OWNED_PREFIX) && value?.jobId === jobId ? live.get(Number(key.slice(OWNED_PREFIX.length))) : undefined;
      if (onProvider(tab, provider)) return tab.id;
    }
    return tabs.find(tab => knownTabOwner(tab)?.jobId === jobId && onProvider(tab, provider))?.id;
  };
  const proven = {}, rewrite = {};
  for (const [jobId, record] of Object.entries(records)) {
    if (jobs[jobId]) { proven[jobId] = record; continue; }
    const createdTab = record.phase === "created" ? live.get(record.tabId) : undefined;
    const tabId = boundTab(jobId, record.provider);
    if (!tabId) {
      // The recorded tab is still open on the provider, but nothing has read which binding its page
      // holds yet: kept (still excluded) until the inventory reads it.
      const unread = onProvider(createdTab, record.provider) && !session[OWNED_PREFIX + createdTab.id] && !knownTabOwner(createdTab);
      if (unread) proven[jobId] = record; else rewrite[jobId] = null;
      continue;
    }
    proven[jobId] = {...record, phase: "created", tabId};
    if (record.phase !== "created" || record.tabId !== tabId) rewrite[jobId] = proven[jobId];
  }
  if (Object.keys(rewrite).length) {
    // Only a record still exactly as it was read is rewritten (a concurrent write wins).
    const same = (a, b) => a?.deliveryId === b.deliveryId && a.at === b.at && a.phase === b.phase && a.tabId === b.tabId;
    await updateFixDeliveries(all => {
      for (const [jobId, next] of Object.entries(rewrite)) {
        if (!same(all[jobId], records[jobId])) continue;
        if (next) all[jobId] = next; else delete all[jobId];
      }
    });
  }
  return proven;
}

async function allocateProviderTab(job, provider, jobs) {
  // Serialize only the short capacity/create boundary, never model or bridge RPCs.
  const operation = allocationTail.then(async () => {
    const state = job.states[provider];
    if (state.tabId || state.allocating || await maintenanceHeld() || !await tabCapacityAvailable(jobs)) return;
    state.allocating = true;
    try { await saveJobs(jobs); }
    catch (error) { delete state.allocating; throw error; } // No create was attempted.
    try { await beginFixDelivery(job, provider); }
    catch (error) { delete state.allocating; await saveJobs(jobs).catch(() => {}); throw error; } // No create was attempted.
    try {
      const created = await chrome.tabs.create({url: providerUrl(provider, job.reasoning?.[provider]), active: true});
      state.tabId = created.id;
      workerStep(job,provider,"tab_created");
      await rememberOwnedTab(job, provider);
      // The delivery record says `created` only now that the tab exists and carries its owned record.
      // A failed promotion is not fatal: that owned record proves the tab (reconcileFixDeliveries).
      await promoteFixDelivery(job, provider, created.id).catch(() => {});
      delete state.allocating;
      await saveJobs(jobs); // Durable binding before any prompt dispatch.
    } catch (error) {
      if (!state.tabId) {
        delete state.allocating; await saveJobs(jobs);
        await forgetFixDelivery(job).catch(() => {}); // the create failed: no tab holds this delivery
      }
      throw error;
    }
  });
  allocationTail = operation.catch(() => {});
  return operation;
}

function compactFinalCapturedSource(state) {
  if(!state.delivered || !state.cleanupDone || !sourceArchiveDurable(state))return false;
  delete state.sourceCapture.text;
  delete state.sourceCapture.context;
  if(state.observation)delete state.observation.text;
  if(state.repairAttempt?.sourceHash===state.sourceCapture.sourceHash)delete state.repairAttempt.text;
  return true;
}

/** Why a tab is kept open (the preserve_<cause> history stage; a function so tests can read it). */
function preserveCauses() {
  return ["navigated", "user_turn", "edited", "draft", "ownership_unknown", "unreachable", "other_binding", "unknown"];
}

/** `cause` (a preserved tab only): why the tab was kept, recorded as preserve_<cause> just before
 * tab_preserved so review history says why (the cleanup note is dropped with the retired job). */
async function finishTabCleanup(job, provider, jobs, reason, cause) {
  const state = job.states[provider];
  state.cleanupDone = true;
  state.cleanupPending = false;
  if (reason?.includes("preserved")) {
    state.preserveCause = preserveCauses().includes(cause) ? cause : "unknown";
    workerStep(job, provider, `preserve_${state.preserveCause}`);
  }
  workerStep(job,provider,reason?.includes("preserved") ? "tab_preserved" : "tab_closed");
  if (reason) state.cleanupNote = reason;
  delete state.cleanupError;
  delete state.cleanupWaitReason;
  await saveJobs(jobs);
  if(sourceArchiveDurable(state)) {
    // Browser ownership can be released before JSON repair finishes, but the
    // exact local source fallback must survive until the repaired/final result
    // is durably acknowledged. Only then is metadata-only compaction safe.
    if(state.observation)delete state.observation.text;
    if(state.formatError && !state.delivered)delete state.outcome;
    if(state.repairAttempt?.sourceHash===state.sourceCapture.sourceHash)delete state.repairAttempt.text;
    compactFinalCapturedSource(state);
    if(job.providers.every(p=>job.states[p].delivered || sourceArchiveDurable(job.states[p]))) {
      delete job.prompt;delete job.prompts;
    }
    await saveJobs(jobs);
  }
  // The tab record is this leg's only while it still names this leg: a tab that now carries another
  // binding keeps that binding's record (its explicit-close tracking), whichever kind retires here.
  const ownedKey = OWNED_PREFIX + state.tabId;
  const owned = state.tabId ? (await chrome.storage.session.get([ownedKey]))[ownedKey] : undefined;
  const mine = owned && owned.jobId === job.jobId && owned.provider === provider;
  await chrome.storage.session.remove(mine ? [ownedKey, closedKey(job, provider)] : [closedKey(job, provider)]);
}

/** Retryable journal: delivered -> cleanupPending -> closed -> cleanupDone.
 * Never delete the last ownership record before remove() has succeeded.
 */
function cleanupProvider(job, provider, jobs) {
  return singleFlight(cleanupLanes,`${job.origin}:${job.jobId}:${provider}`,()=>cleanupProviderBody(job,provider,jobs));
}
async function cleanupProviderBody(job, provider, jobs) {
  const state = job.states[provider], key=`${job.origin}:${job.jobId}:${provider}`;
  if (capturePersistence.has(key) || (!state.delivered && !sourceArchiveDurable(state)) || state.cleanupDone || state.repairReceiptPending) return;
  state.cleanupPending = true;
  workerStep(job,provider,"cleanup_pending");
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
        // Once the full source receipt is durably local+server stored, tab absence
        // cannot strand repair. It also cannot authorize closing a replacement.
        if (sourceArchiveDurable(state)) return finishTabCleanup(job, provider, jobs, "archived source durable; original tab absent");
        // A previous remove may have succeeded just before the worker stopped.
        if (state.closeRequested) return finishTabCleanup(job, provider, jobs, "close confirmed by absence");
        // Nobody wants this leg's result: there is nothing left to wait for.
        if (abandonedLeg(job, state)) return finishTabCleanup(job, provider, jobs, "no result wanted; tab absent");
        state.cleanupError = "original tab unavailable; cleanup waits for reconnection";
        cleanupWaiting(job, provider, "tab_unavailable");
        await saveJobs(jobs);
        return;
      }
      state.tabId = tab.id;
      await saveJobs(jobs);
    }
    if (!allowedTab(tab, provider)) return finishTabCleanup(job, provider, jobs, "user navigated away; tab preserved", "navigated");
    return forceCloseFixTab(job, provider, jobs, tab);
  } catch (e) {
    state.cleanupError = String(e.message || e).slice(0, 240);
    await saveJobs(jobs);
  }
}

/** The one managed close, for a tab whose page just proved it may close (forceCloseFixTab): the
 * tab must still be on the proven page (`proven`: the exact URL that answered, or a predicate over
 * the tab's URL that checks the identity the worker stored: the run's bound conversation, the page
 * it last answered on, or its allocation page), with no pending navigation and not loading, and
 * the close is recorded durably before the remove so a worker that stops in between retires it by
 * absence. */
async function closeProvenTab(job, provider, jobs, tabId, proven, reason) {
  const current = await chrome.tabs.get(tabId);
  const holds = typeof proven === "function" ? proven : url => url === proven;
  if (current.pendingUrl || !holds(current.url) || current.status === "loading") return false;
  job.states[provider].closeRequested = true;
  await saveJobs(jobs);
  await rememberOwnedTab(job, provider, true);
  await chrome.tabs.remove(tabId);
  await finishTabCleanup(job, provider, jobs, reason);
  return true;
}

/** Whether two URLs show the same page for tab ownership (json.js samePage): origin and path
 * (trailing slashes ignored). The query and fragment are not the page: ChatGPT's
 * `?temporary-chat=true` names a mode, not another conversation. */
function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const path = url => url.pathname.replace(/\/+$/, "");
    return x.origin === y.origin && path(x) === path(y);
  } catch { return false; }
}

/** Whether `url` is still the page a tab was opened on (providerUrl: the provider's new chat). */
function onAllocationPage(url, provider) {
  return samePage(url, providerUrl(provider));
}

/** The page a run last answered on (state.pageUrl), when it can serve as the run's identity: not
 * while it is still the page the tab was opened on, which names no conversation yet. A provider
 * moves that URL to the conversation it assigns after the send (ChatGPT's bare new chat, Grok's
 * home), and a move the worker has not polled since is not the user's: the page decides then. */
function answeredPage(state, provider) {
  return state.pageUrl && !onAllocationPage(state.pageUrl, provider) ? state.pageUrl : "";
}

/** Keep the conversation a run (review or fix) was bound in, as its page recorded it in the
 * submission journal: a fix (and a review sent on a conversation page) when its send was proven
 * (composer.js submissionConfirmed), a review sent on a new chat where the provider put it (json.js
 * pinNewChatReview). Stored ONCE and never replaced (no location-based upgrade: a later URL is no
 * evidence of whose conversation it is), so a later reply (or the tab's URL) is compared with it,
 * never with a URL echoed by the same reply. True if it was stored now. */
function adoptFixConversation(state, result) {
  const seen = typeof result?.conversation === "string" && result.conversation.length <= 4096 ? result.conversation : "";
  if (!seen || state.conversation) return false;
  state.conversation = seen;
  return true;
}

/** How long a settled leg's tab whose ownership cannot be proven (loading, discarded, unreachable,
 * another binding, not rendered) is re-asked before it is preserved. */
const FIX_OWNERSHIP_WAIT_MS = 2 * 60_000;

/** Why a settled leg's cleanup is waiting on its page (the capacity blocker shows it). A new reason
 * is also a history step, uploaded at once (best effort, not awaited): a cleanup that never finishes
 * never reaches the final flush at retirement. */
function cleanupWaiting(job, provider, reason) {
  const state = job.states[provider];
  if (state.cleanupWaitReason === reason) return;
  state.cleanupWaitReason = reason;
  workerStep(job, provider, "cleanup_waiting_page");
  void flushProgress(job).catch(() => {});
}

/** The one exit for a tab Ashlar keeps open (taken over, moved, unidentifiable, stuck loading):
 * the page is asked to free its managed slot (and stop its run) when it can be messaged (`tab`),
 * and the worker records the preserved run as a backstop (the page may never answer), so the
 * retained binding is never counted as an orphan against tab capacity. Then the job retires. */
async function preserveFixTab(job, provider, jobs, reason, tab, cause) {
  const state = job.states[provider];
  if (tab) await askPage(tab.id, {...tabMessage(job, provider, "ashlar-fix-cancel"), preserve: true}, contentFiles(provider)).catch(() => {});
  await chrome.storage.session.set({[preservedKey(job.jobId, provider, state.runId)]: {tabId: state.tabId}});
  return finishTabCleanup(job, provider, jobs, reason, cause);
}

/** Ask again next tick until FIX_OWNERSHIP_WAIT_MS has passed, then preserve the tab so the job
 * retires (`tab` omitted: the page cannot be messaged, e.g. still loading). */
async function waitOrPreserveFixTab(job, provider, jobs, reason, tab, cause) {
  const state = job.states[provider];
  state.ownershipUnknownAt ??= Date.now();
  if (Date.now() - state.ownershipUnknownAt < FIX_OWNERSHIP_WAIT_MS) return saveJobs(jobs);
  return preserveFixTab(job, provider, jobs, reason, tab, cause);
}

/** A leg whose result nobody wants any more: the server cancelled (or superseded) its job, or
 * forgot it. Durable: `abandoned` survives a later "missing" once a restarted harbor forgot the
 * cancelled job. A leg delivered with no outcome and no durable archive was only ever settled that
 * way (the shape 1.1.22 stored before this flag existed). */
function abandonedLeg(job, state) {
  return state.abandoned === true || job.serverStatus === "cancelled" ||
    (state.delivered === true && !state.outcome && !sourceArchiveDurable(state));
}

/** Settle every leg of a job the server cancelled or forgot (`status`): nothing is delivered for it
 * any more, and its tab is released by the same verdict as a secured one (forceCloseFixTab). */
function abandonLegs(job, providers, status) {
  for (const provider of providers) {
    const state = job.states[provider];
    if (!state.delivered) { state.abandoned = true; state.abandonedAs = status; }
    state.delivered = true;
    state.cleanupPending = true;
  }
}

/** A tab Chrome discarded to save memory (or has not loaded since) holds no page: nothing in it can
 * answer, and no follow-up, draft or edit is readable in it until it loads again (then its page
 * renders what the provider kept, and gives the verdict). Its URL is still readable: on another
 * page than the run's own it is the user's, preserved at once. Otherwise, in the tab this browser
 * session created for the leg, it is woken once (reloaded in the background, as activating it would)
 * so its page answers on a later tick within the same ownership wait; a tab that cannot be woken is
 * preserved after the wait. A frozen tab is not this (it keeps its page): see forceCloseFixTab. */
async function releaseDiscardedTab(job, provider, jobs, tab) {
  const state = job.states[provider];
  const known = state.conversation || answeredPage(state, provider);
  if (known && !samePage(tab.url, known)) return preserveFixTab(job, provider, jobs, "the tab moved to another conversation; tab preserved", undefined, "navigated");
  cleanupWaiting(job, provider, "tab_discarded");
  if (!state.wokeDiscardedTab && await tabCreatedForLeg(job, provider, tab.id)) {
    state.wokeDiscardedTab = true;
    await saveJobs(jobs);
    try { await chrome.tabs.reload(tab.id); } catch { /* still discarded: preserved after the wait */ }
  }
  return waitOrPreserveFixTab(job, provider, jobs, "the discarded tab could not answer; tab preserved", undefined, "unreachable");
}

/** The ownership verdict in a page reply: a verdict reply (ownership) as is; a cancel reply of an
 * earlier page by its `owned`; an older page's review can-close by canClose / reason. A fix page
 * always states its verdict: a fix can-close without one is not permission to close. */
function tabVerdict(result, kind) {
  if (typeof result?.ownership === "string") return result;
  if (typeof result?.owned === "boolean") return {...result, ownership: result.owned ? "owned" : "takenOver"};
  if (result?.canClose === true && kind !== "fix") return {...result, ownership: "owned", legacyReply: true};
  return {...result, ownership: result?.reason === "repurposed" ? "takenOver" : "unknown"};
}

/** The one release exit for a settled leg's tab (#82): a leg whose result is secured asks
 * "ashlar-can-close"; an abandoned leg (abandonedLeg: cancelled or forgotten, either kind, whatever
 * it collected) asks "ashlar-fix-cancel", which also stops its run, even while it is still
 * generating. Both get the page's ownership verdict (json.js tabOwnership): the tab is closed
 * unless the user positively took it over (then preserved and released), and preserved after
 * FIX_OWNERSHIP_WAIT_MS when ownership cannot be proven: never held forever, never closed on a
 * guess. A tab that carries another binding is never closed nor told to release. */
async function forceCloseFixTab(job, provider, jobs, tab) {
  const state = job.states[provider];
  // Whether the tab may close never follows the server status (#77, Ashlar 4097631101): both exits
  // get the same verdict, and it compares nothing about the answer (#82: ChatGPT keeps redrawing a
  // finished one), so a collected answer the server then cancels or forgets is released exactly as
  // a secured one. The exit decides only whether the page's run is stopped too, and the cleanup
  // note. A fix that collected no answer (its run failed: quota, an error) is asked with the cancel
  // exit too (it also stops whatever that run still does); one that did (state.outcome.ok, or
  // `rejectedRaw` for an answer the server rejected with 400) is not, unless it was abandoned.
  const collected = state.outcome?.ok === true || typeof state.rejectedRaw === "string";
  const cancelled = abandonedLeg(job, state) || (job.kind === "fix" && !collected);
  if (tab.discarded === true || tab.status === "unloaded") return releaseDiscardedTab(job, provider, jobs, tab);
  if (tab.status && tab.status !== "complete") {
    // A loading tab cannot answer for itself yet: asked again next tick.
    cleanupWaiting(job, provider, "tab_loading");
    return waitOrPreserveFixTab(job, provider, jobs, "the tab never finished loading; tab preserved", undefined, "unreachable");
  }
  if (tab.frozen === true) {
    // A frozen tab (Chrome's energy saver) runs no handler until the user brings it back: a message
    // would only wait. It keeps its page (a draft included), so it is never reloaded to ask either.
    cleanupWaiting(job, provider, "tab_frozen");
    return waitOrPreserveFixTab(job, provider, jobs, "the tab was frozen and could not answer; tab preserved", undefined, "unreachable");
  }
  // A tab opened for a run that was never sent is unbound by design: the page then answers for an
  // unbound tab (Ashlar's only while it holds no turn and no draft), and only in the tab this browser
  // session created for the leg. Without that record the stored id may name the user's own tab: it
  // is asked like any tab (only a page bound to this run can answer), never claimed as Ashlar's.
  const undispatched = cancelled && !state.started && await tabCreatedForLeg(job, provider, tab.id);
  if (!undispatched) {
    // The tab's own URL first: the conversation the run was bound in, else the page where this run
    // last answered (answeredPage).
    const known = state.conversation || answeredPage(state, provider);
    if (known && !samePage(tab.url, known)) return preserveFixTab(job, provider, jobs, "the tab moved to another conversation; tab preserved", tab, "navigated");
  }
  const message = {...tabMessage(job, provider, cancelled ? "ashlar-fix-cancel" : "ashlar-can-close"),
    allocationUrl: providerUrl(provider), ...(undispatched ? {undispatched: true} : {})};
  let result;
  try { result = await askPage(tab.id, message, contentFiles(provider)); } catch {
    // No receiver and reinjection failed, or no answer in time (askPage): ownership is unknown and
    // the page cannot be messaged.
    cleanupWaiting(job, provider, "page_unreachable");
    return waitOrPreserveFixTab(job, provider, jobs, "the tab could not be reached; tab preserved", undefined, "unreachable");
  }
  const unbound = undispatched && result?.ok === true && !result.jobId && !result.runId && result.provider === provider;
  if (!(matchesJob(result, job, provider) || unbound)) {
    // The tab now carries another binding (or none it can prove): never closed. Past the ownership
    // wait the leg retires and the tab is left to whoever holds it (never messaged, its binding and
    // records untouched).
    state.cleanupError = "tab ownership does not match; no tab was closed";
    cleanupWaiting(job, provider, "ownership_mismatch");
    return waitOrPreserveFixTab(job, provider, jobs, "the tab carries another binding; tab preserved", undefined, "other_binding");
  }
  // The page's own steps (context_changed, cancelled, ...) reach history from cleanup replies too.
  ingestPageProgress(state, result);
  const verdict = tabVerdict(result, job.kind);
  if (verdict.ownership === "unknown") {
    // Another conversation than the one the run was bound in (an in-page move can leave the old DOM
    // on screen): the user's, and waiting cannot change a recorded identity.
    if (verdict.identity === "changed") return preserveFixTab(job, provider, jobs, "the tab moved to another conversation; tab preserved", tab, "navigated");
    // The page never recorded the conversation its send was made in (a fix journal from before that
    // rule, or a send confirmed only after a reload): it is recorded only when the send is proven,
    // so waiting cannot establish it. Never closed; preserved now. (Only a fix page reports this: a
    // review without a pinned conversation answers `unpinned`, see json.js tabOwnership.)
    if (verdict.identity === "unestablished") return preserveFixTab(job, provider, jobs, "the conversation was never identified at send; tab preserved", tab, "ownership_unknown");
    // Not provable yet (a reload still rendering, an unreadable journal): ask again next tick; past
    // the wait, preserve it (never close what might be the user's) and have the page free its slot.
    cleanupWaiting(job, provider, "ownership_unknown");
    return waitOrPreserveFixTab(job, provider, jobs, "tab ownership could not be established; tab preserved", tab, "ownership_unknown");
  }
  if (verdict.ownership !== "owned") return preserveFixTab(job, provider, jobs, "the user took over the tab; tab preserved", tab, verdict.cause);
  delete state.cleanupWaitReason;
  const closed = cancelled ? "no result wanted; tab closed" : "result secured; tab closed";
  // A verdict resting on a page with no bound turn (blank, or the just-clicked prompt before the
  // send was confirmed) proves content, not which page this is: Ashlar's only while the tab is
  // still on the page it was opened on (an empty conversation the user moved to is the user's).
  if (unbound || verdict.blank === true || verdict.unsent === true) {
    if (!onAllocationPage(result.url, provider)) return preserveFixTab(job, provider, jobs, "the unsent tab moved to another page; tab preserved", tab, "navigated");
    // An unbound page's answer proves nothing about the tab: the record is checked again at the close.
    if (unbound && !await tabCreatedForLeg(job, provider, tab.id)) {
      cleanupWaiting(job, provider, "ownership_mismatch");
      return waitOrPreserveFixTab(job, provider, jobs, "the tab carries another binding; tab preserved", undefined, "other_binding");
    }
    await closeProvenTab(job, provider, jobs, tab.id, url => onAllocationPage(url, provider), closed);
    return;
  }
  // A run with no pinned conversation (still generating, a legacy journal, an older page): the
  // identity the worker observed itself, the page where the run last answered, else (older pages)
  // the URL that answered. An unpinned run known only on the page the tab was opened on is where
  // its page just proved its sent turn is still the last one: the conversation the provider
  // assigned since (a review on a new-chat page pins only on the first conversation page it is
  // shown on, or once its answer is complete: json.js waitUntilReviewOrQuota).
  if (verdict.unpinned === true || verdict.legacy === true || verdict.legacyReply === true) {
    const identity = state.conversation || answeredPage(state, provider) || (verdict.unpinned === true ? result.url : state.pageUrl);
    const holds = identity ? url => samePage(url, identity) : verdict.legacyReply ? url => url === result.url : url => onAllocationPage(url, provider);
    if (!holds(result.url)) return preserveFixTab(job, provider, jobs, "the tab moved to another conversation; tab preserved", tab, "navigated");
    await closeProvenTab(job, provider, jobs, tab.id, holds, closed);
    return;
  }
  // A verdict resting on the bound turn holds only in the conversation that turn was bound in: the
  // identity the worker stored (adopted once from the page's journal), never the URL echoed here.
  if (adoptFixConversation(state, result)) await saveJobs(jobs);
  const bound = state.conversation;
  if (!bound || !result.conversation) {
    state.cleanupError = "the conversation identity is not established; no tab was closed";
    cleanupWaiting(job, provider, "conversation_unestablished");
    return waitOrPreserveFixTab(job, provider, jobs, "the conversation identity was never established; tab preserved", tab, "ownership_unknown");
  }
  if (!samePage(result.conversation, bound) || !samePage(result.url, bound)) {
    return preserveFixTab(job, provider, jobs, "the tab moved to another conversation; tab preserved", tab, "navigated");
  }
  await closeProvenTab(job, provider, jobs, tab.id, url => samePage(url, bound), closed);
}

async function retireCleanJob(job, jobs, forgotten = false, signal) {
  if (!job.providers.every(p => job.states[p].delivered && job.states[p].cleanupDone)) return false;
  // Final trace uploading terminal events (result_saved, tab_closed) to review history. Detach it ONLY
  // for a job the caller FRESHLY confirmed the server has forgotten (missing/unknown): recordBridgeProgress
  // can't find the evicted job so the upload is rejected, and the bridge fetch is unbounded — awaiting it
  // would hang retirement and the "Clear stuck jobs" sweep. Otherwise AWAIT, so the events reach history
  // before deletion. The flag must come from a fresh probe (the clear sweep), NOT from job.serverStatus:
  // advanceJob retires on its early return BEFORE its next heartbeat, so that cached status can be a stale
  // "missing" for a job the bridge already restored — detaching there would drop a live job's history.
  if (forgotten) void flushProgress(job).catch(() => {});
  else await flushProgress(job, signal).catch(() => {});
  // The awaited flush can be aborted by the sweep watchdog, which has already released the sweep's lock;
  // the session/local deletions below are NOT signal-abortable, so run them here and they would overlap
  // the next alarm's sweep. Recheck the signal and bail before deleting under a newer sweep's ownership.
  if (signal?.aborted) return false;
  await writeInOrder(async () => {
    const old = await chrome.storage.session.get(["tabs"]);
    const tabs = {...old.tabs};
    for (const p of job.providers) delete tabs[`${job.jobId}:${p}`];
    await chrome.storage.session.set({tabs});
    await chrome.storage.local.remove(["ashlar:job:" + job.jobId]);
    const ring = (await chrome.storage.local.get([RECENT_RETIRED_KEY]))[RECENT_RETIRED_KEY];
    const retired = job.providers.map(provider => {
      const state = job.states[provider];
      return {jobId: job.jobId, kind: job.kind === "fix" ? "fix" : "review", provider, tabId: state.tabId,
        stage: state.workerEvents?.at(-1)?.stage || "", cause: state.preserveCause, note: state.cleanupNote, at: Date.now()};
    });
    await chrome.storage.local.set({[RECENT_RETIRED_KEY]: [...(Array.isArray(ring) ? ring : []), ...retired].slice(-16)});
  });
  // writeInOrder above is itself an unabortable storage sequence that can outlive the sweep watchdog.
  // Recheck before the registry delete/persist so an abandoned sweep can't delete jobs[jobId] and rewrite
  // pendingReviewJobs concurrently with the next alarm's sweep. (delete + saveJobs is sync-then-await, so
  // no abort can interleave between them once we pass this fence.)
  if (signal?.aborted) return false;
  delete jobs[job.jobId];
  await saveJobs(jobs);
  // Its item is settled on the server: no replay of its delivery can come any more.
  await forgetFixDelivery(job).catch(() => {});
  return true;
}

function connectionErrors(job) {
  return Object.fromEntries(job.providers.filter(p => job.states[p].connectionError && !job.states[p].outcome)
    .map(p => [p, {code: "disconnected", message: job.states[p].connectionError}]));
}

function heartbeat(job, jobs, signal) {
  return singleFlight(heartbeatLanes, `${job.origin}:${job.jobId}`, () => refreshJobHeartbeat(job, jobs, signal));
}

async function refreshJobHeartbeat(job, jobs, signal) {
  const body = {action: "ping", jobId: job.jobId, leaseId: job.leaseId,
    generating: generatingFor(job), providerErrors: connectionErrors(job), progress: progressFor(job)};
  let result = await api("/api/bridge", body, job.origin, signal);
  job.localJsonRepairEnabled = result.bridge?.localJsonRepairEnabled === true;
  job.captureProtocol = result.bridge?.captureProtocol === 1 ? 1 : 0;
  if (result.active === false) {
    job.serverStatus = result.status || "unknown";
    await saveJobs(jobs);
    return false; // Not equivalent to cancellation, receipt, or permission to close.
  }
  delete job.serverStatus;
  if (result.accepted === false || !job.leaseId) {
    const claim = await api("/api/bridge", {action: "claim", jobId: job.jobId, clientId: await clientId()}, job.origin, signal);
    job.leaseId = claim.leaseId;
    await saveJobs(jobs);
    result = await api("/api/bridge", {...body, leaseId: job.leaseId}, job.origin, signal);
    if (result.accepted === false) throw new Error("bridge lease could not be renewed");
  }
  return true;
}

async function pollProvider(job, provider, jobs, observeOnly = false) {
  const state = job.states[provider];
  if (state.outcome || state.delivered || sourceArchiveDurable(state)) return;
  if (!state.runId) state.runId = crypto.randomUUID();
  // Memory is not a receipt: a previous write may have failed while leaving the
  // shared object mutated. Retry persistence before ANY tab can adopt this runId
  // or use a newly allocated binding, including findOriginalTab's harvest probes.
  await saveJobs(jobs);
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
    if (!state.tabId && job.kind === "fix" && (await fixDeliveries())[job.jobId]?.phase !== "created") {
      // A fix allocation intent that never became a proven tab (no owned record, no bound page, and
      // its delivery record never reached `created`: the worker stopped between the intent and
      // chrome.tabs.create) is cleared, and the allocation below opens the tab once. Keeping the
      // intent would strand the fix until its deadline. (A review keeps its intent, as before.)
      delete state.allocating;
      delete state.connectionError;
      await saveJobs(jobs);
      await forgetFixDelivery(job);
    } else if (!state.tabId) {
      state.connectionError = "tab creation outcome unknown; original allocation preserved";
      await saveJobs(jobs);
      return;
    } else {
      delete state.allocating;
      await saveJobs(jobs);
    }
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
  if (!state.started && !observeOnly && !await tabCreatedForLeg(job, provider, state.tabId)) {
    // The prompt goes only into the tab this browser session created for the leg: a stored id from
    // before a browser restart (or an extension reload) can name the user's own tab. The leg opens
    // its own tab instead; the old id is never messaged.
    delete state.tabId;
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
      workerStep(job,provider,"run_dispatched");
      await saveJobs(jobs);
    } else {
      result = await sendToTab(state.tabId, tabMessage(job, provider, "ashlar-harvest"), contentFiles(provider));
      if (result?.code === "idle" && (!observeOnly || matchesJob(result, job, provider))) {
        // A reloaded bound page has no in-memory collector. Missing server work
        // may resume observation, never adopt a page or submit another prompt.
        const resume = observeOnly
          ? { ...tabMessage(job, provider, "ashlar-run"), resume: true }
          : { ...run, resume: true };
        result = await sendToTab(state.tabId, resume, contentFiles(provider));
      }
    }
  } catch (e) {
    // A messaging outage is not a model failure or a global admission lock.
    state.connectionError = String(e.message || e).slice(0, 240);
    workerStep(job,provider,"disconnected");
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
  if (ingestPageProgress(state, result)) await saveJobs(jobs);
  if (result.observation && typeof result.observation === "object") {
    const item = result.observation;
    const text = typeof item.text === "string" ? item.text.slice(0, 128_000) : "";
    state.observation = {state: String(item.state || "unknown").slice(0, 80), text,
      totalChars: Number.isSafeInteger(item.totalChars) ? item.totalChars : text.length,
      truncated: Boolean(item.truncated)};
    await saveJobs(jobs);
  }
  // The page reports the conversation its run was bound in: kept once, never replaced. The tab URL
  // where this run's page last answered is the release identity of a run that never pinned one.
  const adopted = adoptFixConversation(state, result);
  const answeredAt = typeof tab.url === "string" && tab.url.length <= 4096 && tab.url !== state.pageUrl ? tab.url : "";
  if (answeredAt) state.pageUrl = answeredAt;
  if (adopted || answeredAt) await saveJobs(jobs);
  await rememberOwnedTab(job, provider);
  delete state.connectionError;
  if (isBusyResult(result)) return;
  // A fix answer is taken only with the page's positive ownership verdict for it (json.js
  // fixAnswerReply: the full proof, re-established when the answer is handed out).
  if (job.kind === "fix" && result?.ok && result.ownership !== "owned") return;
  if (result?.ok && typeof result.raw === "string" && result.raw.trim()) {
    state.outcome = { ok: true, raw: result.raw, originalText:typeof result.responseText==="string"?result.responseText:undefined,
      completion:typeof result.completion?.responseId === "string" && typeof result.completion?.context === "string"
        ? {responseId:result.completion.responseId,context:result.completion.context} : undefined };
    workerStep(job,provider,"response_collected");
  } else if (result?.code && result.code !== "idle") {
    state.outcome = failure(result.code, String(result.error || "chat review failed"));
  } else {
    // Older content scripts can say "no json" during generation. Never infer done.
    return;
  }
  await saveJobs(jobs);
  if (state.outcome.code === "quota") await markQuota(provider);
}

async function deliverOutcome(job, provider, jobs, signal) {
  const state = job.states[provider], out = state.outcome;
  // A durable archive normally settles via the repair-commit path, so it is not re-delivered here —
  // EXCEPT a no-repair salvage outcome, whose only delivery path is this complete request.
  if (!out || state.delivered || (sourceArchiveDurable(state) && !out.salvaged)) return;
  // A failed outbox write can also leave an outcome in the shared cache. Retry
  // that save before sending it; only the server ACK permits subsequent cleanup.
  workerStep(job, provider, "delivery_pending");
  await saveJobs(jobs);
  const body = out.ok
    ? {action: "complete", repairProtocol: 1, captureProtocol:job.captureProtocol, jobId: job.jobId, leaseId: job.leaseId, raw: out.raw, results: [{provider, raw: out.raw, originalText: out.originalText}]}
    : {action: "failure", jobId: job.jobId, leaseId: job.leaseId, provider, error: `${out.code}: ${out.error}`};
  try { await api("/api/bridge", body, job.origin, signal); }
  catch (e) {
    if (e.status === 422 && e.code === "json_repair_required" && out.ok) {
      state.formatError = true; // Preserve the original outbox; never turn it into an empty leg.
      await saveJobs(jobs);
      return;
    }
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
  delete state.formatError;
  workerStep(job,provider,"result_saved");
  const previousError = (await chrome.storage.local.get(["lastError"])).lastError;
  if (typeof previousError === "string" && previousError.startsWith(`Bridge ${body.action} (${job.jobId}) transport interrupted`)) {
    await chrome.storage.local.set({lastError: ""});
  }
  state.cleanupPending = true;
  await saveJobs(jobs);
  await cleanupProvider(job, provider, jobs);
}

function repairBody(job, provider, action, attempt) {
  return {action, jobId:job.jobId, leaseId:job.leaseId, provider, runId:job.states[provider].runId,
    repairId:attempt.id, responseId:attempt.responseId, sourceHash:attempt.sourceHash};
}
async function readRepairSource(job, provider, full = true) {
  const state=job.states[provider];
  if(sourceArchiveDurable(state)) {
    const saved=state.sourceCapture;
    let text=full ? undefined : saved.text;
    if(full) {
      // Prefer the immutable server archive even while a local fallback copy is
      // retained. If that read is temporarily unavailable or fails validation,
      // the exact locally persisted capture can still keep repair recoverable.
      try {
        const response=await api("/api/bridge",{action:"capture-read",jobId:job.jobId,leaseId:job.leaseId,provider,
          runId:state.runId,captureId:saved.id,responseId:saved.responseId,sourceHash:saved.sourceHash},job.origin);
        const item=response.capture;
        if(item?.id===saved.id && item.jobId===job.jobId && item.provider===provider && item.runId===state.runId &&
            item.responseId===saved.responseId && item.sourceHash===saved.sourceHash && item.headSha===saved.headSha &&
            typeof item.text==="string" && item.text.length===saved.totalChars && item.text.length<=500_000) {
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(item.text))))
            .map(byte=>byte.toString(16).padStart(2,"0")).join("");
          if(hash===saved.sourceHash) text=item.text;
        }
      } catch { /* fall back to the exact locally persisted capture below */ }
      if(typeof text!=="string" && typeof saved.text==="string") {
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(saved.text))))
          .map(byte=>byte.toString(16).padStart(2,"0")).join("");
        if(saved.text.length===saved.totalChars && saved.text.length<=500_000 && hash===saved.sourceHash) text=saved.text;
      }
      if(typeof text!=="string")return null;
    }
    return {text,totalChars:saved.totalChars,truncated:false,completed:true,stable:true,
      responseId:saved.responseId,sourceHash:saved.sourceHash,captureId:saved.id,context:saved.context};
  }
  if(!state.tabId)return null;
  const result=await sendToTab(state.tabId,tabMessage(job,provider,"ashlar-repair-source"),contentFiles(provider));
  const source=result?.source;
  if(!matchesJob(result,job,provider) || !result.ok || !source || typeof source.text!=="string" ||
     !source.text.trim() || source.text.length>500_000 || source.text.length!==source.totalChars ||
     source.truncated!==false || source.completed!==true || source.stable!==true ||
     typeof source.responseId!=="string" || !source.responseId)return null;
  const sourceHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source.text))))
    .map(byte=>byte.toString(16).padStart(2,"0")).join("");
  return {...source,sourceHash};
}
/** Source-only acknowledgement and final-result acknowledgement are distinct.
 * Capturing releases a browser resource; it never marks delivered or posts JSON.
 */
async function captureProvider(job, provider, jobs) {
  const state=job.states[provider], key=`${job.origin}:${job.jobId}:${provider}`;
  if(state.delivered || state.cleanupDone || sourceCleanupProofConfirmed(state) || job.captureProtocol!==1)return;
  let saved=state.sourceCapture;
  if(!saved?.id) {
    if(!state.formatError && state.observation?.state!=="response_completed_json_invalid")return;
    const source=await readRepairSource(job,provider);
    if(!source || typeof source.context!=="string")return;
    await flushProgress(job);
    if(state.delivered || (state.outcome?.ok && !state.formatError))return;
    const response=await api("/api/bridge",{action:"capture",jobId:job.jobId,leaseId:job.leaseId,provider,
      runId:state.runId,responseId:source.responseId,sourceHash:source.sourceHash,source},job.origin);
    const receipt=response.capture;
    if(!receipt?.id || receipt.jobId!==job.jobId || receipt.provider!==provider || receipt.runId!==state.runId ||
        receipt.responseId!==source.responseId || receipt.sourceHash!==source.sourceHash || receipt.totalChars!==source.text.length)return;
    saved={...source,...receipt,archiveDurable:false,cleanupProofConfirmed:false};
    state.sourceCapture=saved;
    workerStep(job,provider,"source_archive_saved");
  }
  // Server archive success and local receipt persistence are the durability
  // barrier for repair. Page revalidation is only cleanup authorization.
  if(!sourceArchiveDurable(state)) {
    capturePersistence.add(key);
    try {
      // First persist the exact server receipt while it is still marked pending.
      // Then persist the durable marker. Other lanes are fenced until both writes
      // succeed, so a tab cannot be released on memory-only state.
      await saveJobs(jobs);
      saved.archiveDurable=true;
      await saveJobs(jobs);
    } catch (error) {
      saved.archiveDurable=false;
      throw error;
    } finally {
      capturePersistence.delete(key);
    }
    workerStep(job,provider,"source_archived");
    await saveJobs(jobs);
  } else {
    await saveJobs(jobs);
  }
  if(state.delivered || (state.outcome?.ok && !state.formatError) || state.cleanupDone)return;
  if(!state.tabId) return finishTabCleanup(job,provider,jobs,"archived source durable; original tab absent");
  let result;
  try {
    result=await sendToTab(state.tabId,{...tabMessage(job,provider,"ashlar-capture-accepted"),committed:true,
      captureId:saved.id,responseId:saved.responseId,text:saved.text,context:saved.context},contentFiles(provider));
  } catch {
    return; // Repair can proceed from archive; cleanup retries independently.
  }
  if(!matchesJob(result,job,provider))return;
  ingestPageProgress(state,result);
  if(result.code==="capture_source_changed") {
    // The original is durably archived (secured); a changed page is not the user's by itself.
    state.cleanupPending=true;
    delete state.captureError;
    await saveJobs(jobs);
    return cleanupProvider(job,provider,jobs);
  }
  if(!result.accepted)return;
  saved.cleanupProofConfirmed=true;
  saved.confirmed=true; // Backward-compatible alias for pre-split persisted states.
  state.cleanupPending=true;
  delete state.captureError;
  await saveJobs(jobs);
  await cleanupProvider(job,provider,jobs);
}
async function notifyRepairReceipt(job, provider, jobs) {
  const state=job.states[provider], attempt=state.repairAttempt;
  if(!state.repairReceiptPending || !attempt?.raw || !attempt.text)return;
  // A prior outbox write may have failed after mutating the shared registry.
  // Re-establish durability on EVERY receipt retry, before notifying the page.
  await saveJobs(jobs);
  const result=await sendToTab(state.tabId,{...tabMessage(job,provider,"ashlar-repair-accepted"),
    committed:true,repairId:attempt.id,responseId:attempt.responseId,text:attempt.text,raw:attempt.raw},contentFiles(provider));
  if(!matchesJob(result,job,provider))return;
  ingestPageProgress(state,result);
  if(!result.accepted) {
    if(["repair_source_changed","repair_source_unavailable"].includes(result.code)) {
      // The server already secured this original; the page no longer attesting to it is not the
      // user's activity: the release verdict decides who holds the tab.
      state.repairReceiptPending=false;
      await saveJobs(jobs);
      await cleanupProvider(job,provider,jobs);
    }
    return;
  }
  state.repairReceiptPending=false;
  workerStep(job,provider,"repair_accepted");
  await saveJobs(jobs);
  await cleanupProvider(job,provider,jobs);
}
async function acceptRepairReceipt(job, provider, jobs, result) {
  const state=job.states[provider], attempt=state.repairAttempt;
  if(!attempt?.id || result?.status!=="accepted" || result.id!==attempt.id || result.runId!==state.runId ||
     result.sourceHash!==attempt.sourceHash || result.responseId!==attempt.responseId || typeof result.raw!=="string" || !result.raw.trim())return;
  attempt.raw=result.raw;attempt.status="accepted";
  state.outcome={ok:true,raw:result.raw,originalText:attempt.text};
  state.delivered=true;state.repairReceiptPending=!sourceArchiveDurable(state);
  state.cleanupPending=!state.cleanupDone;
  delete state.formatError;delete state.repairError;
  workerStep(job,provider,"result_saved");
  compactFinalCapturedSource(state);
  await saveJobs(jobs); // Real server ACK + local receipt before the page is released.
  await notifyRepairReceipt(job,provider,jobs);
}
/** Independent control lane. Local inference runs server-side; no HTTP request
 * here waits for model completion. Identity/source are rechecked before commit.
 */
async function repairProvider(job, provider, jobs) {
  const state=job.states[provider];
  if(state.delivered) {await notifyRepairReceipt(job,provider,jobs);return;}
  // Capable servers escrow completed sources before formatting, so Local queue
  // latency or a disabled formatter cannot monopolize browser slots.
  if(job.captureProtocol===1 && (!sourceArchiveDurable(state) || capturePersistence.has(`${job.origin}:${job.jobId}:${provider}`)))return;
  // Local repair is off but the reply was captured non-JSON/invalid: deliver the durable source
  // verbatim so the server salvages it (raw_review) instead of leaving a genuinely unparseable
  // (not merely schema-invalid) reply pending forever. Repair, when enabled, still runs below.
  if(!job.localJsonRepairEnabled && !state.delivered &&
     (state.formatError || state.observation?.state==="response_completed_json_invalid")) {
    const salvage=await readRepairSource(job,provider);
    if(salvage?.text) {
      state.outcome={ok:true,raw:salvage.text,originalText:salvage.text,salvaged:true};
      delete state.formatError;
      workerStep(job,provider,"salvaged_no_repair");
      await saveJobs(jobs);
      await deliverOutcome(job,provider,jobs);
    }
    return;
  }
  let attempt=state.repairAttempt;
  if(attempt?.id) {
    const response=await api("/api/bridge",repairBody(job,provider,"repair-status",attempt),job.origin);
    const status=response.repair;
    if(status?.id!==attempt.id || status.sourceHash!==attempt.sourceHash || status.runId!==state.runId || status.responseId!==attempt.responseId)return;
    attempt.status=status.status;
    workerStep(job,provider,`repair_${status.status}`);
    await saveJobs(jobs);
    if(status.status==="accepted")return acceptRepairReceipt(job,provider,jobs,status);
    if (["running","ready"].includes(status.status)) {
      const current=job.localJsonRepairEnabled ? await readRepairSource(job,provider,false) : null;
      if (current && (current.sourceHash!==attempt.sourceHash || current.responseId!==attempt.responseId)) {
        // A later completed source is a new repair identity, not a replay of the
        // old inference. Starting it below fences/cancels the obsolete request.
        state.repairAttempt=undefined;
        attempt=undefined;
        await saveJobs(jobs);
      } else {
        if(status.status==="ready" && current) {
          if(state.delivered || (state.outcome?.ok && !state.formatError))return;
          const committed=await api("/api/bridge",repairBody(job,provider,"repair-commit",attempt),job.origin);
          return acceptRepairReceipt(job,provider,jobs,committed.repair);
        }
        return;
      }
    }
  }
  if(!job.localJsonRepairEnabled || state.delivered || (!state.formatError && state.observation?.state!=="response_completed_json_invalid"))return;
  const source=await readRepairSource(job,provider);
  if(!source || (attempt?.sourceHash===source.sourceHash && attempt.responseId===source.responseId && attempt.id))return;
  state.repairAttempt={sourceHash:source.sourceHash,responseId:source.responseId,
    ...(sourceArchiveDurable(state) ? {captureId:source.captureId} : {text:source.text}),status:"prepared"};
  attempt=state.repairAttempt;
  await saveJobs(jobs); // Save complete source/intent even when the start reply is lost.
  await flushProgress(job);
  if(!job.localJsonRepairEnabled || state.delivered)return;
  const response=await api("/api/bridge",{...repairBody(job,provider,"repair",attempt),source},job.origin);
  const status=response.repair;
  if(status?.id && status.sourceHash===attempt.sourceHash && status.responseId===attempt.responseId && status.runId===state.runId) {
    attempt.id=status.id;attempt.status=status.status;
    workerStep(job,provider,`repair_${status.status}`);
    await saveJobs(jobs);
    if(status.status==="accepted")await acceptRepairReceipt(job,provider,jobs,status);
  }
}

/** A stalled leg is settled only once its tab is gone (a live tab may still answer).
 * True only when neither the recorded tab nor any owned provider tab is still live. */
async function providerTabGone(job, provider) {
  const state = job.states[provider];
  if (!state.tabId && !state.started) return true;
  if (state.tabId) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (allowedTab(tab, provider)) return false;
    } catch { /* recorded tab is gone; fall through to a full owned-tab search */ }
  }
  return !(await findOriginalTab(job, provider));
}

/** The bridge job registry is in-memory only, so a job the server used to own that now
 * reports missing/unknown (typically after a restart) is gone for good — its legs can
 * never be delivered again and must be retired, or they pile up in recovery/cleanup and
 * starve admission. Every leg of a cancelled or forgotten job is abandoned: its tab has no
 * further use and is released by the page's verdict (closed unless the user took it over,
 * preserved when that cannot be proven in time). Returns true when the whole job was retired. */
async function abandonForgottenJob(job, jobs, status, signal) {
  // status is the FRESH probe verdict from the clear sweep.
  if (signal?.aborted) return false;
  abandonLegs(job, job.providers, status);
  // A confirmed-absent tab finishes cleanup instead of waiting for a reconnection that never comes.
  for (const provider of job.providers) job.states[provider].closeRequested = true;
  await saveJobs(jobs);
  await joinLanes(job.providers.map(provider => cleanupProvider(job, provider, jobs)));
  // Detach the final trace only for a freshly-confirmed missing/unknown job (server evicted it → upload
  // rejected and the fetch may hang); a cancelled job keeps its lease, so its trace is awaited.
  return retireCleanJob(job, jobs, ["missing", "unknown"].includes(status), signal);
}

// Canonicalize an invalid/unparseable model response into a VALID raw_review review JSON — the exact
// envelope the server's salvageReviewJson (src/lib/extract-chat-json.ts) produces. A durable leg whose
// repair terminally failed must be delivered with repairProtocol:1 (repair is enabled), and the bridge
// route re-validates that raw as review JSON — sending the original invalid text would 422 forever. Wrap
// it here so completeBridgeJob (which does NOT salvage when repair is available) stores a valid review.
// Keep this in sync with the server's salvageReviewJson.
function salvageReviewEnvelope(text) {
  const s = String(text || "").trim();
  const severities = [...new Set(s.match(/\bP[0-2]\b/g) ?? [])].sort();
  const header = severities.length ? `Detected severity markers: ${severities.join(", ")}.\n\n` : "";
  return JSON.stringify({ findings: [], merge_recommendation: "COMMENT", raw_review: (header + s).slice(0, 60_000) });
}

// A job counts as "stalled" once it made progress (has a worker/page event) but has gone quiet past
// STALL_MS. Keying off an OLD event — never the ABSENCE of events — means a brand-new or still-allocating
// job (no events yet) is never flagged, so periodic cleanup can't race admission. Generous window: a
// live ChatGPT generation can legitimately run several minutes, and the tab-gone gate below is the real
// safety (a stall with a live tab is always kept). Tunable.
const STALL_MS = 15 * 60_000;
function jobStale(job, staleMs, now = Date.now()) {
  let latest = 0;
  for (const provider of job.providers) {
    const state = job.states[provider] || {};
    for (const event of [...(state.workerEvents || []), ...(state.pageEvents || [])]) if (event.at > latest) latest = event.at;
  }
  return latest > 0 && now - latest > staleMs;
}

/** Sweep for jobs the server has forgotten (missing/unknown) or cancelled — their tabs are released by
 * the page's verdict (closed unless the user took them over) — and, when includeStalled, tab-gone jobs
 * that progressed then went quiet past staleMs (a wedged generating/repair leg that can never finish).
 * Runs both from the popup button and the periodic alarm. Never touches a job the server still
 * owns/tracks, nor a stalled job whose tab is still live (a harvestable answer). The
 * ENTIRE operation — storage init, the concurrent re-probe, and the abandon sweep — is raced against one
 * deadline, so a stalled chrome.storage.get, bridge ping, or tab probe can never strand the popup's
 * runtime message. Returns how many were cleared. */
async function clearStuckJobs(opts = {}) {
  // Deadline-bounded wrapper for the popup button: race the sweep WORK against a timer so a stalled
  // chrome.storage.get, bridge ping, or tab probe can never strand the runtime message. The counter is
  // shared with the still-running work so a timeout still reports partial progress. Never throws.
  const { deadlineMs = 15_000, includeStalled = false, staleMs = STALL_MS } = opts;
  const TIMED_OUT = Symbol("clear-timeout");
  const controller = new AbortController();
  let timer;
  const counter = { cleared: 0, total: 0 };
  // On timeout, ABORT the work — don't just return. Otherwise the detached runStuckSweep keeps running
  // unfenced and the "click again" the popup suggests starts another sweep over the same registry, so
  // repeated attempts accumulate pending ops that later resume concurrently. Aborting fences it (its
  // fetches reject, its per-mutation signal checks bail), so a re-click never overlaps the timed-out sweep.
  const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(TIMED_OUT); }, deadlineMs); });
  const work = runStuckSweep({ includeStalled, staleMs, signal: controller.signal }, counter)
    .catch(error => ({ ok: false, error: String(error?.message || error || "clear failed") }));
  const result = await Promise.race([work, deadline]);
  clearTimeout(timer);
  const kept = Math.max(0, counter.total - counter.cleared);
  if (result === TIMED_OUT) return { ok: true, cleared: counter.cleared, kept, timedOut: true };
  if (result.ok === false) return result;
  return { ok: true, cleared: counter.cleared, kept, timedOut: false };
}

/** The actual sweep (NO response deadline). Retires jobs the server has forgotten (missing/unknown) or
 * cancelled, and — when includeStalled — tab-gone jobs that progressed then went quiet past staleMs
 * (a stalled job with a live tab may still answer and is kept). `counter` is mutated
 * live so the deadline wrapper can report partial progress on timeout. Resolves only when the work truly
 * ends, so the auto-sweep can hold its lock until then. */
async function runStuckSweep({ includeStalled = false, staleMs = STALL_MS, signal } = {}, counter = { cleared: 0, total: 0 }) {
  const cfg = await settings();
  if (!cfg.enabled || !cfg.origin || !cfg.token) return { ok: false, error: "set the Ashlar origin and token first" };
  const jobs = await workerJobs(cfg.origin);
  const mine = Object.values(jobs).filter(job => job.origin === cfg.origin);
  counter.total = mine.length;
  const isForgotten = job => ["cancelled", "missing", "unknown"].includes(job.serverStatus);
  const candidates = mine.filter(job => isForgotten(job) || (includeStalled && jobStale(job, staleMs)));
  await Promise.allSettled(candidates.map(async job => {
    // Generation fence: if the watchdog aborted this sweep (a chrome.storage/tabs op outlived it), a newer
    // sweep now owns the registry. Bail before every post-await mutation so the abandoned sweep can never
    // resume and mutate/re-send concurrently. signal is per-sweep, so a fresh (or manual, undefined) sweep
    // never trips this.
    if (signal?.aborted) return;
    if (isForgotten(job)) {
      // Abandon only on a FRESH, reachable confirmation the job is STILL forgotten. heartbeat reports
      // active:false for ANY non-active status (validator/posting/…) and stores it in job.serverStatus —
      // the server still tracks those, so re-check the status STRING, not the boolean. A restored job
      // clears serverStatus; an unreachable probe (threw) leaves the stale status. Keep those. The server
      // has already evicted a forgotten job, so abandonForgottenJob's force-local retire is safe.
      // heartbeat de-dupes via heartbeatLanes, so if heartbeatTick already started this job's ping the
      // sweep receives that in-flight promise whose fetch never got this signal — the watchdog can't
      // abort it. Race the (possibly shared, unabortable) probe against the signal: on abort, bail on this
      // job (keep it) rather than hang, and let the shared heartbeat finish under the tick's ownership.
      const probed = await Promise.race([
        heartbeat(job, jobs, signal).then(() => true, () => false),
        new Promise((resolve) => { signal?.addEventListener("abort", () => resolve(false), { once: true }); }),
      ]);
      if (!probed) return;
      const status = job.serverStatus;
      if (!["cancelled", "missing", "unknown"].includes(status)) return;
      if (signal?.aborted) return;
      if (await abandonForgottenJob(job, jobs, status, signal) === true) counter.cleared += 1;
    } else {
      // Stalled + tab-gone: the chat tab is gone, so the leg can never produce a result — but the server
      // may STILL own the job (awaiting_chat). A bare local delete would leave the server's leg pending
      // (refreshBridgeClaim ignores generating:false), so after the lease expires it re-offers the job and
      // it re-sticks. REPORT a terminal failure instead (deliverOutcome sends action:"failure"), which
      // settles the server leg; the record is retired only once every leg is delivered (ACKed), and
      // retained if the server is unreachable. A live-tab provider is left alone (may still answer).
      for (const provider of job.providers) {
        const state = job.states[provider];
        // Fully done — the server ACKed AND tab cleanup finished. Nothing to do.
        if (state.delivered && state.cleanupDone) continue;
        // A durably-archived source is owned by the repair pipeline ONLY while a repair is actively
        // running or committable (prepared/running/ready): its tab was closed ON PURPOSE and repair may
        // run arbitrarily long without events, so settling would cancel a live repair. But a repair in a
        // terminal non-accepted state (needs_attention/interrupted/disabled/superseded), or a durable leg
        // with no active repair, is dead — repairProvider won't retry or settle it, so the job would sit
        // forever. Salvage the archived original instead (deliver it verbatim as raw_review, the same
        // terminal path as repair-off); a fabricated tab_closed failure would be dropped by deliverOutcome's
        // durable guard anyway.
        if (sourceArchiveDurable(state)) {
          // accepted is a resumable SUCCESS (the commit landed; acceptRepairReceipt records the receipt on
          // the next tick even if the worker stopped before it did). Salvaging it would collide with the
          // server's already-stored repaired leg (lease_conflict) and clear the lease. Exempt it too.
          if (["prepared", "running", "ready", "accepted"].includes(state.repairAttempt?.status)) continue;
          if (!state.outcome) {
            const salvage = await readRepairSource(job, provider, false); // local archived copy — no fetch, no hang
            if (salvage?.text) {
              // Repair is enabled here (the leg had a repair attempt), so the server would re-demand
              // repair on the raw text. Deliver the canonicalized raw_review envelope instead.
              state.outcome = { ok: true, raw: salvageReviewEnvelope(salvage.text), originalText: salvage.text, salvaged: true };
              delete state.formatError;
              workerStep(job, provider, "salvaged_no_repair");
            }
          }
          continue; // salvaged (delivered in the post-loop) or nothing local to salvage — never fabricate a failure
        }
        // A leg that never started and never owned a tab is a sibling still WAITING for capacity, not a
        // stalled one — providerTabGone reports it "gone", but touching it would misreport a reviewer that
        // never ran. Only act on a leg that actually started or held a tab that is now gone. (Job-level
        // staleness can trip on a different leg's old events, so the per-leg guard is essential.)
        if (!state.started && !state.tabId) continue;
        if (!(await providerTabGone(job, provider))) continue;
        if (state.delivered) {
          // Result already ACKed, but cleanup stalled: the tab closed before closeRequested was persisted,
          // so cleanupProviderBody loops on "original tab unavailable" and retireCleanJob never releases
          // the job — it keeps consuming tab capacity. Confirm tab absence so cleanup can finish; the
          // outcome is already delivered, so leave it untouched (never re-report it as a failure).
          state.closeRequested = true;
        } else if (state.outcome && !state.formatError) {
          // A NORMAL saved outcome (a valid response, or an explicit failure) is handled by the delivery
          // flow — never fabricate a tab_closed over a valid saved review.
          continue;
        } else {
          // No outcome, or a formatError outcome (server returned 422 json_repair_required) whose source
          // never became durable and whose tab is now gone — it can NEVER be repaired or delivered
          // (readRepairSource has no tab, delivery loops on 422), so a sole-provider job would sit
          // awaiting_chat forever. Settle it with a terminal failure.
          state.outcome = failure("tab_closed", "review tab closed before a result (stalled)");
          delete state.formatError;
          state.closeRequested = true;
        }
      }
      if (signal?.aborted) return; // a slow providerTabGone/storage read may have outlived the watchdog
      await saveJobs(jobs);
      if (signal?.aborted) return;
      // Deliver a newly-stamped failure (deliverOutcome sends it + cleans up on ACK); for an
      // already-delivered leg whose closeRequested we just set, deliverOutcome early-returns, so finish its
      // cleanup with a direct call. Both are idempotent and no-op a leg we deliberately left alone.
      await joinLanes(job.providers.map(async provider =>
        (job.states[provider].delivered
          ? cleanupProvider(job, provider, jobs)
          : deliverOutcome(job, provider, jobs, signal)).catch(() => {})));
      if (signal?.aborted) return;
      if (await retireCleanJob(job, jobs, false, signal) === true) counter.cleared += 1;
    }
  }));
  // Best-effort status refresh, detached: recordWorkerStatus runs FRESH unbounded tab/storage ops, so
  // awaiting it could strand the wrapper's response. Fire-and-forget, but SINGLE-FLIGHTED: if a prior
  // refresh is still pending (stalled in an unbounded tab/storage op), the per-minute alarm must not stack
  // another — singleFlight hands back the in-flight promise so at most one is ever outstanding.
  void singleFlight(statusLanes, cfg.origin, () => recordWorkerStatus(jobs, cfg.origin)).catch(() => {});
  return { ok: true };
}

// Periodic hygiene, driven by the "ashlar-poll" alarm (which reliably wakes even a suspended worker, so
// the pile-up is cleared without depending on the popup message path). The lock is held until the sweep
// truly ends, so the next alarm can never start an overlapping sweep over the same registry. A watchdog
// ABORTS the in-flight bridge fetch if the sweep runs long: runStuckSweep's awaited fetches reject on the
// signal, so the sweep unwinds and settles — releasing the lock only once the cancellation lands (never
// leaving it wedged for the worker's lifetime, and never overlapping the next run). No popup waits on it.
const AUTO_SWEEP_WATCHDOG_MS = 45_000;
let autoSweepInFlight = false;
async function autoSweepStuckJobs(watchdogMs = AUTO_SWEEP_WATCHDOG_MS) {
  if (autoSweepInFlight) return;
  autoSweepInFlight = true;
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), watchdogMs);
  try {
    // Race the WHOLE sweep against the watchdog's abort so the lock always releases — even when the hang
    // is in a chrome.storage/tabs op that no signal can cancel (settings()/workerJobs() run before any
    // fetch). On abort the sweep is abandoned, but its signal-aware bridge fetches all reject, so the
    // detached remainder can no longer mutate the registry: no overlap with the next sweep, no wedge for
    // the worker's lifetime.
    await Promise.race([
      runStuckSweep({ includeStalled: true, signal: controller.signal }).catch(() => {}),
      new Promise((resolve) => { controller.signal.addEventListener("abort", () => resolve(), { once: true }); }),
    ]);
  } finally { clearTimeout(watchdog); autoSweepInFlight = false; }
}

async function advanceJob(job, jobs) {
  // Cleanup is independent of server availability once acknowledgement was persisted.
  await joinLanes(job.providers.map(p => cleanupProvider(job, p, jobs)));
  if (await retireCleanJob(job, jobs)) return;
  const active = await heartbeat(job, jobs);
  if (!active && job.serverStatus === "cancelled") {
    // Explicit cancellation, never elapsed time or 404. Persisted before cleanup: a later
    // "missing" (the harbor forgot the cancelled job) still takes the cancel exit.
    abandonLegs(job, job.providers, "cancelled");
    await saveJobs(jobs);
    await joinLanes(job.providers.map(p => cleanupProvider(job, p, jobs)));
    await retireCleanJob(job, jobs); // default (await): cancelled keeps its lease, so its trace still uploads
    return;
  }
  // A "missing"/"unknown" status is deliberately NOT auto-retired here: after a worker restart the
  // tab can re-bind, so such work must not be discarded on one stale reply. The sweep
  // (clearStuckJobs, also run by the periodic alarm) re-probes it and, still forgotten, abandons
  // every leg and releases its tab by the page's verdict.
  const canDeliver = active || ["validator", "posting", "posted", "skipped", "dlq"].includes(job.serverStatus);
  // Missing is not ACK: observe and preserve the original response without redelivery.
  if (active && !job.prompt && job.providers.some(p=>!job.states[p].delivered && !sourceArchiveDurable(job.states[p]))) {
    const current = await api(`/api/bridge?jobId=${encodeURIComponent(job.jobId)}&attachmentProtocol=2`, undefined, job.origin);
    Object.assign(job, {prompt: current.prompt, prompts: current.prompts});
    await saveJobs(jobs);
  }
  await joinLanes(job.providers.map(async provider => {
    try {
      await pollProvider(job, provider, jobs, !active);
      if (canDeliver) await deliverOutcome(job, provider, jobs);
      // Capture, JSON repair and the observation archive are review-JSON machinery. A fix answer
      // is plain text delivered by complete, so none of those lanes run for a fix item.
      if (job.kind !== "fix" && job.captureProtocol===1 && !captureLanes.has(`${job.origin}:${job.jobId}:${provider}`)) {
        void singleFlight(captureLanes,`${job.origin}:${job.jobId}:${provider}`,()=>captureProvider(job,provider,jobs)).catch(()=>{
          job.states[provider].captureError="Full source archive or receipt pending; tab and original preserved";
        });
      }
      if (job.kind !== "fix" && (canDeliver || job.states[provider].repairAttempt?.id)) {
        void singleFlight(repairLanes, `${job.origin}:${job.jobId}:${provider}`,
          () => repairProvider(job, provider, jobs)).catch(() => {
            // The repair lane owns no model-generation deadline and never marks
            // the provider failed. Its original/intention stay in durable storage.
            job.states[provider].repairError = "Local JSON repair transport/archive pending; original retained";
          });
      }
      if (active && job.kind !== "fix") {
        // Diagnostic persistence is independently retryable. A slow observe/progress
        // RPC must not hold the lane that will harvest the now-completed response.
        void singleFlight(observationLanes, `${job.origin}:${job.jobId}:${provider}`,
          () => archiveObservation(job, provider, jobs)).catch(() => {
            // Do not label a diagnostic transport failure as a model failure.
            job.states[provider].observationError = "Diagnostic archive pending; original remains in local storage";
          });
      }
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

/** Capacity may block new tabs, never recovery of proven existing ones. */
async function recoverOwnedJob(cfg,jobs) {
  const health=(await chrome.storage.local.get([HEALTH_KEY]))[HEALTH_KEY];
  if(health?.origin!==cfg.origin || health.recoveryProtocol!==1)return null;
  const tabs=await chrome.tabs.query({});
  const candidates=tabs.flatMap(tab=>{
    const owner=knownTabOwner(tab);
    if(!owner?.jobId || !owner.runId || owner.released)return [];
    const existing=jobs[owner.jobId];
    // Inventory is asynchronous: one provider can be recovered before its sibling
    // tab is positively identified. Job existence therefore cannot suppress a
    // newly discovered provider binding for that same original run.
    if(existing?.states?.[owner.provider])return [];
    return [{jobId:owner.jobId,provider:owner.provider,runId:owner.runId,tabId:tab.id}];
  }).slice(0,16);
  if(!candidates.length)return null;
  const result=await api("/api/bridge",{action:"recover",clientId:await clientId(),attachmentProtocol:2,
    bindings:candidates.map(({jobId,provider,runId})=>({jobId,provider,runId}))},cfg.origin);
  const incoming=result.job;
  if(!incoming || !Array.isArray(incoming.bindings) || !incoming.bindings.length)return null;
  const bindings=incoming.bindings.filter(binding=>binding.jobId===incoming.jobId &&
    candidates.some(item=>item.jobId===binding.jobId && item.provider===binding.provider && item.runId===binding.runId));
  if(bindings.length!==incoming.bindings.length)return null;
  const providers=[...new Set(bindings.map(item=>item.provider))];
  const existing=jobs[incoming.jobId];
  if(existing && existing.origin!==cfg.origin)return null;
  const job=existing || {...incoming,origin:cfg.origin,providers:[],resumeProviders:[],states:{}};
  // recoverBridgeJob renews the server lease. Existing recovered providers must
  // use the renewed lease too, otherwise the sibling merge can strand both legs.
  job.leaseId=incoming.leaseId;
  job.providers=[...new Set([...(job.providers || []),...providers])];
  job.resumeProviders=[...new Set([...(job.resumeProviders || []),...providers])];
  if(!job.prompt && incoming.prompt)job.prompt=incoming.prompt;
  if(!job.prompts && incoming.prompts)job.prompts=incoming.prompts;
  if(!job.reasoning && incoming.reasoning)job.reasoning=incoming.reasoning;
  for(const binding of bindings) {
    if(job.states[binding.provider])continue;
    const candidate=candidates.find(item=>item.jobId===binding.jobId && item.provider===binding.provider && item.runId===binding.runId);
    // The durable started marker forbids allocate/re-send even if this tab moves.
    job.states[binding.provider]={runId:binding.runId,tabId:candidate.tabId,started:true};
  }
  jobs[job.jobId]=job;
  await saveJobs(jobs);
  await recordWorkerStatus(jobs,cfg.origin,"recovered");
  return job;
}

function admitJob(cfg, jobs) {
  return singleFlight(admissionLanes, cfg.origin, async () => {
    if (await maintenanceHeld()) {
      await recordWorkerStatus(jobs, cfg.origin, "maintenance");
      return null;
    }
    const recovered=await recoverOwnedJob(cfg,jobs);
    if(recovered)return recovered;
    if (!await tabCapacityAvailable(jobs, true)) {
      await recordWorkerStatus(jobs, cfg.origin, "tab_capacity"); return null;
    }
    const quota = await quotaMap();
    if (!["chatgpt", "grok"].some(p => providerOpen(quota, p))) {
      await recordWorkerStatus(jobs, cfg.origin, "provider_quota"); return null;
    }
    await recordWorkerStatus(jobs, cfg.origin, "polling");
    // One take in flight per origin: this lane (singleFlight on admissionLanes, and tickBody never
    // queues a second waiter) serializes every admission trigger of this worker (alarm, interval,
    // poll-now). A fix delivery this profile PROVABLY opened a tab for (reconcileFixDeliveries: a
    // live created tab or a binding) is listed too, so the server never replays it here even when the
    // job registry lost it (hard reset); an intent that never became a tab is cleared and replayed.
    const delivered = await reconcileFixDeliveries(jobs);
    // fixProtocol:1 opts this worker into review-loop fix items (an older worker is never offered one).
    const payload = await api("/api/bridge", {
      action: "take", attachmentProtocol: 2, fixProtocol: 1, clientId: await clientId(),
      excludeJobIds: [...new Set([...Object.keys(jobs), ...Object.keys(delivered)])],
    }, cfg.origin).catch(async error => {
      await recordWorkerStatus(jobs, cfg.origin, "disconnected"); throw error;
    });
    if (!payload.job || jobs[payload.job.jobId]) {
      await recordWorkerStatus(jobs, cfg.origin, payload.job ? "duplicate_job" : "idle");
      return null;
    }
    // At most one tab per fix jobId + deliveryId: a delivery (fresh, or its replay) whose tab this
    // profile already opened is never submitted again. A resume opens no tab.
    const offered = payload.job;
    if (offered.kind === "fix" && !offered.resumeProviders?.length && offered.deliveryId &&
        delivered[offered.jobId]?.deliveryId === offered.deliveryId) {
      await recordWorkerStatus(jobs, cfg.origin, "duplicate_job");
      return null;
    }
    const job = {...payload.job, origin: cfg.origin, states: {}};
    job.providers = [...new Set(job.providers?.length ? job.providers : [job.provider])]
      .filter(p => ["chatgpt", "grok"].includes(p));
    if (!job.providers.length) throw new Error("bridge returned no supported review providers");
    for (const p of job.providers) job.states[p] = {};
    jobs[job.jobId] = job;
    await saveJobs(jobs); // Provider intents reserve admission space before this lock opens.
    await chrome.storage.local.set({lastJobId: job.jobId, lastError: ""});
    await recordWorkerStatus(jobs, cfg.origin, "admitted");
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
  void refreshTabInventory().catch(()=>{});
  await recordWorkerStatus(jobs, cfg.origin);
  // There is deliberately NO global work lock or "any active job" return. A later
  // wakeup can advance B/admit C even while A's short transport attempt is pending.
  const work = Object.values(jobs).filter(job=>job.origin===cfg.origin).flatMap(job=>job.providers
    .filter(provider=>(job.states[provider].delivered || sourceArchiveDurable(job.states[provider])) && !job.states[provider].cleanupDone &&
      !cleanupLanes.has(`${job.origin}:${job.jobId}:${provider}`))
    .map(provider=>cleanupProvider(job,provider,jobs)));
  work.push(...Object.values(jobs)
    .filter(j => j.origin === cfg.origin && !jobLanes.has(`${j.origin}:${j.jobId}`))
    .map(job => progressJob(job, jobs)));
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

async function maintenanceSnapshot(id) {
  const cfg=await settings();
  const jobs=cfg.origin ? await workerJobs(cfg.origin) : {};
  await Promise.allSettled([...admissionLanes.values(), allocationTail]);
  const current=await maintenanceState();
  if(!current || current.id!==id)return {ok:false,error:"maintenance lock lost"};
  const capacity=await tabCapacityReport(jobs,true);
  const pendingCleanup=Object.values(jobs).filter(job=>!cfg.origin || job.origin===cfg.origin)
    .reduce((n,job)=>n+job.providers.filter(p=>(job.states[p].delivered || sourceArchiveDurable(job.states[p])) && !job.states[p].cleanupDone).length,0);
  if(cfg.origin)await recordWorkerStatus(jobs,cfg.origin,"maintenance");
  const safe=capacity.used===0 && pendingCleanup===0;
  return {ok:true,safe,capacity,pendingCleanup,reason:safe?"safe to reload":
    capacity.used>0?`managed review capacity is ${capacity.used}/${capacity.limit}`:`${pendingCleanup} cleanup operation(s) still pending`};
}
async function acquireMaintenance(id,mode) {
  if(typeof id!=="string" || !id || !["update","rollback","reload"].includes(mode))return {ok:false,error:"invalid maintenance request"};
  const acquired=await maintenanceInOrder(async()=>{
    const existing=await maintenanceState();
    if(existing && existing.id!==id)return {ok:false,error:"another extension maintenance operation is active"};
    if(!existing)await chrome.storage.local.set({[MAINTENANCE_KEY]:{active:true,id,mode,phase:"locked",requestedAt:Date.now()}});
    return {ok:true};
  });
  if(!acquired.ok)return acquired;
  return maintenanceSnapshot(id);
}
async function releaseMaintenance(id) {
  return maintenanceInOrder(async()=>{
    const current=await maintenanceState();
    if(current?.id===id)await chrome.storage.local.remove([MAINTENANCE_KEY]);
    return {ok:true};
  });
}
async function commitMaintenanceReload(id) {
  const current=await maintenanceState();
  if(!current || current.id!==id)return {ok:false,error:"maintenance lock lost"};
  const snapshot=await maintenanceSnapshot(id);
  if(!snapshot.safe)return snapshot;
  const committed=await maintenanceInOrder(async()=>{
    const latest=await maintenanceState();
    if(!latest || latest.id!==id)return {ok:false,error:"maintenance lock lost"};
    await chrome.storage.local.set({[MAINTENANCE_KEY]:{...latest,phase:"reload_ready",committedAt:Date.now()}});
    return {ok:true};
  });
  if(!committed.ok)return committed;
  return {...snapshot,committed:true};
}
async function clearCommittedMaintenanceOnWorkerStart() {
  await maintenanceInOrder(async()=>{
    const current=await maintenanceState();
    if(current?.phase==="reload_ready")await chrome.storage.local.remove([MAINTENANCE_KEY]);
  });
}

function loop() {
  chrome.alarms.create("ashlar-poll", { periodInMinutes: 1 });
  void heartbeatTick();
  void tick();
  void autoSweepStuckJobs();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ashlar-poll") { void heartbeatTick(); void tick(); void autoSweepStuckJobs(); }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ashlar-poll-now") {
    void probeBridge(); void heartbeatTick(); void tick();
    sendResponse({ok:true,scheduled:true}); return;
  }
  if (message?.type === "ashlar-clear-stuck") {
    // The button clears the same set the periodic sweep does, including stalled tab-gone jobs.
    clearStuckJobs({ includeStalled: true }).then(sendResponse, error => sendResponse({ok: false, error: String(error?.message || error)}));
    return true;
  }
  if (message?.type === "ashlar-hard-reset") {
    // Last-resort escape hatch for leftover jobs that clearStuckJobs cannot retire (the server never gives a
    // fresh "forgotten" confirmation because the origin changed or is gone) and that survive a bare storage
    // edit (the live worker keeps this in-memory registry and re-persists it on the next tick). Drop the
    // cached registry AND persist an empty one so any tick that races the reload writes {} rather than the
    // stale 30, then reload the extension so all in-flight lane closures holding the old jobs object are torn
    // down. Never throws: reload runs after the reply regardless.
    (async () => {
      try {
        registryPromise = Promise.resolve({});
        await writeInOrder(() => chrome.storage.local.set({ [PENDING_JOBS]: {} }));
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      } finally {
        setTimeout(() => chrome.runtime.reload(), 150);
      }
    })();
    return true;
  }
  if (message?.type === "ashlar-maintenance-acquire") {
    void acquireMaintenance(message.id,message.mode).then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message||error)})); return true;
  }
  if (message?.type === "ashlar-maintenance-release") {
    void releaseMaintenance(message.id).then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message||error)})); return true;
  }
  if (message?.type === "ashlar-maintenance-commit") {
    void commitMaintenanceReload(message.id).then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message||error)})); return true;
  }
});
chrome.tabs.onUpdated?.addListener((id, change) => {
  if(change.url || change.status)invalidateTabInventory(id);
});
chrome.tabs.onRemoved.addListener((id, info) => void rememberClosedTab(id, info));
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
void clearCommittedMaintenanceOnWorkerStart();
loop();
setInterval(() => void tick(), POLL_MS);

setInterval(() => void heartbeatTick(), HEARTBEAT_MS);
