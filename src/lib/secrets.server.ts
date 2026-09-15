import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPrivateKey } from "node:crypto";

export type StoredSecrets = {
  githubAppId: string;
  githubClientId: string;
  githubWebhookSecret: string;
  githubPrivateKey: string;
};

const EMPTY: StoredSecrets = {
  githubAppId: "",
  githubClientId: "",
  githubWebhookSecret: "",
  githubPrivateKey: "",
};

function secretsPath() {
  return join(process.cwd(), ".data", "ashlar-secrets.json");
}

let cache: StoredSecrets | null = null;

function readDisk(): StoredSecrets {
  try {
    const raw = readFileSync(secretsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSecrets>;
    return {
      githubAppId: String(parsed.githubAppId ?? "").trim(),
      githubClientId: String(parsed.githubClientId ?? "").trim(),
      githubWebhookSecret: String(parsed.githubWebhookSecret ?? "").trim(),
      githubPrivateKey: String(parsed.githubPrivateKey ?? "").trim(),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function getSecrets(): StoredSecrets {
  if (!cache) cache = readDisk();
  return cache;
}

function writeDisk(next: StoredSecrets) {
  const dir = dirname(secretsPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(secretsPath(), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  cache = next;
}

export function normalizePem(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  return t.includes("\\n") ? t.replace(/\\n/g, "\n") : t;
}

export function pemIsUsable(raw: string): boolean {
  try {
    createPrivateKey(normalizePem(raw));
    return true;
  } catch {
    return false;
  }
}

export function patchGithubSecrets(patch: {
  githubAppId?: string;
  githubClientId?: string;
  githubWebhookSecret?: string;
  githubPrivateKey?: string;
}): { ok: true } | { ok: false; error: string } {
  const current = getSecrets();
  const next: StoredSecrets = { ...current };
  if (typeof patch.githubAppId === "string") next.githubAppId = patch.githubAppId.trim();
  if (typeof patch.githubClientId === "string") next.githubClientId = patch.githubClientId.trim();
  if (typeof patch.githubWebhookSecret === "string" && patch.githubWebhookSecret.trim()) {
    next.githubWebhookSecret = patch.githubWebhookSecret.trim();
  }
  if (typeof patch.githubPrivateKey === "string" && patch.githubPrivateKey.trim()) {
    const pem = normalizePem(patch.githubPrivateKey);
    if (!pemIsUsable(pem)) return { ok: false, error: "private key is not a usable PEM" };
    next.githubPrivateKey = pem;
  }
  writeDisk(next);
  return { ok: true };
}

export function clearGithubSecrets() {
  writeDisk({ ...EMPTY });
}
