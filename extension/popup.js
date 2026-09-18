const originEl = document.getElementById("origin");
const tokenEl = document.getElementById("token");
const maxTabsEl = document.getElementById("maxReviewTabs");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const connectionEl = document.getElementById("connection");
const workerEl = document.getElementById("worker");

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
})();

async function requestPoll() {
  try {
    await chrome.runtime.sendMessage({type: "ashlar-poll-now"});
    statusEl.textContent = "Connection check requested. Existing jobs, tabs and saved replies are preserved.";
  } catch (e) {
    statusEl.textContent = `Worker could not be reached: ${e instanceof Error ? e.message : String(e)}`;
  }
}

document.getElementById("reconnect").addEventListener("click", requestPoll);
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
