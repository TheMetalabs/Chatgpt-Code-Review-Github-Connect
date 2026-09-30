// Loaded first on every provider page (manifest, background.js contentFiles): only function
// declarations, no top-level state, so it can be injected again and loaded alone by any script.

/* ChatGPT's transcript has two DOMs, and every turn lookup (composer.js, json.js, quota.js) goes through
 * these helpers. Up to 2026-09 a message is the node with data-message-author-role (its id in
 * data-message-id). The 2026-09 unit DOM (live 1.1.41: a review sent and answered, seen as 0 user
 * turns, send_unconfirmed) has neither: a message is a search unit keyed "<turn>:<n>:<role>"
 * (data-content-search-unit-key). A user unit holds the bubble ([data-user-message-bubble]) and sits
 * in a same-keyed wrapper (data-chatgpt-search-unit-key) that also holds the file cards and the
 * message id (data-chatgpt-search-message-ids); its "You said:" heading is an sr-only sibling. An
 * assistant unit carries its ids itself ("<id> <id>") and its body data-chatgpt-selection-message-id;
 * the turn container (data-content-search-turn-key) holds the user unit, the answer and, beside them
 * outside every unit, the answer's action row. */

/** The message nodes of `role` ("user", "assistant"; both when omitted), in either DOM. */
function turnSelector(role) {
  return (role ? [role] : ["user", "assistant"])
    .map(r => `[data-message-author-role="${r}"], [data-content-search-unit-key$=":${r}"]`).join(", ");
}

/** Any message node, of any role (the old DOM's system or tool messages too). */
function turnNodeSelector() {
  return "[data-message-author-role], [data-content-search-unit-key]";
}

/** Anything inside a message of `role` (any role when omitted): the node, or the unit DOM's wrapper
 * that holds a user unit's file cards beside it. For "is this element transcript content" checks. */
function turnAreaSelector(role) {
  return role
    ? `[data-message-author-role="${role}"], [data-content-search-unit-key$=":${role}"], [data-chatgpt-search-unit-key$=":${role}"]`
    : "[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key]";
}

/** Whether `el` is a unit DOM message node. */
function unitTurn(el) {
  return Boolean(el?.getAttribute?.("data-content-search-unit-key"));
}

/** The message nodes of `role` under `root` (the document by default; never `root` itself), in
 * document order. No document (a worker-side realm): none. */
function turnEls(role, root = globalThis.document) {
  return root?.querySelectorAll ? [...root.querySelectorAll(turnSelector(role))] : [];
}
/** Whether the page shows any user message. */
function hasUserTurn() {
  return Boolean(globalThis.document?.querySelector?.(turnSelector("user")));
}
function userTurnEls(root) { return turnEls("user", root); }
function assistantTurnEls(root) { return turnEls("assistant", root); }
function conversationTurnEls(root) { return turnEls(undefined, root); }

/** A message node's role: "user", "assistant" (or the old DOM's other roles), "" for anything else. */
function turnRole(el) {
  const role = el?.getAttribute?.("data-message-author-role");
  if (role) return role;
  return /:(user|assistant)$/.exec(el?.getAttribute?.("data-content-search-unit-key") || "")?.[1] || "";
}

/** The unit DOM's same-keyed wrapper of a unit (a user unit's holds its file cards and its id). */
function unitWrapper(el) {
  const key = el?.getAttribute?.("data-content-search-unit-key");
  if (!key || !el.closest) return null;
  const quoted = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, "\\$&");
  return el.closest(`[data-chatgpt-search-unit-key="${quoted}"]`);
}

/** A message node's id: data-message-id; in the unit DOM the first of its (or its wrapper's)
 * data-chatgpt-search-message-ids, else its body's data-chatgpt-selection-message-id. "" when none. */
function turnMessageId(el) {
  const id = el?.getAttribute?.("data-message-id");
  if (id) return id;
  if (!unitTurn(el)) return "";
  const first = node => (node?.getAttribute?.("data-chatgpt-search-message-ids") || "").trim().split(/\s+/)[0] || "";
  return first(el) || first(unitWrapper(el)) ||
    el.querySelector?.("[data-chatgpt-selection-message-id]")?.getAttribute("data-chatgpt-selection-message-id") || "";
}

/** Where a user message's typed text renders: the old DOM's collapsible content, the unit DOM's
 * bubble, else the message node itself. */
function turnTextRoot(turn) {
  return turn?.querySelector?.('[data-testid="collapsible-user-message-content"], [data-user-message-bubble]') || turn;
}
