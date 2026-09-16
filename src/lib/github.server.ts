import { createPrivateKey } from "node:crypto";
import { Resolver, lookup as dnsLookup } from "node:dns/promises";
import * as https from "node:https";
import { SignJWT } from "jose";
import { isSafeRepoPath, isSandboxPolicyFile, policyPathsFor, snapshotFileRef } from "./github-snapshot";
import { isReviewLineError } from "./review-diff";
import { parseDohA } from "./github-dns";
import { ashlarPublicHost, ashlarWebhookUrl } from "./ashlar-env";
import { getSecrets, normalizePem } from "./secrets.server";
import type { ForkStatus, GithubReady, PostedComment, SamplePr, SnapshotFile } from "./types";

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
    publicHost: ashlarPublicHost() || undefined,
    webhookUrl: ashlarWebhookUrl() || undefined,
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
type ResolvedHost = { hostname: string; servername: string; family: 4 | 6 };

const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8"];
let resolvedCache: { at: number; value: ResolvedHost } | undefined;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function clearResolvedCache() {
  resolvedCache = undefined;
}

function httpsRaw(opts: {
  hostname: string;
  servername?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  family?: 4 | 6;
  timeoutMs?: number;
}): Promise<GhRes> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: opts.hostname,
        servername: opts.servername ?? opts.hostname,
        path: opts.path,
        method: opts.method ?? "GET",
        ...(opts.family ? { family: opts.family } : {}),
        headers: opts.headers ?? {},
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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resolveViaPublicDns(): Promise<ResolvedHost | undefined> {
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS);
  try {
    const addrs = await withTimeout(resolver.resolve4(GH_HOST), 2_000, "public DNS");
    if (addrs[0]) return { hostname: addrs[0], servername: GH_HOST, family: 4 };
  } catch {
    /* DoH next */
  }
  const doh = [
    { ip: "1.1.1.1", servername: "cloudflare-dns.com", path: `/dns-query?name=${GH_HOST}&type=A` },
    { ip: "8.8.8.8", servername: "dns.google", path: `/resolve?name=${GH_HOST}&type=A` },
  ];
  for (const d of doh) {
    try {
      const out = await httpsRaw({
        hostname: d.ip,
        servername: d.servername,
        path: d.path,
        headers: { Accept: "application/dns-json", Host: d.servername },
        family: 4,
        timeoutMs: 6_000,
      });
      const ip = out.status === 200 ? parseDohA(out.text) : undefined;
      if (ip) return { hostname: ip, servername: GH_HOST, family: 4 };
    } catch {
      /* try next resolver */
    }
  }
  return undefined;
}

async function resolveGithubHost(force = false): Promise<ResolvedHost> {
  if (!force && resolvedCache && Date.now() - resolvedCache.at < 5 * 60_000) return resolvedCache.value;
  try {
    const r = await withTimeout(dnsLookup(GH_HOST, { family: 4 }), 2_000, "system DNS");
    const value: ResolvedHost = { hostname: r.address, servername: GH_HOST, family: 4 };
    resolvedCache = { at: Date.now(), value };
    return value;
  } catch {
    /* public DNS / DoH */
  }
  try {
    const r = await withTimeout(dnsLookup(GH_HOST), 2_000, "system DNS");
    const value: ResolvedHost = {
      hostname: r.address,
      servername: GH_HOST,
      family: r.family === 6 ? 6 : 4,
    };
    resolvedCache = { at: Date.now(), value };
    return value;
  } catch {
    /* public DNS / DoH */
  }
  const fallback = await resolveViaPublicDns();
  if (fallback) {
    resolvedCache = { at: Date.now(), value: fallback };
    return fallback;
  }
  throw new Error(`getaddrinfo ENOTFOUND ${GH_HOST} (system DNS and DoH both failed)`);
}

function ghApiHeaders(extra: Record<string, string>, body?: string): Record<string, string> {
  return {
    Host: GH_HOST,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ashlar-bot",
    ...extra,
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };
}

async function ghCall(resolved: ResolvedHost, method: string, path: string, headers: Record<string, string>, body?: string, timeoutMs = 20_000) {
  return httpsRaw({
    hostname: resolved.hostname,
    servername: resolved.servername,
    path,
    method,
    family: resolved.family,
    timeoutMs,
    headers: ghApiHeaders(headers, body),
    body,
  });
}

/** Bypass Vite/Nitro-patched fetch. Connect to a resolved IP with SNI. */
async function ghHttps(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 20_000,
): Promise<GhRes> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const resolved = await resolveGithubHost();
  try {
    return await ghCall(resolved, method, p, headers, body, timeoutMs);
  } catch (e) {
    clearResolvedCache();
    const retry = await resolveGithubHost(true);
    if (retry.hostname === resolved.hostname) throw e;
    return ghCall(retry, method, p, headers, body, timeoutMs);
  }
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
): Promise<{ headSha: string; baseSha: string; title: string; draft: boolean; fork: ForkStatus; body: string }> {
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
    fork: typeof out.data.head.repo?.fork === "boolean" ? out.data.head.repo.fork : null,
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
    isFork: ForkStatus;
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
    if (isSandboxPolicyFile(content)) continue;
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
  let comments = opts.comments;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await gh<{ id?: number }>(token, `/repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commit_id: opts.headSha,
        event: opts.event,
        body: opts.body,
        comments: comments.map((c) => ({
          path: c.file,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      }),
    });
    if (out.ok) {
      if (!out.data.id) throw new Error("review missing id");
      return { id: out.data.id };
    }
    if (comments.length && isReviewLineError(out.text)) {
      comments = [];
      continue;
    }
    throw new Error(`GitHub Reviews API ${out.status}: ${out.text}`);
  }
  throw new Error("GitHub Reviews API failed");
}

export async function createIssueComment(
  token: string,
  opts: { owner: string; repo: string; pr: number; body: string },
): Promise<{ id: number }> {
  const out = await gh<{ id?: number }>(token, `/repos/${opts.owner}/${opts.repo}/issues/${opts.pr}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: opts.body }),
  });
  if (!out.ok) throw new Error(`GitHub issue comment ${out.status}: ${out.text}`);
  if (!out.data.id) throw new Error("comment missing id");
  return { id: out.data.id };
}

export async function updateIssueComment(
  token: string,
  opts: { owner: string; repo: string; commentId: number; body: string },
): Promise<void> {
  const out = await gh(token, `/repos/${opts.owner}/${opts.repo}/issues/comments/${opts.commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: opts.body }),
  });
  if (!out.ok) throw new Error(`GitHub issue comment update ${out.status}: ${out.text}`);
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

