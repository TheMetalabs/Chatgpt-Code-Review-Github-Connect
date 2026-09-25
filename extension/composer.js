function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wake on page changes even when background-tab timer cadence is throttled.
 * The timer is only a fallback observation cadence, never a failure deadline. */
function waitForPageChange(ms = 800) {
  if (typeof MutationObserver !== "function") return sleep(ms);
  return new Promise(resolve => {
    let timer;
    const finish = () => { observer.disconnect(); clearTimeout(timer); document.removeEventListener("visibilitychange", finish); resolve(); };
    const observer = new MutationObserver(finish);
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["data-message-id", "disabled", "aria-disabled", "aria-busy", "data-state", "data-streaming-response-status", "style", "class"]});
    document.addEventListener("visibilitychange", finish, {once: true});
    timer = setTimeout(finish, ms);
  });
}

function visible(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 40 && r.height > 16;
}

function readComposer(el) {
  if (!el) return "";
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || "";
  return el.innerText || el.textContent || "";
}

/** An element's text for a LOSSLESS comparison (a fix prompt): a textarea's value; in a rich editor
 * every text node verbatim, each block (P, DIV, PRE, LI, ...) one line and each <br> a line break,
 * except the <br> that ends a block (the editor's placeholder that keeps an empty or newline-ended line
 * visible). innerText is not lossless there: it separates <p> blocks by a blank line (ChatGPT's
 * composer holds one <p> per line) and collapses spaces outside pre-wrap. */
function losslessText(el, skip) {
  if (!el) return "";
  if ((typeof HTMLTextAreaElement === "function" && el instanceof HTMLTextAreaElement) ||
      (typeof HTMLInputElement === "function" && el instanceof HTMLInputElement)) return el.value || "";
  const read = (node, block) => {
    const parts = [];
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) parts.push({text: child.nodeValue || ""});
      else if (child.nodeType !== 1 || skip?.has(child) || child.matches('script, style, [hidden], [aria-hidden="true"]')) continue;
      else if (child.tagName === "BR") parts.push({text: "\n", br: true});
      else {
        const inner = /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE)$/.test(child.tagName);
        parts.push({text: read(child, inner), block: inner});
      }
    }
    if (block && parts.at(-1)?.br) parts.pop();
    return parts.map((part, i) => (i && (part.block || parts[i - 1].block) ? "\n" : "") + part.text).join("");
  };
  return read(el, true);
}

/** The form a FIX prompt is verified in, before Send (the composer draft) and after it (the sent turn):
 * its exact text, with only the provider's known transport changes undone. Line endings become LF (a
 * textarea and the provider store CRLF as LF), and whitespace at the two ends of the whole prompt is
 * dropped (the provider trims a sent message; a fix prompt starts and ends with Ashlar's instructions,
 * never with source). Every other character, whitespace included, must match: a fix prompt inlines
 * source whose spaces are content. A review prompt keeps normalizePrompt. */
function fixPromptForm(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/** Whether the composer holds the fix prompt whose fixPromptForm is `exact`, read losslessly. */
function composerHoldsFix(el, exact) {
  return typeof exact === "string" && fixPromptForm(losslessText(el)) === exact;
}

/** A fix draft that matches its prompt only once whitespace is collapsed was changed by the editor:
 * typing it again yields the same, and sending it would deliver other source. The run ends before Send. */
function fixPromptAltered() {
  const error = new Error("the composer changed the fix prompt's whitespace; it was not sent");
  error.code = "prompt_altered";
  return error;
}

function composerHas(el, text) {
  const got = readComposer(el).replace(/\s+/g, " ").trim();
  const want = String(text || "").replace(/\s+/g, " ").trim();
  if (!want) return false;
  if (want.length <= 48) return got.includes(want);
  return got.includes(want.slice(0, 48)) && got.includes(want.slice(-40)) && got.length >= Math.floor(want.length * 0.85);
}

function selectComposerContents(el) {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) { el.select(); return; }
  const range = document.createRange(); range.selectNodeContents(el);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}

async function insertPrompt(el, text) {
  selectComposerContents(el);
  document.execCommand("insertText", false, text);
  if (composerHas(el, text)) return;
  // Keep edits scoped to this input even if another UI element had the selection.
  selectComposerContents(el);
  document.execCommand("delete", false, null);
  for (let i = 0; i < text.length; i += 1500) {
    if (!el.isConnected) return; // caller re-finds a remounted composer
    document.execCommand("insertText", false, text.slice(i, i + 1500));
    await Promise.resolve();
  }
}

function splitAttachments(raw) {
  const source = String(raw || "");
  // One JSON line is a transport envelope, NOT model text. JSON escaping prevents
  // source files (including this parser) from terminating their own attachments.
  const frame = /(?:^|\r?\n)<<<ASHLAR_ATTACHMENTS_V2>>>\r?\n([^\r\n]*)\r?\n<<<END_ASHLAR_ATTACHMENTS_V2>>>[ \t\r\n]*$/.exec(source);
  if (frame) {
    let files;
    try { files = JSON.parse(frame[1]); } catch { throw new Error("invalid attachment envelope"); }
    if (!Array.isArray(files) || files.some(file => !file || typeof file.name !== "string" ||
        !file.name.trim() || /[\r\n]/.test(file.name) || typeof file.body !== "string")) {
      throw new Error("invalid attachment entries");
    }
    return {prompt: source.slice(0, frame.index).trim(), files};
  }
  if (/^<<<ASHLAR_ATTACHMENTS_V2>>>/m.test(source)) throw new Error("incomplete attachment envelope");
  // Read queued legacy prompts too. A quoted marker inside JS/TS is not a line
  // delimiter; the old unanchored lazy regex leaked entire snapshot tails.
  const files = [];
  const prompt = source.replace(/^<<<ATTACH:([^>\r\n]+)>>>\r?\n([\s\S]*?)^<<<END_ATTACH>>>[ \t]*(?=\r?$)/gm,
    (_m, name, body) => { files.push({name: name.trim(), body: body.replace(/\r?\n$/, "")}); return ""; }).trim();
  return {prompt, files};
}

/** A FIX run's delivery split into its typed line and its one attachment (src/lib/fix-attachment.ts
 * fixDeliveryText): the frame ends the text and its entry is ONE JSON line (every line break in
 * the source is escaped), so no source line can end it. null: no frame (a prompt typed verbatim);
 * {error}: a frame marker that is not a well-formed frame (never typed, never guessed at). The
 * review V2 envelope is not a fix frame: a fix never uploads through splitAttachments. */
function fixFrame(raw) {
  const source = String(raw ?? "");
  const frame = /\r?\n<<<ASHLAR_FIX_ATTACHMENT_V1>>>\r?\n([^\r\n]*)\r?\n<<<END_ASHLAR_FIX_ATTACHMENT_V1>>>[ \t\r\n]*$/.exec(source);
  if (!frame) return /^<<<(?:END_)?ASHLAR_FIX_ATTACHMENT_V1>>>/m.test(source) ? {error: "its frame is malformed"} : null;
  return {prompt: source.slice(0, frame.index).trim(), entry: frame[1]};
}

/** The text to type and the files to upload for this run's prompt. A FIX run's source travels as
 * its one attachment (fixFrame; staged by fillComposer, never through this list) and only its
 * typed line is typed; a fix prompt with no frame is typed VERBATIM, byte-exact: a line in it that
 * looks like a review envelope (a `<<<ASHLAR_ATTACHMENTS_V2>>>` sentinel, a legacy `<<<ATTACH:…>>>`
 * block) is content, never transport. Only a review prompt carries review attachments
 * (splitAttachments). The run's kind is set by ashlar-run before the runner starts. */
function promptParts(raw) {
  if (globalThis.__ashlarRunnerState?.kind !== "fix") return splitAttachments(raw);
  const frame = fixFrame(raw);
  return {prompt: frame?.prompt ?? String(raw ?? ""), files: []};
}

/** A fix run ends before anything is sent when its attachment cannot be staged exactly: it is
 * never replaced by pasting the source into the typed prompt (#93). */
function fixAttachmentFailed(detail) {
  const error = new Error(`the fix attachment could not be staged: ${detail}; nothing was sent`);
  error.code = "attachment_failed";
  return error;
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes or of a buffer. */
async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A fix run's attachment, checked before anything is uploaded or typed: a well-formed entry, at
 * most the cap (src/lib/fix-attachment.ts FIX_ATTACHMENT_MAX_BYTES, checked again here: a page
 * never uploads what the server would refuse), bytes that match their SHA-256, and a typed line
 * that names that hash. null: a prompt with no frame. Limits are locals, not top-level consts:
 * composer.js is re-injected into a page that already ran it. */
async function fixAttachmentParts(raw) {
  const MAX_BYTES = 512 * 1024;
  const frame = fixFrame(raw);
  if (!frame) return null;
  if (frame.error) throw fixAttachmentFailed(frame.error);
  let entry;
  try { entry = JSON.parse(frame.entry); } catch { throw fixAttachmentFailed("its entry is not JSON"); }
  if (!entry || typeof entry.name !== "string" || !/^[\w.-]+$/.test(entry.name) || typeof entry.body !== "string" ||
      typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw fixAttachmentFailed("its entry is malformed");
  const bytes = new TextEncoder().encode(entry.body).length;
  if (bytes > MAX_BYTES) {
    const error = new Error(`the fix attachment is ${bytes} bytes; at most ${MAX_BYTES} bytes are uploaded; nothing was sent`);
    error.code = "attachment_too_large";
    throw error;
  }
  if (await sha256Hex(entry.body) !== entry.sha256) throw fixAttachmentFailed("its bytes do not match their SHA-256");
  if (!frame.prompt.includes(entry.sha256)) throw fixAttachmentFailed("the typed prompt does not name its SHA-256");
  return {prompt: frame.prompt, file: {name: entry.name, body: entry.body, sha256: entry.sha256}};
}

function composerFileInput() {
  const input =
    document.querySelector("form[data-type='unified-composer'] input[type='file']") ||
    document.querySelector("form input[type='file'][multiple]") ||
    document.querySelector("input[type='file']");
  return input instanceof HTMLInputElement ? input : null;
}

/** Hand the fix attachment to the composer's upload input: the File's own bytes are hashed first,
 * so what is uploaded is exactly the bytes the typed line names. */
async function stageFixAttachment(file) {
  const input = composerFileInput();
  if (!input) throw fixAttachmentFailed("the composer has no file input");
  const staged = new File([file.body], file.name, {type: "text/plain"});
  if (await sha256Hex(await staged.arrayBuffer()) !== file.sha256) throw fixAttachmentFailed("the staged bytes do not match their SHA-256");
  // The stop fence, in the same task as the upload.
  globalThis.throwIfStopped?.();
  markUploadAlerts();
  const dt = new DataTransfer();
  dt.items.add(staged);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", {bubbles: true}));
  input.dispatchEvent(new Event("change", {bubbles: true}));
}

/** Wait until the composer shows the fix attachment's chip with no upload in progress
 * (attachmentsReady, the send barrier's own rule), held for SETTLE_MS: a chip can render a frame
 * before its progress ring (the live 1.1.29 run typed and clicked Send 27 ms after the chip showed,
 * mid-upload, and ChatGPT dropped the click). A chip or toast that reports the upload failed
 * (uploadFailure), or a chip that never settles within the window, ends the run (attachment_failed)
 * before any text is typed. */
async function waitFixAttachmentStaged(name) {
  const STAGE_MS = 3 * 60 * 1000, SETTLE_MS = 1000;
  const deadline = Date.now() + STAGE_MS;
  let readySince = null;
  for (;;) {
    globalThis.throwIfStopped?.();
    const form = (typeof composer === "function" ? composer() : null)?.closest("form") || composerFileInput()?.closest("form");
    const failed = uploadFailure(form, [name]);
    if (failed) throw fixAttachmentFailed(`the page reported the upload of ${name} failed (${failed})`);
    if (form && attachmentsReady(form, [name])) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= SETTLE_MS) return;
    } else readySince = null;
    if (Date.now() >= deadline) throw fixAttachmentFailed(`${name} was not shown as uploaded within ${STAGE_MS / 60000} minutes`);
    step("attachments_waiting");
    await waitForPageChange(250);
  }
}

async function attachFiles(files) {
  if (!files.length) return false;
  const input = composerFileInput();
  if (!input) return false;
  markUploadAlerts();
  const dt = new DataTransfer();
  for (const f of files) {
    dt.items.add(new File([f.body], f.name, { type: "text/plain" }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // Input filling does not depend on upload completion. Send has its own
  // named-chip + progress + enabled-control gate in the current composer form.
  return true;
}

async function fillComposer(el, text) {
  const state = globalThis.__ashlarRunnerState;
  // A fix's source is its one attachment, checked before anything is uploaded or typed.
  const fixAttachment = state?.kind === "fix" ? await fixAttachmentParts(text) : null;
  const parts = promptParts(text);
  let body = parts.prompt || (parts.files.length ? "" : text);
  // A fix prompt must be held exactly (fixPromptForm, read losslessly); a review prompt normalized.
  const exact = state?.kind === "fix" ? fixPromptForm(body) : null;
  const holds = editor => exact === null ? normalizePrompt(readComposer(editor)) === normalizePrompt(body) : composerHoldsFix(editor, exact);
  // Held only once whitespace is collapsed: the editor changed the fix prompt (fixPromptAltered).
  const altered = editor => exact !== null && normalizePrompt(readComposer(editor)) === normalizePrompt(body);
  if (state) state.pendingAttachments = [];
  if (fixAttachment) {
    // Staged and shown as uploaded before the typed line exists: a failure sends nothing, and is
    // never answered by pasting the source into the typed prompt.
    globalThis.throwIfStopped?.();
    await stageFixAttachment(fixAttachment.file);
    if (state) state.pendingAttachments = [fixAttachment.file.name];
    await waitFixAttachmentStaged(fixAttachment.file.name);
  }
  if (parts.files.length) {
    // The stop fence, in the same task as the upload: no file is staged in a composer the user opened
    // in the tab meanwhile (their next send would upload it).
    globalThis.throwIfStopped?.();
    const attached = await attachFiles(parts.files);
    if (attached) {
      if (state) state.pendingAttachments = parts.files.map(file => file.name);
    } else {
      // Only an unavailable upload input authorizes inline fallback. Slow chips
      // or an in-progress upload must never paste the whole snapshot again.
      body = [parts.prompt, ...parts.files.map(file => `--- ${file.name}\n${file.body}`)].filter(Boolean).join("\n\n");
    }
  }
  // Before any text is typed: the ownership verdict must recognise Ashlar's own prompt in the
  // composer even before clickSend journals it.
  if (state) state.pendingPrompt = normalizePrompt(body);
  for (;;) {
    // The stop fence lives with the runner state in json.js (absent: nothing can stop the run).
    globalThis.throwIfStopped?.();
    // From here the composer text is Ashlar's own (checked empty of the user's just above).
    if (state) state.composerTyping = true;
    // Uploading can replace the editor. Never type into a cached detached node.
    el = typeof composer === "function" ? composer() : el;
    if (!el?.isConnected) { await waitForPageChange(250); continue; }
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
      proto?.set?.call(el, body);
      el.dispatchEvent(new Event("input", {bubbles: true}));
      el.dispatchEvent(new Event("change", {bubbles: true}));
    } else {
      await insertPrompt(el, body);
    }
    if (!el.isConnected) continue;
    // The send barrier checks the complete text too; do not accept a truncated
    // draft here using the historical 85-percent heuristic.
    if (holds(el)) return body;
    if (altered(el)) throw fixPromptAltered();
    const dt = new DataTransfer(); dt.setData("text/plain", body);
    selectComposerContents(el);
    el.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true}));
    await Promise.resolve();
    if (!el.isConnected) continue;
    if (holds(el)) return body;
    if (altered(el)) throw fixPromptAltered();
    step("composer_waiting");
    await waitForPageChange(250);
  }
}

/** textContent drops <br>/<p> boundaries; innerText can omit collapsed text.
 * Read the message body, not attachment chips, copy controls or hidden UI. `skip`: elements left
 * out too (a sent fix turn's file cards, turnAttachments). */
function messagePromptText(turn, skip) {
  const root = turn?.querySelector?.('[data-testid="collapsible-user-message-content"]') || turn;
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1 || skip?.has(node)) return "";
    if (node.matches('button, svg, script, style, [hidden], [aria-hidden="true"], [data-file-name], [role="group"][aria-label]')) return "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(walk).join("");
    return /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.tagName) ? `\n${text}\n` : text;
  };
  return root?.childNodes ? walk(root).trim() : root?.textContent || root?.innerText || "";
}

/** Where a sent user turn renders: its conversation-turn section or article (ChatGPT can render a
 * file card beside the message node, not inside it), else the message node itself. */
function turnContainer(turn) {
  return turn?.closest?.('[data-testid^="conversation-turn"], [data-turn="user"], article') || turn;
}

/** The file cards a sent user turn shows for the run's own attachments `names`, and whether every
 * name has one. ChatGPT renders a sent file as a card holding its name and its type or size as
 * plain text (no data-file-name), in or beside the message node. A card is an element that names
 * the file (data-file-name, aria-label, title, or its own text) outside the typed text, widened to
 * the largest ancestor that still holds only the card's short text. A name inside the typed text
 * (the fix line names its file) is part of that text, never a card. */
function turnAttachments(turn, names = []) {
  const CARD_TEXT_MAX = 80;
  const cards = new Set(), found = new Set();
  const container = turnContainer(turn);
  if (!container?.querySelectorAll || !names.length) return {cards, shown: names.length === 0};
  const residual = el => names.reduce((text, name) => text.split(name).join(" "), normalizePrompt(el.textContent)).trim();
  const named = el => names.filter(name => el.getAttribute("data-file-name") === name ||
    (el.getAttribute("aria-label") || "").includes(name) || (el.getAttribute("title") || "").includes(name) ||
    [...el.childNodes].some(child => child.nodeType === 3 && (child.nodeValue || "").includes(name)));
  const textBody = '.whitespace-pre-wrap, .rich-text-user-turn';
  for (const seed of container.querySelectorAll("*")) {
    const hits = named(seed);
    if (!hits.length) continue;
    const block = seed.closest(`${textBody}, p, li, pre, blockquote`);
    if (residual(seed).length > CARD_TEXT_MAX || (block && container.contains(block) && residual(block).length > CARD_TEXT_MAX)) continue;
    let card = seed;
    for (let up = card.parentElement; up && up !== container && up !== turn && container.contains(up); up = up.parentElement) {
      if (up.matches(textBody) || up.querySelector(textBody) || residual(up).length > CARD_TEXT_MAX) break;
      card = up;
    }
    cards.add(card);
    hits.forEach(name => found.add(name));
  }
  for (const card of cards) if ([...cards].some(other => other !== card && other.contains(card))) cards.delete(card);
  return {cards, shown: names.every(name => found.has(name))};
}

/** Whether a sent user turn holds EXACTLY a fix's typed prompt (its lossless form `exact`, read two
 * ways as json.js fixTurnExact does) once its file cards are left out. */
function fixTurnHolds(turn, exact, names = []) {
  const {cards} = turnAttachments(turn, names);
  const body = turn.querySelector?.('[data-testid="collapsible-user-message-content"]') || turn;
  return [messagePromptText(turn, cards), losslessText(body, cards)].some(text => fixPromptForm(text) === exact);
}

/** A fix's send is proven by a user turn after the baseline that shows each of its attachments
 * (turnAttachments) and, with their cards left out, is its typed prompt: equal once whitespace is
 * normalized. That locates the send; whether the turn is the prompt EXACTLY (its lossless form, a
 * whitespace change is an edit) is json.js journaledTurnIntegrity's verdict on the located turn. */
function fixTurnSent(turn, record) {
  const names = record.attachments || [];
  const {cards, shown} = turnAttachments(turn, names);
  return shown && normalizePrompt(messagePromptText(turn, cards)) === record.expected;
}

function renderedControl(el) {
  if (!el?.isConnected) return false;
  for (let node = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  }
  const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
}

/** The file-chip shapes a composer renders for a staged attachment: a named group, a data-file-name
 * tile, or an element that names its file only in its title. ONE list (fileChips) for the send
 * barrier (attachmentsReady: the run's own files are there) and the release verdict (json.js
 * composerStagedFiles: a file there that is not the run's is the user's draft), so neither sees a
 * chip the other misses (Ashlar 4101623051). Functions, not top-level consts: composer.js is
 * re-injected into a page that already ran it. */
function fileChipSelector() {
  return '[role="group"][aria-label], [data-file-name], [title]';
}
/** The composer's own controls (the send and stop buttons, a voice button, a model or tool menu, an
 * attach label, a link). The title on one of them is its tooltip, never a file's name. */
function composerControlSelector() {
  const roles = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "checkbox", "radio", "combobox",
    "option", "tab", "textbox", "slider"].map(role => `[role="${role}"]`);
  return ["button", "a[href]", "input", "select", "textarea", "label", "summary", "[aria-haspopup]", ...roles,
    "#composer-submit-button", '[data-testid="send-button"]', '[data-testid="stop-button"]'].join(", ");
}
/** The file chips in a composer form: every element in a fileChipSelector shape, except a control
 * that is a chip only by its title (its tooltip: "Send prompt", "Start voice mode"). A named group or
 * a data-file-name tile is a chip whatever element renders it. The barrier and the verdict both read
 * this list, so neither takes a control's tooltip for a file (Ashlar, review of 5af999fd). */
function fileChips(form) {
  return [...form.querySelectorAll(fileChipSelector())]
    .filter(chip => chip.matches('[role="group"][aria-label], [data-file-name]') || !chip.matches(composerControlSelector()));
}
/** Every name a file chip gives its file, in its shapes' order (data-file-name, aria-label, title). */
function fileChipNames(chip) {
  return ["data-file-name", "aria-label", "title"].map(name => chip.getAttribute(name)).filter(name => name !== null);
}

/** A staged file's chip is still uploading while it (or anything in it) shows progress: a spinner, a
 * progress ring or bar, a busy or loading state, or an "uploading" label. Read inside the run's own
 * chips only: the composer's own "Upload files" control is not an upload in progress. */
function chipUploading(chip) {
  const busy = '[aria-busy="true"], [role="progressbar"], progress, [aria-valuenow], ' +
    '[data-state="uploading"], [data-state="loading"], [data-state="pending"], [data-status="uploading"], ' +
    '[class*="animate-spin"], [class*="spinner" i], [class*="loading" i], [class*="progress" i], ' +
    '[aria-label*="uploading" i], [aria-label*="loading" i], [aria-label*="업로드 중"], circle[stroke-dashoffset]';
  if (chip.matches(busy) || [...chip.querySelectorAll(busy)].some(renderedControl)) return true;
  return /uploading|업로드 중/i.test(chip.innerText ?? chip.textContent ?? "");
}

function attachmentsReady(form, names = []) {
  if (!form) return names.length === 0;
  const progress = form.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress, [data-state="uploading"], [class*="animate-spin"]');
  if ([...progress].some(renderedControl)) return false;
  const chips = fileChips(form).filter(renderedControl);
  return names.every(name => {
    const own = chips.filter(chip => fileChipNames(chip).includes(name));
    return own.length > 0 && !own.some(chipUploading);
  });
}

/** The alerts and toasts on the page that could report an upload's failure. */
function uploadAlerts() {
  return [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-testid*="toast" i], [class*="toast" i]')]
    .filter(renderedControl);
}

/** Remembered right before a file is staged, so an alert already on the page is never read as that
 * upload's failure. */
function markUploadAlerts() {
  const state = globalThis.__ashlarRunnerState;
  if (state) state.uploadAlertBaseline = new Set(uploadAlerts());
}

/** Why the page says a staged upload failed, or null: one of the run's chips in an error state, or an
 * alert or toast that appeared after the staging and reports an upload or file error (a temporary
 * chat or a plan that refuses files says so this way). Never a guess from a missing chip: that is
 * the window's job. */
function uploadFailure(form, names = []) {
  if (!names.length) return null;
  const failedChip = '[data-state="error"], [data-state="failed"], [data-status="error"], [aria-invalid="true"], [role="alert"]';
  for (const chip of form ? fileChips(form).filter(renderedControl) : []) {
    if (!names.some(name => fileChipNames(chip).includes(name))) continue;
    const error = [...chip.querySelectorAll(failedChip)].find(renderedControl) || (chip.matches(failedChip) ? chip : null);
    const said = (error?.innerText ?? error?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (error) return `its chip shows an error${said ? `: ${said.slice(0, 160)}` : ""}`;
  }
  const baseline = globalThis.__ashlarRunnerState?.uploadAlertBaseline;
  if (!baseline) return null;
  const about = /upload|file|attach|업로드|파일|첨부/i;
  const failed = /fail|unable|could ?n[o']t|can[' ]?no?t|not (?:supported|allowed|available)|error|rejected|실패|없습니다|불가|지원하지/i;
  for (const alert of uploadAlerts()) {
    if (baseline.has(alert)) continue;
    const text = (alert.textContent || "").replace(/\s+/g, " ").trim();
    if (about.test(text) && failed.test(text)) return text.slice(0, 200);
  }
  return null;
}

function normalizePrompt(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function submissionKey() {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.jobId || !state.runId) throw new Error("submission requires a persisted job/run binding");
  return `ashlar:submission:${state.jobId}:${state.runId}`;
}

function savedSubmission() {
  const text = sessionStorage.getItem(submissionKey());
  if (!text) return null;
  let record;
  try { record = JSON.parse(text); } catch { throw new Error("submission journal is unreadable; preserve the original tab"); }
  if (!record || !["prepared", "attempted", "sent"].includes(record.phase) ||
      typeof record.expected !== "string" || !record.expected || !Number.isSafeInteger(record.baseline) || record.baseline < 0) {
    throw new Error("submission journal is invalid; no prompt was sent again");
  }
  return record;
}

async function readSubmissionJournal() {
  for (;;) {
    try {
      const state = globalThis.__ashlarRunnerState;
      if (state?.confirmedSubmission?.key === submissionKey()) {
        retrySubmissionPersistence();
        return state.confirmedSubmission.record;
      }
      const record = savedSubmission();
      if (record?.phase === "sent" && state) {
        state.confirmedSubmission = {key: submissionKey(), record};
        state.submissionPersistencePending = false;
      }
      return record;
    }
    catch {
      // Local storage corruption does not establish that the provider failed.
      step("submission_unknown");
      await sleep(250);
    }
  }
}

function saveSubmission(record) {
  // A failed write must prevent the external click, not silently lose its identity.
  sessionStorage.setItem(submissionKey(), JSON.stringify(record));
}

/** After provider acceptance, bookkeeping failure must not abandon collection.
 * The durable attempted record already fences replay; keep the confirmed identity
 * in this page while retrying only its journal write, never the send operation.
 */
function retrySubmissionPersistence() {
  const state = globalThis.__ashlarRunnerState;
  if (!state?.submissionPersistencePending) return true;
  const confirmed = state.confirmedSubmission;
  if (!confirmed || confirmed.key !== submissionKey()) return false;
  try {
    saveSubmission(confirmed.record);
    state.submissionPersistencePending = false;
    step("submission_persisted");
    return true;
  } catch {
    step("submission_persistence_pending");
    return false;
  }
}

function userTurns() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')];
}

function step(stage) {
  if (typeof recordReviewStep === "function") recordReviewStep(stage);
}

function actionableSend(button) {
  if (!(button instanceof HTMLElement) || !button.isConnected || button.hidden ||
      button.disabled || button.getAttribute("aria-disabled") === "true") return false;
  if (!renderedControl(button) || !enabledLooking(button)) return false;
  return !stopLabelled(button);
}

function stopLabelled(button) {
  const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-testid") || ""}`;
  return /stop|abort|중지|停止/i.test(label);
}

/** A control a page disables by styling rather than by `disabled` (the live 1.1.29 Send took a click
 * during the upload and dropped it): data-disabled, a disabled data-state, or no pointer events. */
function enabledLooking(button) {
  const flag = button.getAttribute("data-disabled");
  if (flag !== null && flag !== "false") return false;
  if (button.getAttribute("data-state") === "disabled") return false;
  return getComputedStyle(button).pointerEvents !== "none";
}

/** The first actionable Send, by selector priority. Every match of a selector is tried (a stray or
 * leftover node may come first in DOM order). A selector that rendered a Send but no actionable one
 * ends the search: a looser selector must not find some other button to click while the real Send
 * says "not yet". */
function findEligibleSendButton(selectors) {
  const root = typeof composer === "function" ? composer()?.closest("form") || document : document;
  for (const selector of selectors) {
    let renderedDisabled = false;
    for (const button of root.querySelectorAll(selector)) {
      if (actionableSend(button)) return button;
      if (button instanceof HTMLElement && renderedControl(button) && !stopLabelled(button)) renderedDisabled = true;
    }
    if (renderedDisabled) return null;
  }
  return null;
}

/** The identity of the conversation this page shows: its URL without the fragment (the same rule
 * as json.js conversationIdentity). What is recorded from it is later compared with the location by
 * samePage (origin and path: json.js fixConversationHolds, tabOwnership; stillShowsConversation
 * below), never by exact equality. */
function shownConversation() {
  const href = globalThis.location?.href;
  return typeof href === "string" ? href.split("#")[0] : "";
}

/** Whether the page still shows `conversation` (json.js samePage when loaded: origin and path, the
 * query and fragment are not the page; else the exact identity). */
function stillShowsConversation(conversation) {
  return typeof samePage === "function" ? samePage(conversation, globalThis.location?.href) : conversation === shownConversation();
}

/** A prompt as ChatGPT's Markdown rendering shows it: fence and emphasis markers, heading and quote
 * markers dropped, whitespace collapsed (#93: a round-2 review prompt with Markdown never matched
 * its rendered turn, so the run ended send_unconfirmed although it was sent). */
function renderedPlain(text) {
  return normalizePrompt(String(text || "").replace(/```[\w+-]*/g, " ").replace(/[`*_~]/g, "").replace(/^\s*(?:#{1,6}|>)\s?/gm, "")).replace(/\s+/g, " ").trim();
}

/** Whether a rendered user turn holds a review prompt: the exact normalized text, or (Markdown having
 * restyled it) its plain rendering, whole or, for long prompts, both 160-character ends. */
function reviewTurnHolds(turnText, expected) {
  if (!expected) return false;
  if (normalizePrompt(turnText).includes(expected)) return true;
  const shown = renderedPlain(turnText), want = renderedPlain(expected);
  if (!want) return false;
  if (shown.includes(want)) return true;
  return want.length > 400 && shown.includes(want.slice(0, 160)) && shown.includes(want.slice(-160));
}

function submissionConfirmed(record) {
  const turns = userTurns();
  const state = globalThis.__ashlarRunnerState;
  const fix = state?.kind === "fix";
  // Composer clearing and Stop alone are not proof that THIS request was accepted. A fix turn must
  // be exactly its typed line (its file cards left out) and show its attachment (fixTurnSent); a
  // review turn, or a legacy fix journal with no lossless form (never proven exact: json.js
  // tabOwnership "unestablished"), contains its prompt.
  const match = turns.slice(record.baseline).find(turn => fix && typeof record.exact === "string" ? fixTurnSent(turn, record) :
    reviewTurnHolds(messagePromptText(turn), record.expected));
  if (!record.expected || !match) return false;
  record.phase = "sent";
  record.submittedUsers = turns.indexOf(match) + 1;
  record.messageId = match.getAttribute("data-message-id") || "";
  // A run's conversation is a fact of THIS moment: recorded once, here, and never later (every
  // later decision compares the location with it). Only a send this page instance clicked,
  // confirmed while the page still shows the conversation it was clicked in, establishes it. A
  // confirmation seen only after a reload (the click belonged to an earlier page) or under another
  // location (an in-page move can leave the old DOM rendering the sent turn) proves the send, not
  // which conversation holds it: no identity is recorded (a fix is then `identity:"unestablished"`
  // in json.js: never harvested, never closed). A FIX always records it here. A REVIEW records it
  // here only when it was sent on a page that names a conversation, with its exact prompt (the rule
  // its release verdict holds a recorded conversation to): a review sent on a new chat has no
  // conversation yet and pins where the provider puts it (json.js pinNewChatReview, #82).
  const attempt = state?.sendAttempt;
  const reviewNamed = !fix && typeof namesNoConversation === "function" && Boolean(attempt?.conversation) &&
    !namesNoConversation(attempt.conversation) && normalizePrompt(messagePromptText(match)) === record.expected;
  if ((fix || reviewNamed) && !record.conversation && attempt?.key === submissionKey() && attempt.conversation &&
      stillShowsConversation(attempt.conversation)) {
    record.conversation = attempt.conversation;
  }
  state.confirmedSubmission = {key: submissionKey(), record};
  state.submissionPersistencePending = true;
  step("prompt_submitted");
  retrySubmissionPersistence();
  return true;
}

/** Diagnostic (1.1.31, live send_unconfirmed on a temporary-chat fix with its attachment): the
 * shape of the page's last user turn at about 1, 5, 15, 30 and 60 s after a fix's Send click.
 * Stored locally only (chrome.storage.local "sendProbes", last 20). Never raw text: lengths, an
 * 8-hex hash of the first 40 characters, match flags, counts and a URL shape. Off with
 * chrome.storage.local {sendProbe:false}. A probe never affects the run. */
function sendProbeHash(text) {
  let hash = 0x811c9dc5;
  for (const ch of String(text ?? "")) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}
function sendProbeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "/" : u.pathname.startsWith("/c/") ? "/c/*" : `/${u.pathname.split("/")[1] || ""}/*`;
    return `${u.host}${path}${u.searchParams.has("temporary-chat") ? `?temporary-chat=${u.searchParams.get("temporary-chat") === "true"}` : ""}`;
  } catch { return "unparsable"; }
}
function sendProbeShape(record, clickedAt, label) {
  const turns = userTurns(), names = record.attachments || [];
  const userSections = [...document.querySelectorAll('[data-turn="user"]')];
  const shape = {at: Date.now(), label, sinceClickMs: Date.now() - clickedAt, url: sendProbeUrl(globalThis.location?.href),
    before: record.baseline, users: turns.length, grew: turns.length > record.baseline, userSections: userSections.length,
    sections: document.querySelectorAll('[data-testid^="conversation-turn"]').length, attachments: names.length};
  const last = turns.at(-1) || userSections.at(-1);
  if (!last) return shape;
  const container = turnContainer(last);
  const {cards, shown} = turnAttachments(last, names);
  const text = messagePromptText(last), withoutCards = messagePromptText(last, cards);
  const exact = typeof record.exact === "string" ? record.exact : "";
  shape.last = {byRole: turns.includes(last), container: container === last ? "turn" : "section",
    chips: [...container.querySelectorAll(fileChipSelector())].filter(chip => !chip.matches(composerControlSelector())).length,
    cards: cards.size, cardInTurn: [...cards].some(card => last.contains(card)), namesAttachment: names.length > 0 && shown,
    nameInContainer: names.some(name => (container.textContent || "").includes(name)),
    textLength: text.length, textHead: sendProbeHash(text.slice(0, 40)),
    withoutCardsLength: withoutCards.length, withoutCardsHead: sendProbeHash(withoutCards.slice(0, 40)),
    expectedLength: exact.length, expectedHead: sendProbeHash(exact.slice(0, 40)),
    exact: fixPromptForm(text) === exact, normalized: normalizePrompt(text) === record.expected,
    contains: normalizePrompt(text).includes(record.expected), chipExcluded: fixTurnHolds(last, exact, names),
    sent: fixTurnSent(last, record)};
  return shape;
}
async function startSendProbe(record) {
  try {
    const local = globalThis.chrome?.storage?.local;
    if (!local) return;
    if ((await local.get(["sendProbe"]))?.sendProbe === false) return;
    const state = globalThis.__ashlarRunnerState;
    const clickedAt = record.attemptedAt || Date.now(), job = state?.jobId, run = state?.runId;
    const save = async label => {
      try {
        const shape = {job, run, ...sendProbeShape(record, clickedAt, label)};
        globalThis.__ashlarSendProbeWrites = (globalThis.__ashlarSendProbeWrites || Promise.resolve()).then(async () => {
          const stored = (await local.get(["sendProbes"]))?.sendProbes;
          await local.set({sendProbes: [...(Array.isArray(stored) ? stored : []), shape].slice(-20)});
        }).catch(() => {});
        await globalThis.__ashlarSendProbeWrites;
      } catch { /* diagnostics never affect the run */ }
    };
    for (const seconds of [1, 5, 15, 30, 60]) setTimeout(() => save(`${seconds}s`), Math.max(0, clickedAt + seconds * 1000 - Date.now()));
    // HTML snapshot of the conversation area (the user asked for the live DOM, #93): fix runs only,
    // which carry Ashlar's own prompt. Scripts, styles and SVG paths are dropped; capped; last 3 kept.
    if (state?.kind === "fix" && (await local.get(["sendProbeHtmlOff"]))?.sendProbeHtmlOff !== true) {
      for (const seconds of [5, 60]) setTimeout(() => {
        try {
          const area = document.querySelector("main") || document.body;
          const clone = area.cloneNode(true);
          for (const node of clone.querySelectorAll("script,style,noscript,svg path,img")) node.remove();
          const html = clone.outerHTML.slice(0, 200_000);
          globalThis.__ashlarSendProbeWrites = (globalThis.__ashlarSendProbeWrites || Promise.resolve()).then(async () => {
            const stored = (await local.get(["sendProbeHtml"]))?.sendProbeHtml;
            const list = Array.isArray(stored) ? stored : [];
            await local.set({sendProbeHtml: [...list, {job, run, label: `${seconds}s`, at: Date.now(), url: location.href.split("?")[0], html}].slice(-3)});
          }).catch(() => {});
        } catch { /* diagnostics never affect the run */ }
      }, Math.max(0, clickedAt + seconds * 1000 - Date.now()));
    }
  } catch { /* diagnostics never affect the run */ }
}

async function clickSend(findSend, findComposer, expectedText) {
  let record = await readSubmissionJournal();
  // A fix journal also carries its prompt's lossless form (`exact`, fixPromptForm): the draft is sent
  // only while it holds exactly that, and the sent turn is later proven against it (json.js
  // journaledTurnIntegrity). The whitespace-normalized `expected` only locates the sent turn.
  const fix = globalThis.__ashlarRunnerState?.kind === "fix";
  if (!record) {
    const expected = normalizePrompt(expectedText || readComposer(findComposer()));
    if (!expected) throw new Error("cannot submit an empty review prompt");
    record = {phase: "prepared", expected, ...(fix ? {exact: fixPromptForm(expectedText)} : {}),
      baseline: userTurns().length, attachments: [...(globalThis.__ashlarRunnerState?.pendingAttachments || [])]};
    saveSubmission(record);
    step("prompt_prepared");
  }
  // The window after a Send click for its user turn to render. Past it the click was not taken (e.g.
  // ChatGPT dropping a click mid-upload): the run ends as send_unconfirmed, never re-sent.
  const CONFIRM_MS = 60 * 1000;
  let attemptSeen = null;
  for (;;) {
    if (record.phase === "sent" || submissionConfirmed(record)) return;
    // After the confirmation check, so an accepted send is still journaled as sent; before any
    // click, so a stopped run never submits its prompt.
    globalThis.throwIfStopped?.();
    if (typeof quotaHit === "function" && quotaHit()) {
      const error = new Error("provider usage limit before submission"); error.code = "quota"; throw error;
    }
    if (record.phase === "attempted") {
      // Delivery is ambiguous. Never automatically replay a possibly accepted prompt.
      step("send_unconfirmed");
      attemptSeen ??= Number.isSafeInteger(record.attemptedAt) ? record.attemptedAt : Date.now();
      if (Date.now() - attemptSeen >= CONFIRM_MS) {
        const error = new Error(`Send was clicked but no sent turn appeared within ${CONFIRM_MS / 1000} seconds; ` +
          "the prompt is not sent again; inspect the tab");
        error.code = "send_unconfirmed";
        throw error;
      }
    } else {
      const editor = findComposer(), button = findSend();
      const form = editor?.closest("form");
      const failed = uploadFailure(form, record.attachments || []);
      if (failed) {
        const error = new Error(`the page reported an attachment upload failed (${failed}); nothing was sent`);
        error.code = "attachment_failed";
        throw error;
      }
      const uploadBusy = !attachmentsReady(form, record.attachments || []);
      step(uploadBusy ? "attachments_waiting" : "send_waiting");
      const otherTurn = userTurns().length !== record.baseline;
      const drafted = normalizePrompt(readComposer(editor)) === record.expected;
      // A fix draft that is the prompt only once whitespace is collapsed (or a fix journal with no
      // lossless form to check it against) is never sent.
      if (fix && drafted && !composerHoldsFix(editor, record.exact)) throw fixPromptAltered();
      if (!uploadBusy && !otherTurn && drafted && actionableSend(button) &&
          !(typeof stopButtonVisible === "function" && stopButtonVisible())) {
        record.phase = "attempted";
        record.attemptedAt = Date.now();
        saveSubmission(record); // durable intent BEFORE invoking the site's handler
        // In memory only: the conversation this page instance clicked in (submissionConfirmed
        // records it once the send is proven, and only if the page still shows it then). The
        // fresh-page fence (json.js throwIfStopped) ends here: the provider moves the page after a send.
        const runner = globalThis.__ashlarRunnerState;
        if (runner) { runner.sendAttempt = {key: submissionKey(), conversation: shownConversation()}; runner.freshPage = undefined; }
        step("send_attempted");
        try { button.click(); } catch { /* Ambiguous click stays observable, never replayed. */ }
        if (fix) startSendProbe(record);
      }
    }
    // Cadence only: no upload, send acknowledgement, queue or model deadline.
    await waitForPageChange(250);
  }
}

async function resumeSubmission(findSend, findComposer, prompt) {
  const record = await readSubmissionJournal();
  if (record) return clickSend(findSend, findComposer, record.expected);
  // Legacy pages have no durable send journal. Observe, but never guess and re-send.
  const expected = normalizePrompt(promptParts(prompt).prompt);
  for (;;) {
    globalThis.throwIfStopped?.();
    const turns = userTurns();
    if (turns.length && (!expected || normalizePrompt(messagePromptText(turns.at(-1))).includes(expected))) {
      step("legacy_observation"); return;
    }
    step("submission_unknown");
    if (typeof quotaHit === "function" && quotaHit()) {
      const error = new Error("provider usage limit"); error.code = "quota"; throw error;
    }
    await sleep(250);
  }
}

async function waitUntilComposer(deadline = Date.now() + 3 * 60 * 1000) {
  // Pre-send bound, not a generation timeout: a page that never renders a composer (a stale model
  // URL, a logged-out landing, a changed selector) fails the run as presend_stalled so the job retries
  // or settles (live 1.1.32: 10+ min in composer_waiting under the old 3 h backstop). Generation
  // itself stays unbounded elsewhere.
  for (;;) {
    globalThis.throwIfStopped?.();
    if (typeof quotaHit === "function" && quotaHit()) {
      const e = new Error("usage limit");
      e.code = "quota";
      throw e;
    }
    const el = composer();
    if (el) return el;
    if (Date.now() >= deadline) throw presendStalled("composer");
    await waitForPageChange(1000);
  }
}

function presendStalled(stage) {
  const e = new Error(`presend_stalled: the pre-send stage "${stage}" did not finish in time; nothing was sent`);
  e.code = "presend_stalled";
  e.stage = stage;
  return e;
}

/** `work(deadline)` bounded by `ms`: past it the run fails as presend_stalled(stage), or, with
 * `onExpire`, resolves to its value. The work is also handed the deadline, so a late copy stops
 * clicking on its own. Deadlines are wall clock: a throttled background tab only checks late. */
async function presendBound(stage, ms, work, onExpire) {
  const deadline = Date.now() + ms;
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => (onExpire ? resolve(onExpire()) : reject(presendStalled(stage))), ms);
  });
  try { return await Promise.race([work(deadline), expired]); }
  finally { clearTimeout(timer); }
}

/** Everything a new run does before typing: overlays, the composer, the reasoning level. Every stage
 * is bounded and records its own step, so a stall shows where it stopped. Locals, not top-level
 * consts: the worker re-injects this file into a page that already ran it, and a redeclared global
 * lexical binding aborts the whole script. */
async function preparePresend(provider, reasoning, openComposer) {
  const OVERLAYS_MS = 60 * 1000, COMPOSER_MS = 3 * 60 * 1000, REASONING_MS = 60 * 1000;
  const overlays = () => { step("overlays_dismissing"); return presendBound("overlays", OVERLAYS_MS, () => dismissOverlays()); };
  try {
    await overlays();
    step("composer_waiting");
    let el = await presendBound("composer", COMPOSER_MS, deadline => openComposer(deadline));
    step("composer_ready");
    await overlays();
    step("reasoning_selecting");
    const picked = await presendBound("reasoning", REASONING_MS, deadline => selectReasoning(provider, reasoning, deadline), () => "skipped");
    if (picked === "skipped") step("reasoning_skipped");
    await overlays();
    el = composer() || el;
    return el;
  } catch (e) {
    if (e?.code === "presend_stalled") savePresendStallHtml(e.stage);
    throw e;
  }
}

/** Diagnostic: the page as a pre-send stall left it, in chrome.storage.local "presendStallHtml" (last
 * 3). The main area (or body) without scripts, styles, images and SVG paths, capped at 200 KB; the
 * URL without its query. Off with {presendStallHtmlOff:true}. Never affects the run. */
function savePresendStallHtml(stage) {
  try {
    const local = globalThis.chrome?.storage?.local;
    if (!local) return;
    const state = globalThis.__ashlarRunnerState;
    const area = document.querySelector("main") || document.body;
    const clone = area.cloneNode(true);
    for (const node of clone.querySelectorAll("script,style,noscript,img,svg path")) node.remove();
    const record = {job: state?.jobId, run: state?.runId, stage, at: Date.now(),
      url: String(globalThis.location?.href || "").split(/[?#]/)[0], html: clone.outerHTML.slice(0, 200_000)};
    globalThis.__ashlarPresendWrites = (globalThis.__ashlarPresendWrites || Promise.resolve()).then(async () => {
      const flags = await local.get(["presendStallHtmlOff", "presendStallHtml"]);
      if (flags?.presendStallHtmlOff === true) return;
      const list = Array.isArray(flags?.presendStallHtml) ? flags.presendStallHtml : [];
      await local.set({presendStallHtml: [...list, record].slice(-3)});
    }).catch(() => {});
  } catch { /* diagnostics never affect the run */ }
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const el = fn();
    if (el) return el;
    await sleep(250);
  }
  throw new Error(label);
}
