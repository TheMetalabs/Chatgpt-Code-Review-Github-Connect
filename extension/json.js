function isReviewObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "findings" in value || "merge_recommendation" in value || "keep" in value;
}

function parseReviewSlice(slice) {
  try {
    const parsed = JSON.parse(slice);
    return isReviewObject(parsed) ? slice : null;
  } catch {
    return null;
  }
}

function lastReviewJson(text) {
  const s = String(text || "");
  for (let end = s.lastIndexOf("}"); end >= 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i -= 1) {
      const c = s[i];
      if (c === '"') {
        let slashes = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "}") depth += 1;
      else if (c === "{") {
        depth -= 1;
        if (depth === 0) {
          const hit = parseReviewSlice(s.slice(i, end + 1));
          if (hit) return hit;
          break;
        }
      }
    }
  }
  return null;
}

function extractChatJson(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const hit = lastReviewJson(fences[i][1] || "") || parseReviewSlice((fences[i][1] || "").trim());
    if (hit) return hit;
  }
  const dangling = s.match(/```(?:json)?\s*([\s\S]+)$/i);
  if (dangling) {
    const hit = lastReviewJson(dangling[1] || "");
    if (hit) return hit;
  }
  return lastReviewJson(s);
}

function cleanTurnText(el) {
  if (!el) return "";
  const root = el.cloneNode(true);
  root.querySelectorAll("button, svg, script, [data-testid='copy-turn-action-button'], [data-content-reference-start]").forEach((n) => n.remove());
  root.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
  return (root.innerText || root.textContent || "").replace(/\u00a0/g, " ").trim();
}

function assistantCorpus() {
  const root = currentAssistantRoot();
  if (!root) return [];
  const turns = root.matches('[data-message-author-role="assistant"]')
    ? [root]
    : [...root.querySelectorAll('[data-message-author-role="assistant"]')];
  const chunks = [];
  for (const turn of turns) {
    const md = turn.querySelector(".markdown") || turn;
    const text = cleanTurnText(md);
    if (text) chunks.push(text);
  }
  return chunks;
}

async function harvestViaCopy() {
  const root = currentAssistantRoot();
  if (!root) return null;
  const btn = [...root.querySelectorAll('[data-testid="copy-turn-action-button"]')]
    .reverse()
    .find((el) => /응답 복사|Copy response/i.test(el.getAttribute("aria-label") || ""));
  if (!btn) return null;
  try {
    // Do not interpret a review left in the clipboard by a previous job as this reply.
    const marker = `ashlar-copy-${Date.now()}-${Math.random()}`;
    await navigator.clipboard.writeText(marker);
    btn.click();
    await sleep(250);
    const text = await navigator.clipboard.readText();
    if (text === marker) return null;
    return extractChatJson(text);
  } catch {
    return null;
  }
}

function harvestJson(opts) {
  const allowThin = Boolean(opts && opts.allowThin);
  const chunks = assistantCorpus();
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const hit = extractChatJson(chunks[i]);
    if (hit && (allowThin || !findingsJsonTooThin(hit))) return hit;
  }
  const hit = extractChatJson(chunks.join("\n"));
  if (hit && (allowThin || !findingsJsonTooThin(hit))) return hit;
  return null;
}

function emptyReplyError(name) {
  const e = new Error(`${name} finished without review JSON`);
  e.code = "empty";
  return e;
}

async function waitUntilReviewOrQuota(name) {
  let stable = "";
  let hits = 0;
  let emptyTicks = 0;
  // Queue and generation have no duration deadline. Only current-turn UI can end them.
  for (;;) {
    const done = chatGenerationFinished({
      stopVisible: stopButtonVisible(),
      replyActionsVisible: replyDoneVisible(),
    });
    let json = done ? harvestJson({ allowThin: true }) : null;
    if (done && !json && emptyTicks % 2 === 0) json = await harvestViaCopy();
    if (quotaHit() && !json) {
      const e = new Error(`${name} usage limit`);
      e.code = "quota";
      throw e;
    }
    if (done && json) {
      hits = json === stable ? hits + 1 : 1;
      stable = json;
      if (hits >= 2) return json;
      emptyTicks = 0;
    } else {
      hits = 0;
      stable = "";
      emptyTicks = done ? emptyTicks + 1 : 0;
      if (emptyTicks >= 6) throw emptyReplyError(name);
    }
    await sleep(800);
  }
}

/** Short message replies keep MV3 workers recoverable; the page owns the long model call.
 * State survives script reinjection and retains terminal outcomes for a restarted worker.
 */
function installReviewRunner(name, run) {
  const state = globalThis.__ashlarRunnerState || { running: false, jobId: "", result: null };
  globalThis.__ashlarRunnerState = state;
  state.run = run;
  if (state.listener) return;
  const busy = () => ({ ok: false, code: "busy", retry: true, error: "generation pending" });
  state.listener = (msg, _sender, reply) => {
    if (msg?.type !== "ashlar-run" && msg?.type !== "ashlar-harvest") return;
    if (msg.jobId && state.jobId && msg.jobId !== state.jobId) {
      reply({ ok: false, code: "job_mismatch", error: "tab belongs to another job" });
      return;
    }
    if (state.result) { reply(state.result); return; }
    if (state.running) { reply(busy()); return; }
    if (msg.type === "ashlar-harvest") {
      reply({ ok: false, code: "idle", error: "no active review in this page" });
      return;
    }
    state.jobId = String(msg.jobId || "");
    state.running = true;
    Promise.resolve().then(() => state.run(String(msg.prompt || ""), msg.reasoning, Boolean(msg.resume)))
      .then(raw => { state.result = { ok: true, raw }; })
      .catch(e => {
        state.result = { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code || "error" };
      })
      .finally(() => { state.running = false; });
    reply(busy());
  };
  chrome.runtime.onMessage.addListener(state.listener);
}
