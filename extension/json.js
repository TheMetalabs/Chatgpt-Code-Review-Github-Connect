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
    let esc = false;
    for (let i = end; i >= 0; i -= 1) {
      const c = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
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

function assistantCorpus() {
  const nodes = [
    ...document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-message-author-role="assistant"] pre, [data-message-author-role="assistant"] code',
    ),
  ];
  const copy = document.querySelector('[data-testid="copy-turn-action-button"], [aria-label="응답 복사"], [aria-label="Copy response"]');
  let turn = copy ? copy.parentElement : null;
  for (let i = 0; i < 8 && turn; i += 1) {
    nodes.push(turn);
    turn = turn.parentElement;
  }
  return nodes.map((n) => (n.innerText || n.textContent || "").trim()).filter(Boolean);
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
  for (;;) {
    const done = typeof chatGenerationFinished === "function" ? chatGenerationFinished() : !stopButtonVisible();
    const json = harvestJson({ allowThin: done });
    if (typeof quotaHit === "function" && quotaHit() && !json) {
      const e = new Error(`${name} usage limit`);
      e.code = "quota";
      throw e;
    }
    if (json) {
      if (json === stable) hits += 1;
      else {
        stable = json;
        hits = 1;
      }
      if (done && hits >= 1) return json;
      if (hits >= 2 && typeof stopButtonVisible === "function" && !stopButtonVisible()) return json;
      emptyTicks = 0;
    } else if (done) {
      emptyTicks += 1;
      if (emptyTicks >= 3) throw emptyReplyError(name);
    } else {
      emptyTicks = 0;
    }
    await sleep(800);
  }
}
