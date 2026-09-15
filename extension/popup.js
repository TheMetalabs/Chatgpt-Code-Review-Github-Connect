const originEl = document.getElementById("origin");
const tokenEl = document.getElementById("token");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["origin", "token", "enabled", "lastJobId", "lastError"], (s) => {
  originEl.value = s.origin || "";
  tokenEl.value = s.token || "";
  enabledEl.checked = s.enabled !== false;
  if (s.lastError) statusEl.textContent = s.lastError;
  else if (s.lastJobId) statusEl.textContent = `last job ${s.lastJobId}`;
});

document.getElementById("save").addEventListener("click", async () => {
  const origin = originEl.value.trim().replace(/\/$/, "");
  const token = tokenEl.value.trim();
  const enabled = enabledEl.checked;
  if (origin.startsWith("https://") || origin.startsWith("http://")) {
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        statusEl.textContent = "allow access to the Ashlar origin";
        return;
      }
    } catch {
      /* already granted */
    }
  }
  await chrome.storage.local.set({ origin, token, enabled });
  try {
    const res = await fetch(`${origin}/api/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ashlar-bridge-token": token },
      body: JSON.stringify({ action: "ping", token }),
    });
    const json = await res.json();
    statusEl.textContent = json.ok ? "connected" : json.error || "rejected";
  } catch (e) {
    statusEl.textContent = e instanceof Error ? e.message : "could not reach Ashlar";
  }
});
