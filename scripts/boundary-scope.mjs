// Sub-file scopes for the local-LLM edit boundary (scripts/check-local-llm-boundary.mjs). A path-level
// allowlist cannot say "only this function of a shared file"; these helpers compare a file's base and
// working versions against such a scope, so an edit outside it (e.g. the frozen chat fix transport or
// loop control in review-loop-runtime.server.ts) still trips the boundary.
//
// Both checks compare whole file texts, never `git diff` output: a diff that Git reports as binary,
// or rewrites through a diff driver, cannot hide an edit. Declarations are located by the TypeScript
// parser (syntactic extent, not a line pattern), and a file that does not parse fails closed.
import ts from "typescript";

// The base blob is canonical LF text; a text checkout may carry CRLF. Compare both as LF so a
// line-ending conversion alone is never an edit (and never hides one: content still compares exactly).
const lf = (text) => String(text).replace(/\r\n/g, "\n");

function parse(text, file) {
  const sf = ts.createSourceFile(file, String(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    const d = diags[0];
    throw new Error(`does not parse (${ts.flattenDiagnosticMessageText(d.messageText, " ")})`);
  }
  return sf;
}

function declName(stmt) {
  if (ts.isFunctionDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return stmt.name?.text;
  }
  return undefined;
}

/** The file text with each named top-level declaration (its JSDoc included) replaced by a placeholder.
 * Throws when the text does not parse, or a named declaration is missing or declared twice. */
export function maskDeclarations(text, names, file = "scoped.ts") {
  const sf = parse(text, file);
  const want = new Set(names);
  const spans = [];
  const seen = new Map();
  for (const stmt of sf.statements) {
    const name = declName(stmt);
    if (!name || !want.has(name)) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    spans.push({ name, start: stmt.getStart(sf, true), end: stmt.end });
  }
  for (const name of want) {
    const n = seen.get(name) ?? 0;
    if (n !== 1) throw new Error(n ? `declares \`${name}\` ${n} times` : `has no top-level \`${name}\``);
  }
  let out = sf.text;
  for (const s of spans.sort((a, b) => b.start - a.start)) out = `${out.slice(0, s.start)}/*<scoped ${s.name}>*/${out.slice(s.end)}`;
  return out;
}

/** null when `newText` differs from `oldText` only inside the named top-level declarations;
 * otherwise the reason. Fails closed: a parse error or a missing declaration is a violation. */
export function outsideDeclarations(oldText, newText, names, file = "scoped.ts") {
  let a, b;
  oldText = lf(oldText); newText = lf(newText);
  try { a = maskDeclarations(oldText, names, file); } catch (e) { return `base version ${e.message}`; }
  try { b = maskDeclarations(newText, names, file); } catch (e) { return `working version ${e.message}`; }
  if (a === b) return null;
  const al = a.split("\n"), bl = b.split("\n");
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  return `edits outside ${names.map((n) => `\`${n}\``).join(", ")} (near line ${i + 1} with the scoped declarations masked)`;
}

/** null when `newText` keeps every line of `oldText`, in order (only additions); otherwise the reason. */
export function notAdditionsOnly(oldText, newText) {
  const oldLines = lf(oldText).split("\n"), newLines = lf(newText).split("\n");
  let j = 0;
  for (let i = 0; i < oldLines.length; i++) {
    while (j < newLines.length && newLines[j] !== oldLines[i]) j++;
    if (j === newLines.length) return `changes or removes existing line ${i + 1}; only additions are allowed`;
    j++;
  }
  return null;
}
