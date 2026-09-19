const originEl = document.getElementById("origin");
const tokenEl = document.getElementById("token");
const maxTabsEl = document.getElementById("maxReviewTabs");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const workerEl = document.getElementById("worker");
const updaterPortEl = document.getElementById("extensionUpdaterPort");
const updateStatusEl = document.getElementById("updateStatus");
const checkUpdateEl = document.getElementById("checkUpdate");
const applyUpdateEl = document.getElementById("applyUpdate");
const rollbackUpdateEl = document.getElementById("rollbackUpdate");
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
    maintenance: "Extension update lock active; new review admission paused",
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
  const s = await chrome.storage.local.get(["origin", "token", "enabled", "lastJobId", "lastError", "maxReviewTabs", "extensionUpdaterPort"]);
  originEl.value = s.origin || "";
  tokenEl.value = s.token || "";
  enabledEl.checked = s.enabled !== false;
  maxTabsEl.value = Number.isInteger(s.maxReviewTabs) && s.maxReviewTabs > 0 ? Math.min(s.maxReviewTabs,16) : 4;
  updaterPortEl.value = Number.isInteger(s.extensionUpdaterPort) && s.extensionUpdaterPort > 0 ? s.extensionUpdaterPort : 17373;
  if (s.lastError) statusEl.textContent = `Previous work error (not a model completion status): ${s.lastError}`;
  else if (s.lastJobId) statusEl.textContent = `Last job: ${s.lastJobId}`;
  await refreshDiagnostics();
  if (!await recoverExtensionMaintenance()) await refreshExtensionUpdate();
})();


function updaterPort() {
  const port=Number(updaterPortEl?.value||17373);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Updater port must be a whole number from 1 to 65535.");
  return port;
}
function updaterOrigin(){return `http://127.0.0.1:${updaterPort()}`;}
function reloadSafety(work) {
  const used=Number(work?.capacity?.used);
  if(!Number.isFinite(used))return {safe:false,reason:"Managed-capacity status is unavailable; poll once before reloading."};
  if(used>0)return {safe:false,reason:`Wait for managed review capacity to reach 0 (currently ${used}/${work.capacity.limit}).`};
  if(Number(work?.pendingCleanup||0)>0)return {safe:false,reason:`Wait for ${work.pendingCleanup} cleanup operation(s) to finish.`};
  return {safe:true,reason:"No managed review tab or cleanup operation is active."};
}
async function updaterRequest(path,options={}) {
  const response=await fetch(updaterOrigin()+path,{cache:"no-store",...options,headers:{"content-type":"application/json",...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok||body.ok!==true)throw new Error(body.error||`updater HTTP ${response.status}`);
  return body;
}
async function acquireMaintenance(mode) {
  const id=globalThis.crypto?.randomUUID?.() || `maintenance-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result=await chrome.runtime.sendMessage({type:"ashlar-maintenance-acquire",id,mode});
  if(!result?.ok)throw new Error(result?.error||"Could not acquire extension maintenance lock");
  if(!result.safe){await chrome.runtime.sendMessage({type:"ashlar-maintenance-release",id}).catch(()=>{});throw new Error(result.reason||"Review work is still active");}
  return id;
}
async function releaseMaintenance(id){if(id)await chrome.runtime.sendMessage({type:"ashlar-maintenance-release",id}).catch(()=>{});}
async function commitMaintenance(id){
  const result=await chrome.runtime.sendMessage({type:"ashlar-maintenance-commit",id});
  if(!result?.ok||!result.safe||!result.committed)throw new Error(result?.reason||result?.error||"Maintenance safety changed before reload");
}
async function recoverExtensionMaintenance() {
  const stored=await chrome.storage.local.get(["extensionMaintenance"]);
  const lock=stored.extensionMaintenance;
  if(!lock?.active || lock.phase!=="locked" || !lock.id)return false;
  applyUpdateEl.disabled=true; rollbackUpdateEl.disabled=true;
  try {
    const status=await updaterRequest(`/operation?id=${encodeURIComponent(lock.id)}`);
    const operation=status.operation;
    if(!operation) {
      await releaseMaintenance(lock.id);
      updateStatusEl.textContent="Recovered an abandoned maintenance lock before any file mutation started.";
      return false;
    }
    if(operation.phase==="running") {
      updateStatusEl.textContent=`Extension ${operation.mode} is still running in the local helper. Reopen or check again after it finishes; new review admission remains frozen safely.`;
      return true;
    }
    if(operation.phase==="done" && operation.ok===true) {
      if(operation.result)await chrome.storage.local.set({lastExtensionUpdate:{
        from:operation.result.fromVersion,to:operation.result.toVersion,rollback:operation.mode==="rollback",at:Date.now()
      }});
      await commitMaintenance(lock.id);
      updateStatusEl.textContent="Recovered the completed extension file operation. Reloading Ashlar bridge…";
      setTimeout(()=>chrome.runtime.reload(),120);
      return true;
    }
    await releaseMaintenance(lock.id);
    updateStatusEl.textContent=`Recovered an interrupted extension ${lock.mode || "maintenance"} operation; no helper mutation remains active.`;
    return false;
  } catch(error) {
    updateStatusEl.textContent=`Maintenance recovery is waiting for the original local helper on port ${updaterPort()}: ${error instanceof Error?error.message:String(error)}. The lock is intentionally kept until mutation state can be verified.`;
    return true;
  }
}
async function refreshExtensionUpdate() {
  if(!updateStatusEl)return;
  applyUpdateEl.disabled=true; rollbackUpdateEl.disabled=true;
  try {
    const [snapshot,stored]=await Promise.all([updaterRequest("/status"),chrome.storage.local.get(["origin","bridgeWorkerStatus"])]);
    updaterSnapshot=snapshot;
    const work=stored.bridgeWorkerStatus?.origin===stored.origin?stored.bridgeWorkerStatus:null;
    const safety=reloadSafety(work),running=chrome.runtime.getManifest().version,disk=snapshot.installedVersion||"not installed",available=snapshot.availableVersion||"unknown";
    const reloadRequired=Boolean(snapshot.installedVersion&&snapshot.installedVersion!==running);
    let line=`Running ${running}; files ${disk}; origin/main ${available}; helper port ${updaterPort()}.`;
    if(reloadRequired)line+=" Files are newer than the running extension; reload is required.";
    else if(snapshot.updateAvailable)line+=" Update available."; else line+=" Up to date.";
    if(!safety.safe)line+=` ${safety.reason}`;
    updateStatusEl.textContent=line;
    applyUpdateEl.textContent=reloadRequired?"Reload updated files":"Update & Reload";
    applyUpdateEl.disabled=!safety.safe||!(reloadRequired||snapshot.updateAvailable);
    rollbackUpdateEl.disabled=!safety.safe||!snapshot.backupAvailable;
  } catch(error) {
    updaterSnapshot=null;
    const extensionId=chrome.runtime.id||"<Ashlar extension ID>";
    updateStatusEl.textContent=`Local updater unavailable on 127.0.0.1:${updaterPortEl?.value||17373}: ${error instanceof Error?error.message:String(error)}. Start it with ASHLAR_EXTENSION_UPDATER_EXTENSION_ID=${extensionId} and the same port.`;
  }
}
async function applyExtensionUpdate() {
  if(!updaterSnapshot)return refreshExtensionUpdate();
  let lockId;
  try {
    lockId=await acquireMaintenance("update");
    const running=chrome.runtime.getManifest().version;
    if(updaterSnapshot.installedVersion===running&&updaterSnapshot.updateAvailable) {
      const result=await updaterRequest("/update",{method:"POST",body:JSON.stringify({operationId:lockId,expectedCommit:updaterSnapshot.availableCommit})});
      await chrome.storage.local.set({lastExtensionUpdate:{from:result.fromVersion,to:result.toVersion,at:Date.now()}});
    }
    await commitMaintenance(lockId);
    updateStatusEl.textContent="Files are ready and admission is frozen. Reloading Ashlar bridge…";
    setTimeout(()=>chrome.runtime.reload(),120);
  } catch(error) {
    await releaseMaintenance(lockId);
    updateStatusEl.textContent=`Extension update stopped safely: ${error instanceof Error?error.message:String(error)}`;
    await refreshExtensionUpdate();
  }
}
async function rollbackExtensionUpdate() {
  let lockId;
  try {
    lockId=await acquireMaintenance("rollback");
    const result=await updaterRequest("/rollback",{method:"POST",body:JSON.stringify({operationId:lockId})});
    await chrome.storage.local.set({lastExtensionUpdate:{from:result.fromVersion,to:result.toVersion,rollback:true,at:Date.now()}});
    await commitMaintenance(lockId);
    updateStatusEl.textContent="Previous extension files restored and admission is frozen. Reloading…";
    setTimeout(()=>chrome.runtime.reload(),120);
  } catch(error) {
    await releaseMaintenance(lockId);
    updateStatusEl.textContent=`Extension rollback stopped safely: ${error instanceof Error?error.message:String(error)}`;
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

async function requestClearStuck() {
  try {
    const res = await chrome.runtime.sendMessage({type: "ashlar-clear-stuck"});
    statusEl.textContent = res?.ok
      ? (res.timedOut
          ? `Cleared ${res.cleared} so far — the sweep timed out (bridge or a tab is slow). Click again to finish the rest.`
          : `Cleared ${res.cleared} stuck job(s) the server had forgotten (${res.kept} kept). Live tabs and server-owned jobs were untouched.`)
      : !res
        ? "No response from the worker (it may be busy or restarting). Wait a moment and try again."
        : `Could not clear stuck jobs: ${res.error || "no eligible jobs"}`;
  } catch (e) {
    statusEl.textContent = `Worker could not be reached: ${e instanceof Error ? e.message : String(e)}`;
  }
}

document.getElementById("reconnect").addEventListener("click", requestPoll);
document.getElementById("clearStuck")?.addEventListener("click", requestClearStuck);
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
  const extensionUpdaterPort = Number(updaterPortEl.value);
  if (!Number.isInteger(maxReviewTabs) || maxReviewTabs < 1 || maxReviewTabs > 16) {
    statusEl.textContent = "Review tab limit must be a whole number from 1 to 16."; return;
  }
  if (!Number.isInteger(extensionUpdaterPort) || extensionUpdaterPort < 1 || extensionUpdaterPort > 65535) {
    statusEl.textContent = "Updater port must be a whole number from 1 to 65535."; return;
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
  await chrome.storage.local.set({ origin, token, enabled, maxReviewTabs, extensionUpdaterPort });
  await requestPoll();
});
