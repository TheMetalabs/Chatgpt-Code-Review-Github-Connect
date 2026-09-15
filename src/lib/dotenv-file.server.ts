import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function envFilePath() {
  return join(process.cwd(), ".env");
}

export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value) && !value.includes("\n")) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let v = line.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[key] = v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** Replace existing keys in-place; append the rest. `undefined` values are skipped. */
export function upsertEnvText(text: string, patch: Record<string, string | undefined>): string {
  const pending = new Map<string, string>();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    pending.set(k, v);
  }
  const lines = (text.endsWith("\n") || text === "" ? text : `${text}\n`).split(/(?<=\n)/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    const key = eq > 0 && !trimmed.startsWith("#") ? trimmed.slice(0, eq).trim() : "";
    if (key && pending.has(key)) {
      out.push(`${key}=${quoteEnvValue(pending.get(key)!)}\n`);
      pending.delete(key);
    } else {
      out.push(line);
    }
  }
  let body = out.join("");
  if (pending.size) {
    if (body && !body.endsWith("\n")) body += "\n";
    for (const [k, v] of pending) body += `${k}=${quoteEnvValue(v)}\n`;
  }
  return body;
}

let loaded = false;

export function resetDotenvLoadedForTests() {
  loaded = false;
}

export function loadDotenvFile(file = envFilePath()) {
  if (loaded) return;
  loaded = true;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const parsed = parseEnvText(text);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}

export function writeEnvPatch(patch: Record<string, string | undefined>, file = envFilePath()) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "# Local only. gitignored. Written by Ashlar Settings.\n";
  }
  const next = upsertEnvText(text, patch);
  writeFileSync(file, next, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    process.env[k] = v;
  }
}
