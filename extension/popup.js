const originEl = document.getElementById("origin");
const tokenEl = document.getElementById("token");
const maxTabsEl = document.getElementById("maxReviewTabs");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const workerEl = document.getElementById("worker");
const updateStatusEl = document.getElementById("updateStatus");
const checkUpdateEl = document.getElementById("checkUpdate");
const applyUpdateEl = document.getElementById("applyUpdate");
const rollbackUpdateEl = document.getElementById("rollbackUpdate");
const EXTENSION_UPDATER_ORIGIN = "http://127.0.0.1:17373";
let updaterSnapshot = null;

document.getElementById("version").textContent = chrome.runtime.getManifest().version;

async function refreshDiagnostics() {
  const s = await chrome.storage.local.get(["origin", "enabled", "bridgeHealth", "bridgeWorkerStatus"]);
  const health = s.bridgeHealth?.origin === s.origin ? s.bridgeHealth : null;
  const work = s.bridgeWorkerStatus?.origin === s.origin ? s.bridgeWorkerStatus : null;
  if (s.enabled === false) {
    connectionEl.textContent = "Worker disabled. Existing tabs and replies are preserved.";
  } else if (!health) {
    connectionEl.textContent = "Connection not checked by this worker yet.";
  } else {
    const time = new Date(health.checkedAt).toLocaleTimeString();
    connectionEl.textContent = health.ok
      ? `Server responded at ${time}. Pending chat jobs: ${health.pendingJobs ?? "unknown (older server)"}. Server instance: ${health.serverInstanceId ?? "not reported"}.`
      : `Connection check failed at ${time}${health.httpStatus ? ` (HTTP ${health.httpStatus})` : ""}: ${health.error || "unknown error"}`;
  }
  if (!work) {
    workerEl.textContent = "No job polling report yet. A successful ping alone does not mean a job was claimed.";
    return;
  }
  const phases = {
    reviewing: "Current review in progress", recovering: "Recovering old work; polling for new requests",
    disconnected: "Server unavailable; preserving pending work",
    idle: "No new job assigned", tab_capacity: "New tabs paused: review-tab capacity reached",
    provider_quota: "New work paused: provider quota",
  };
  const admissionPhases = {
    not_checked: "Not checked by this worker yet", polling: "Checking for a new request",
    admitted: "New review assigned", recovered: "Original bound review recovered without a new tab", idle: "No new job assigned at the last poll",
    tab_capacity: "New tabs paused: review-tab capacity reached",
    provider_quota: "New work paused: provider quota",
    disconnected: "Server unavailable; preserving pending work",
    duplicate_job: "Server repeated an existing job; original work preserved",
  };
  const admission = work.admissionPhase
    ? `\nNew requests: ${admissionPhases[work.admissionPhase] || work.admissionPhase}` +
      (work.admissionCheckedAt ? ` (checked ${new Date(work.admissionCheckedAt).toLocaleTimeString()})` : "")
    : ""; // Keep reports from older workers readable during an upgrade.
  const capacity = work.capacity;
  const slots = capacity ? `
Managed capacity: ${capacity.used}/${capacity.limit}; managed tabs: ${capacity.managedTabs}; reserved: ${capacity.reserved}; uncertain slots: ${capacity.unknownReserved ?? capacity.restorationReserved}; restoration candidates: ${capacity.restorationReserved}; orphan bindings: ${capacity.orphanTabs || 0}.
Provider-domain tabs: ${capacity.providerTabs} (not the gate count); unverified: ${capacity.unverifiedTabs}.
Archived sources awaiting processing: ${work.sourceCaptured || 0}.` : "\nCapacity counts not reported by this worker version.";
  const blockers = (capacity?.blockers || []).map(item=>`${item.jobId} / ${item.provider}: ${item.reason}`).join("\n");
  const stages=(work.stages||[]).map(s=>`${s.jobId} / ${s.provider}: ${s.stage}`).join("\n");
  const recovery = (work.recovery || []).map(j => `${j.jobId}: ${j.status}`).join("\n");
  workerEl.textContent = `${phases[work.phase] || work.phase}${admission}\nActive: ${work.activeJobs}; recovery: ${work.recoveringJobs}; cleanup: ${work.pendingCleanup}; saved replies: ${work.savedReplies}; JSON pending: ${work.waitingForJson || 0}` +
    slots + (blockers ? `\nSlot reasons:\n${blockers}` : "") +
    (stages ? `\n${stages}` : "") + (recovery ? `\n${recovery}` : "") + (work.checkedAt ? `\nLast poll: ${new Date(work.checkedAt).toLocaleTimeString()}` : "");
}

(async () => {
  const s = await chrome.storage.local.get(["origin", "token", "enabled", "lastJobId", "lastError", "maxReviewTabs"]);
  originEl.value = s.origin || "";
  tokenEl.value = s.token || "";
  enabledEl.checked = s.enabled !== false;
  maxTabsEl.value = Number.isInteger(s.maxReviewTabs) && s.maxReviewTabs > 0 ? Math.min(s.maxReviewTabs,16) : 4;
  if (s.lastError) statusEl.textContent = `Previous work error (not a model completion status): ${s.lastError}`;
  else if (s.lastJobId) statusEl.textContent = `Last job: ${s.lastJobId}`;
  await refreshDiagnostics();
  await refreshExtensionUpdate();
})();


function reloadSafety(work) {
  const used = Number(work?.capacity?.used);
  if (!Number.isFinite(used)) return {safe:false, reason:"Managed-capacity status is unavailable; poll once before reloading."};
  if (used > 0) return {safe:false, reason:`Wait for managed review capacity to reach 0 (currently ${used}/${work.capacity.limit}).`};
  if (Number(work?.pendingCleanup || 0) > 0) return {safe:false, reason:`Wait for ${work.pendingCleanup} cleanup operation(s) to finish.`};
  return {safe:true, reason:"No managed review tab or cleanup operation is active."};
}

async function updaterRequest(path, options = {}) {
  const response = await fetch(EXTENSION_UPDATER_ORIGIN + path, {
    cache:"no-store",
    ...options,
    headers:{"content-type":"application/json", ...(options.headers || {})},
  });
  const body = await response.json().catch(()=>({}));
  if (!response.ok || body.ok !== true) throw new Error(body.error || `updater HTTP ${response.status}`);
  return body;
}

async function refreshExtensionUpdate() {
  if (!updateStatusEl) return;
  applyUpdateEl.disabled = true;
  rollbackUpdateEl.disabled = true;
  try {
    const [snapshot, stored] = await Promise.all([
      updaterRequest("/status"),
      chrome.storage.local.get(["origin", "bridgeWorkerStatus"]),
    ]);
    updaterSnapshot = snapshot;
    const work = stored.bridgeWorkerStatus?.origin === stored.origin ? stored.bridgeWorkerStatus : null;
    const safety = reloadSafety(work);
    const running = chrome.runtime.getManifest().version;
    const disk = snapshot.installedVersion || "not installed";
    const reloadRequired = snapshot.installedVersion && snapshot.installedVersion !== running;
    const available = snapshot.availableVersion || "unknown";
    let line = `Running ${running}; files ${disk}; origin/main ${available}.`;
    if (reloadRequired) line += " Files are newer than the running extension; reload is required.";
    else if (snapshot.updateAvailable) line += " Update available.";
    else line += " Up to date.";
    if (!safety.safe) line += ` ${safety.reason}`;
    updateStatusEl.textContent = line;
    applyUpdateEl.textContent = reloadRequired ? "Reload updated files" : "Update & Reload";
    applyUpdateEl.disabled = !safety.safe || !(reloadRequired || snapshot.updateAvailable);
    rollbackUpdateEl.disabled = !safety.safe || !snapshot.backupAvailable;
  } catch (error) {
    updaterSnapshot = null;
    updateStatusEl.textContent = `Local updater unavailable: ${error instanceof Error ? error.message : String(error)}. Run npm run extension:update-helper on this machine.`;
  }
}

async function applyExtensionUpdate() {
  if (!updaterSnapshot) return refreshExtensionUpdate();
  const stored = await chrome.storage.local.get(["origin", "bridgeWorkerStatus"]);
  const safety = reloadSafety(stored.bridgeWorkerStatus?.origin === stored.origin ? stored.bridgeWorkerStatus : null);
  if (!safety.safe) { updateStatusEl.textContent = safety.reason; return; }
  const running = chrome.runtime.getManifest().version;
  try {
    if (updaterSnapshot.installedVersion === running && updaterSnapshot.updateAvailable) {
      const result = await updaterRequest("/update", {
        method:"POST",
        body:JSON.stringify({expectedCommit:updaterSnapshot.availableCommit}),
      });
      await chrome.storage.local.set({lastExtensionUpdate:{from:result.fromVersion,to:result.toVersion,at:Date.now()}});
    }
    updateStatusEl.textContent = "Files are ready. Reloading Ashlar bridge…";
    setTimeout(()=>chrome.runtime.reload(), 120);
  } catch (error) {
    updateStatusEl.textContent = `Extension update failed: ${error instanceof Error ? error.message : String(error)}`;
    await refreshExtensionUpdate();
  }
}

async function rollbackExtensionUpdate() {
  const stored = await chrome.storage.local.get(["origin", "bridgeWorkerStatus"]);
  const safety = reloadSafety(stored.bridgeWorkerStatus?.origin === stored.origin ? stored.bridgeWorkerStatus : null);
  if (!safety.safe) { updateStatusEl.textContent = safety.reason; return; }
  try {
    const result = await updaterRequest("/rollback", {method:"POST",body:"{}"});
    await chrome.storage.local.set({lastExtensionUpdate:{from:result.fromVersion,to:result.toVersion,rollback:true,at:Date.now()}});
    updateStatusEl.textContent = "Previous extension files restored. Reloading…";
    setTimeout(()=>chrome.runtime.reload(), 120);
  } catch (error) {
    updateStatusEl.textContent = `Extension rollback failed: ${error instanceof Error ? error.message : String(error)}`;
    await refreshExtensionUpdate();
  }
}

async function requestPoll() {
  try {
    await chrome.runtime.sendMessage({type: "ashlar-poll-now"});
    statusEl.textContent = "Connection check requested. Existing jobs, tabs and saved replies are preserved.";
  } catch (e) {
    statusEl.textContent = `Worker could not be reached: ${e instanceof Error ? e.message : String(e)}`;
  }
}

document.getElementById("reconnect").addEventListener("click", requestPoll);
checkUpdateEl?.addEventListener("click", refreshExtensionUpdate);
applyUpdateEl?.addEventListener("click", applyExtensionUpdate);
rollbackUpdateEl?.addEventListener("click", rollbackExtensionUpdate);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void refreshDiagnostics();
});

document.getElementById("save").addEventListener("click", async () => {
  const origin = originEl.value.trim().replace(/\/$/, "");
  const token = tokenEl.value.trim();
  const enabled = enabledEl.checked;
  const maxReviewTabs = Number(maxTabsEl.value);
  if (!Number.isInteger(maxReviewTabs) || maxReviewTabs < 1 || maxReviewTabs > 16) {
    statusEl.textContent = "Review tab limit must be a whole number from 1 to 16."; return;
  }
  if (origin.startsWith("https://") || origin.startsWith("http://")) {
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) { statusEl.textContent = "Allow access to the Ashlar origin"; return; }
    } catch (e) {
      statusEl.textContent = `Could not request origin access: ${String(e.message || e)}`;
      return;
    }
  } else { statusEl.textContent = "Enter an http:// or https:// Ashlar origin"; return; }
  await chrome.storage.local.set({ origin, token, enabled, maxReviewTabs });
  await requestPoll();
});
