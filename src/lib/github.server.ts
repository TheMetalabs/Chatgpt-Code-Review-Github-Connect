import { createPrivateKey } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as https from "node:https";
import { SignJWT } from "jose";
import { isSafeRepoPath, policyPathsFor, snapshotFileRef } from "./github-snapshot";
import { getSecrets, normalizePem } from "./secrets.server";
import type { GithubReady, PostedComment, SamplePr, SnapshotFile } from "./types";

const GH_HOST = "api.github.com";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200_000;

export type GithubCreds = {
  appId: string;
  clientId: string;
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
  const clientId = pick(stored.githubClientId, process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID);
  const webhookSecret = pick(stored.githubWebhookSecret, process.env.GITHUB_WEBHOOK_SECRET);
  const key = pick(stored.githubPrivateKey, process.env.GITHUB_APP_PRIVATE_KEY);
  return {
    appId: appId.value,
    clientId: clientId.value,
    webhookSecret: webhookSecret.value,
    privateKey: normalizePem(key.value),
    from: {
      appId: appId.from,
      clientId: clientId.from,
      webhookSecret: webhookSecret.from,
      privateKey: key.from,
    },
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
    clientId: Boolean(c.clientId),
    privateKey: Boolean(c.privateKey),
    appIdValue: c.appId,
    clientIdValue: c.clientId,
    jwtIssuer: c.clientId || c.appId ? (c.clientId ? "client_id" : "app_id") : "missing",
    from: c.from,
  };
}

export function formatGithubError(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 240);
  const parts = [e.message];
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(cause.message);
    const code = (cause as NodeJS.ErrnoException).code;
    if (code) parts.push(String(code));
  } else if (cause) {
    parts.push(String(cause));
  }
  const code = (e as NodeJS.ErrnoException).code;
  if (code) parts.push(String(code));
  return [...new Set(parts.filter(Boolean))].join(" · ").slice(0, 240);
}

type GhRes = { status: number; text: string };

async function resolveGithubHost(): Promise<{ hostname: string; servername?: string; family?: 4 | 6 }> {
  for (const family of [undefined, 4, 6] as const) {
    try {
      const r = await dnsLookup(GH_HOST, family ? { family } : {});
      return { hostname: r.address, servername: GH_HOST, family: r.family === 6 ? 6 : 4 };
    } catch {
      /* try next lookup mode */
    }
  }
  return { hostname: GH_HOST };
}

/** Bypass Vite/Nitro-patched fetch. Resolve IPv4 then IPv6; never require A-records only. */
async function ghHttps(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 20_000,
): Promise<GhRes> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const resolved = await resolveGithubHost();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: resolved.hostname,
        servername: resolved.servername ?? GH_HOST,
        path: p,
        method,
        ...(resolved.family ? { family: resolved.family } : {}),
        headers: {
          Host: GH_HOST,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ashlar-bot",
          ...headers,
          ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("GitHub API timeout"));
    });
    req.on("error", (err) => reject(new Error(formatGithubError(err))));
    if (body) req.write(body);
    req.end();
  });
}

async function appJwt(): Promise<string> {
  const c = githubCreds();
  const issuer = c.clientId || c.appId;
  if (!issuer || !c.privateKey) throw new Error("GitHub App credentials missing");
  const key = createPrivateKey(c.privateKey);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setIssuer(issuer)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
}

export async function installationToken(installationId: number): Promise<string> {
  let jwt: string;
  try {
    jwt = await appJwt();
  } catch (e) {
    throw new Error(`app jwt: ${formatGithubError(e)}`);
  }
  let out: GhRes;
  try {
    out = await ghHttps("POST", `/app/installations/${installationId}/access_tokens`, {
      Authorization: `Bearer ${jwt}`,
    });
  } catch (e) {
    throw new Error(`installation token fetch: ${formatGithubError(e)}`);
  }
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`installation token ${out.status}: ${out.text.slice(0, 180)}`);
  }
  const body = (out.text ? JSON.parse(out.text) : {}) as { token?: string };
  if (!body.token) throw new Error("installation token missing");
  return body.token;
}

export async function probeGithub(installationId?: number): Promise<{
  ok: boolean;
  jwtIssuer: GithubReady["jwtIssuer"];
  app?: { id?: number; slug?: string; name?: string };
  installation?: { id: number };
  error?: string;
}> {
  const ready = githubReady();
  try {
    const jwt = await appJwt();
    const app = await ghHttps("GET", "/app", { Authorization: `Bearer ${jwt}` });
    if (app.status < 200 || app.status >= 300) {
      return {
        ok: false,
        jwtIssuer: ready.jwtIssuer,
        error: `GET /app ${app.status}: ${app.text.slice(0, 180)}`,
      };
    }
    const data = (app.text ? JSON.parse(app.text) : {}) as { id?: number; slug?: string; name?: string };
    if (installationId) {
      await installationToken(installationId);
      return {
        ok: true,
        jwtIssuer: ready.jwtIssuer,
        app: data,
        installation: { id: installationId },
      };
    }
    return { ok: true, jwtIssuer: ready.jwtIssuer, app: data };
  } catch (e) {
    return { ok: false, jwtIssuer: ready.jwtIssuer, error: formatGithubError(e) };
  }
}

async function gh<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  let out: GhRes;
  try {
    out = await ghHttps(
      init?.method ?? "GET",
      path,
      {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
      init?.body,
    );
  } catch (e) {
    return { ok: false, status: 0, text: formatGithubError(e) };
  }
  if (out.status < 200 || out.status >= 300) return { ok: false, status: out.status, text: out.text.slice(0, 400) };
  return { ok: true, data: (out.text ? JSON.parse(out.text) : {}) as T };
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
  if (!out.ok || !out.data.head?.sha) {
    throw new Error(out.ok ? "could not load pull request" : `could not load pull request (${out.status}): ${out.text}`);
  }
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
  if (!filesOut.ok) throw new Error(`could not load pull files (${filesOut.status}): ${filesOut.text}`);
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

export type GithubReaction = "eyes" | "+1" | "confused";

/** Ack on the triggering comment, or on the PR when there isn't one. Failures are non-fatal. */
export async function reactOnDelivery(
  token: string,
  job: { owner: string; repo: string; pr: number; thread?: { kind?: string; commentId?: number } },
  content: GithubReaction,
): Promise<void> {
  const commentId = job.thread?.commentId;
  const path =
    commentId && job.thread?.kind === "followup"
      ? `/repos/${job.owner}/${job.repo}/pulls/comments/${commentId}/reactions`
      : commentId
        ? `/repos/${job.owner}/${job.repo}/issues/comments/${commentId}/reactions`
        : `/repos/${job.owner}/${job.repo}/issues/${job.pr}/reactions`;
  const out = await gh(token, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!out.ok && out.status !== 409 && out.status !== 422) {
    throw new Error(`reaction ${content} ${out.status}: ${out.text}`);
  }
}

