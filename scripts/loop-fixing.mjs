#!/usr/bin/env node
// Deploy gate (docs/review-loop-runbook.md): list the open PRs whose newest review-loop comment of
// the App is FIXING — a fix round in flight (a deploy now would cut it) or one a restart already cut.
// It uses the server's own reader (src/lib/review-loop.ts newestLoopComment), so the gate and the
// boot sweep (review-loop-runtime sweepCutFixRounds) can never disagree on what "at FIXING" means.
//
//   npm run loop:fixing -- owner/repo [owner/repo ...]      (or ASHLAR_LOOP_REPOS="owner/repo,...")
//
// Token: GITHUB_TOKEN or GH_TOKEN, else `gh auth token`. Bot login: ASHLAR_BOT_LOGIN (as the server).
// Exit 0: no PR at FIXING (safe to deploy). 1: some are (do not deploy). 2: usage error or a failed
// read (unknown: do not deploy).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { newestLoopComment, resolveBotLogin } from "../src/lib/review-loop.ts";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 50;

/** The repositories to check: the arguments, else ASHLAR_LOOP_REPOS (comma-separated). Throws on
 * none, or on anything that is not owner/repo. */
export function parseRepos(argv, env = {}) {
  const specs = (argv.length ? argv : String(env.ASHLAR_LOOP_REPOS ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  const bad = specs.filter((s) => !REPO_RE.test(s));
  if (bad.length) throw new Error(`not owner/repo: ${bad.join(", ")}`);
  if (!specs.length) throw new Error("usage: npm run loop:fixing -- owner/repo [owner/repo ...] (or ASHLAR_LOOP_REPOS)");
  return [...new Set(specs)].map((s) => {
    const [owner, repo] = s.split("/");
    return { owner, repo };
  });
}

/** The FIXING round of one PR from its issue comments as the REST API returns them, or null. */
export function fixingOf(comments, botLogin) {
  const rows = comments.map((c) => ({
    id: Number(c.id ?? 0),
    userLogin: String(c.user?.login ?? ""),
    body: String(c.body ?? ""),
    createdAt: String(c.created_at ?? ""),
  }));
  const last = newestLoopComment(rows, botLogin);
  return last?.kind === "fixing" ? { round: last.round, head: last.head, at: last.row.createdAt } : null;
}

/** Every page of a GitHub list; any failed page throws (a partial list proves nothing). */
async function listAll(fetchImpl, token, path) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`GET ${path}: not a list`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error(`GET ${path}: more than ${MAX_PAGES * 100} rows`);
}

/** The open PRs of `repos` whose newest loop comment is FIXING. */
export async function listFixing({ repos, token, botLogin, fetchImpl = fetch }) {
  const out = [];
  for (const { owner, repo } of repos) {
    for (const pull of await listAll(fetchImpl, token, `/repos/${owner}/${repo}/pulls?state=open`)) {
      const hit = fixingOf(await listAll(fetchImpl, token, `/repos/${owner}/${repo}/issues/${pull.number}/comments`), botLogin);
      if (hit) out.push({ pr: `${owner}/${repo}#${pull.number}`, ...hit });
    }
  }
  return out;
}

function tokenOf(env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

async function main() {
  try {
    const repos = parseRepos(process.argv.slice(2), process.env);
    const hits = await listFixing({ repos, token: tokenOf(process.env), botLogin: resolveBotLogin(process.env.ASHLAR_BOT_LOGIN) });
    for (const h of hits) console.log(`FIXING ${h.pr} round=${h.round} head=${String(h.head).slice(0, 7)} since=${h.at}`);
    console.log(hits.length ? `${hits.length} PR(s) at FIXING: do not deploy or restart` : `0 PRs at FIXING in ${repos.length} repo(s)`);
    process.exitCode = hits.length ? 1 : 0;
  } catch (e) {
    console.error(`loop:fixing: ${e?.message ?? e}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
