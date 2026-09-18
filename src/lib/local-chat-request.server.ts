import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = { model: string; messages: LocalChatMessage[]; temperature: number };

/** Same path/protocol as /Users/ai/work/tools/qwen_local_llm_queue.py (omlx concurrent=1). */
const LOCAL_LLM_SLOT_LOCK = path.join(os.homedir(), ".cache/qwen38/llm.slot.lock");
const SLOT_POLL_MS = 350;
const SLOT_LOG_EVERY_MS = 15_000;

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Ownership-safe stale recovery: rename(claim) → verify payload unchanged + pid dead → unlink.
 * If another process replaced the lock between read and rename, claimed content differs and we restore.
 */
export function tryStealStaleSlot(lockPath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return;
    return;
  }

  let pid = 0;
  let parsedOk = false;
  try {
    pid = Number(JSON.parse(raw)?.pid || 0);
    parsedOk = true;
  } catch {
    parsedOk = false;
  }

  if (parsedOk && pidAlive(pid)) return;

  const claimPath = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return;
    return;
  }

  let claimed: string;
  try {
    claimed = fs.readFileSync(claimPath, "utf8");
  } catch {
    try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
    return;
  }

  let claimedPid = 0;
  try {
    claimedPid = Number(JSON.parse(claimed)?.pid || 0);
  } catch {
    try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
    return;
  }

  // Not the payload we inspected, or holder is alive → put it back.
  if (claimed !== raw || pidAlive(claimedPid)) {
    try {
      fs.renameSync(claimPath, lockPath);
    } catch {
      try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
    }
    return;
  }

  try { fs.unlinkSync(claimPath); } catch { /* ignore */ }
}

function releaseIfOwner(lockPath: string, ownerPid: number): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const pid = Number(JSON.parse(raw)?.pid || 0);
    if (pid === ownerPid) fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
}

/** Block until this process holds the single local-LLM slot. Returns release(). */
export async function acquireLocalLlmSlot(
  label = "ashlar-local",
  lockPath = LOCAL_LLM_SLOT_LOCK,
): Promise<() => void> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  let lastLog = 0;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, label, at: Date.now() / 1000, token })}\n`,
      );
      fs.closeSync(fd);
      const waited = Date.now() - started;
      if (waited >= 1000) console.info(`[qwen-llm-slot] acquired after ${(waited / 1000).toFixed(1)}s label=${label}`);
      return () => releaseIfOwner(lockPath, process.pid);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "EEXIST") throw e;
      tryStealStaleSlot(lockPath);
      const waited = Date.now() - started;
      if (waited - lastLog >= SLOT_LOG_EVERY_MS) {
        let holder = "?";
        try { holder = fs.readFileSync(lockPath, "utf8").trim().replace(/\n/g, " "); } catch { /* ignore */ }
        console.info(`[qwen-llm-slot] waiting ${(waited / 1000).toFixed(0)}s label=${label} holder=${holder}`);
        lastLog = waited;
      }
      await new Promise(r => setTimeout(r, SLOT_POLL_MS));
    }
  }
}

/** Shared native transport. No SDK/fetch deadline and no automatic network replay.
 * A caller may explicitly cancel; upstream servers/proxies may impose their own limits.
 * Health checks and generation create no deadline; only explicit cancellation may supply a signal.
 */
function isLocalLlmBase(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export async function requestLocalJson(
  baseURL: string,
  apiKey: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  // Shared omlx slot only for local endpoint. xAI/other hosts (e.g. harness live) must not block on it.
  if (!isLocalLlmBase(baseURL)) {
    return requestLocalJsonUnlocked(baseURL, apiKey, path, body, signal);
  }
  const release = await acquireLocalLlmSlot(`ashlar:${path}`);
  try {
    return await requestLocalJsonUnlocked(baseURL, apiKey, path, body, signal);
  } finally {
    release();
  }
}

function requestLocalJsonUnlocked(
  baseURL: string,
  apiKey: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseURL.replace(/\/$/, "")}/${path}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("local LLM endpoint must use HTTP or HTTPS"));
      return;
    }
    const data = body === undefined ? undefined : JSON.stringify(body);
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(url, {
      method: data === undefined ? "GET" : "POST",
      agent: false,
      timeout: 0,
      signal,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        ...(data === undefined ? {} : {"content-type": "application/json", "content-length": Buffer.byteLength(data)}),
        authorization: `Bearer ${apiKey || "local"}`,
      },
    }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        // Bound memory, never queue/generation duration; don't store partial reviews.
        if (bytes > 16 * 1024 * 1024) { res.destroy(new Error("local LLM response too large")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("local LLM response connection closed")));
      res.on("end", () => {
        if (!res.complete) { reject(new Error("local LLM response was incomplete")); return; }
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`local LLM HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error("local LLM returned an invalid JSON response")); }
      });
    });
    req.setTimeout(0);
    req.setSocketKeepAlive(true, 30_000);
    req.on("error", reject);
    req.end(data);
  });
}

export async function requestLocalChat(
  baseURL: string,
  apiKey: string,
  body: ChatRequest,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = await requestLocalJson(baseURL, apiKey, "chat/completions", {...body, stream: false}, signal) as
    { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
  const choice = parsed?.choices?.[0];
  if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter") {
    throw new Error(`local LLM response ended with ${choice.finish_reason}`);
  }
  if (typeof choice?.message?.content !== "string") throw new Error("local LLM returned no completed message");
  return choice.message.content;
}
