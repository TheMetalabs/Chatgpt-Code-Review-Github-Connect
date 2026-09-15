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
    ...document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="assistant"] pre, [data-message-author-role="assistant"] code'),
  ];
  return nodes.map((n) => (n.innerText || n.textContent || "").trim()).filter(Boolean);
}

function harvestJson() {
  const chunks = assistantCorpus();
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const hit = extractChatJson(chunks[i]);
    if (hit && !findingsJsonTooThin(hit)) return hit;
  }
  const hit = extractChatJson(chunks.join("\n"));
  if (hit && !findingsJsonTooThin(hit)) return hit;
  return null;
}