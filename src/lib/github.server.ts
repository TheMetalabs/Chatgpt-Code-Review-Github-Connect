import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import { isSafeRepoPath, policyPathsFor, snapshotFileRef } from "./github-snapshot";
import { getSecrets, normalizePem } from "./secrets.server";
import type { GithubReady, PostedComment, SamplePr, SnapshotFile } from "./types";

const GH = "https://api.github.com";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200_000;

export type GithubCreds = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
};

type CredSource = "ui" | "env" | "missing";

function pick(ui: string, envVal: string | undefined): { value: string; from: CredSource } {
  if (ui.trim()) return { value: ui.trim(), from: "ui" };
  const env = envVal?.trim() ?? "";
  if (env) return { value: env, from: "env" };
  return { value: "", from: "missing" };
}

export function githubCreds(): GithubCreds & { from: GithubReady["from"] } {
  const stored = getSecrets();
  const appId = pick(stored.githubAppId, process.env.GITHUB_APP_ID);
  const webhookSecret = pick(stored.githubWebhookSecret, process.env.GITHUB_WEBHOOK_SECRET);
  const key = pick(stored.githubPrivateKey, process.env.GITHUB_APP_PRIVATE_KEY);
  return {
    appId: appId.value,
    webhookSecret: webhookSecret.value,
    privateKey: normalizePem(key.value),
    from: { appId: appId.from, webhookSecret: webhookSecret.from, privateKey: key.from },
  };
}

export function githubWebhookSecret(): string {
  return githubCreds().webhookSecret;
}

export function githubReady(): GithubReady {
  const c = githubCreds();
  return {
    webhookSecret: Boolean(c.webhookSecret),
    appId: Boolean(c.appId),
    privateKey: Boolean(c.privateKey),
    appIdValue: c.appId,
    from: c.from,
  };
}

async function appJwt(): Promise<string> {
  const c = githubCreds();
  if (!c.appId || !c.privateKey) throw new Error("GitHub App credentials missing");
  const key = createPrivateKey(c.privateKey);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(c.appId)
    .setExpirationTime("9m")
    .sign(key);
}

export async function installationToken(installationId: number): Promise<string> {
  const jwt = await appJwt();
  const res = await fetch(`${GH}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ashlar-bot",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`installation token ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("installation token missing");
  return body.token;
}

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ashlar-bot",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 400) };
  return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
}

export async function fetchPullHead(
  token: string,
  owner: string,
  repo: string,
  pr: number,
): Promise<{ headSha: string; baseSha: string; title: string; draft: boolean; fork: boolean; body: string }> {
  const out = await gh<{
    title?: string;
    draft?: boolean;
    body?: string | null;
    head?: { sha?: string; repo?: { fork?: boolean } | null };
    base?: { sha?: string };
  }>(token, `/repos/${owner}/${repo}/pulls/${pr}`);
  if (!out.ok || !out.data.head?.sha) throw new Error("could not load pull request");
  if (!out.data.base?.sha) throw new Error("pull request missing base sha");
  return {
    headSha: out.data.head.sha,
    baseSha: out.data.base.sha,
    title: String(out.data.title ?? `PR #${pr}`),
    draft: Boolean(out.data.draft),
    fork: Boolean(out.data.head.repo?.fork),
    body: String(out.data.body ?? ""),
  };
}

function langFor(path: string): SnapshotFile["language"] {
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".json")) return "json";
  return "ts";
}

async function getFile(token: string, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  const safe = isSafeRepoPath(path);
  if (!safe) return null;
  const out = await gh<{ content?: string; encoding?: string; size?: number; type?: string }>(
    token,
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(safe).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`,
  );
  if (!out.ok) return null;
  if (out.data.type !== "file") return null;
  if ((out.data.size ?? 0) > MAX_FILE_BYTES) return null;
  if (out.data.encoding === "base64" && out.data.content) {
    return Buffer.from(out.data.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return null;
}

export async function fetchPullSnapshot(
  token: string,
  target: {
    owner: string;
    repo: string;
    pr: number;
    title: string;
    headSha: string;
    baseSha: string;
    sender: string;
    isFork: boolean;
    isDraft: boolean;
  },
): Promise<SamplePr> {
  const filesOut = await gh<Array<{ filename?: string; status?: string; patch?: string }>>(
    token,
    `/repos/${target.owner}/${target.repo}/pulls/${target.pr}/files?per_page=100`,
  );
  if (!filesOut.ok) throw new Error("could not load pull files");
  const changedPaths = filesOut.data
    .map((f) => f.filename)
    .filter((p): p is string => Boolean(p))
    .slice(0, MAX_FILES);
  const policyPaths = policyPathsFor(changedPaths);
  const toFetch = [...new Set([...changedPaths, ...policyPaths])];
  const files: SnapshotFile[] = [];
  for (const path of toFetch) {
    const ref = snapshotFileRef(path, policyPaths, target.baseSha, target.headSha);
    const content = await getFile(token, target.owner, target.repo, path, ref);
    if (content == null) continue;
    files.push({ path, content, language: langFor(path) });
  }
  const diff = filesOut.data
    .filter((f) => f.filename && changedPaths.includes(f.filename))
    .map((f) => `--- ${f.filename}\n${f.patch ?? ""}`)
    .join("\n\n")
    .slice(0, 80_000);
  let body = "";
  try {
    const pull = await fetchPullHead(token, target.owner, target.repo, target.pr);
    body = pull.body;
  } catch {
    /* body is untrusted and optional */
  }
  return {
    key: `gh-${target.owner}-${target.repo}-${target.pr}`,
    owner: target.owner,
    repo: target.repo,
    pr: target.pr,
    title: target.title,
    body,
    sender: target.sender,
    headSha: target.headSha,
    baseSha: target.baseSha,
    isFork: target.isFork,
    isDraft: target.isDraft,
    labels: [],
    files,
    diff,
    changedPaths,
  };
}

export async function createPullReview(
  token: string,
  opts: {
    owner: string;
    repo: string;
    pr: number;
    headSha: string;
    event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
    body: string;
    comments: PostedComment[];
  },
): Promise<{ id: number }> {
  const out = await gh<{ id?: number }>(token, `/repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commit_id: opts.headSha,
      event: opts.event,
      body: opts.body,
      comments: opts.comments.map((c) => ({
        path: c.file,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    }),
  });
  if (!out.ok) throw new Error(`GitHub Reviews API ${out.status}: ${out.text}`);
  if (!out.data.id) throw new Error("review missing id");
  return { id: out.data.id };
}