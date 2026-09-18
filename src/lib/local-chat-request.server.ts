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

function tryStealStaleSlot(lockPath: string): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    let pid = 0;
    try { pid = Number(JSON.parse(raw)?.pid || 0); } catch { fs.unlinkSync(lockPath); return; }
    if (!pidAlive(pid)) fs.unlinkSync(lockPath);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return;
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

/** Block until this process holds the single local-LLM slot. Returns release(). */
export async function acquireLocalLlmSlot(label = "ashlar-local"): Promise<() => void> {
  fs.mkdirSync(path.dirname(LOCAL_LLM_SLOT_LOCK), { recursive: true });
  const started = Date.now();
  let lastLog = 0;
  for (;;) {
    try {
      const fd = fs.openSync(LOCAL_LLM_SLOT_LOCK, "wx");
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, label, at: Date.now() / 1000 })}\n`);
      fs.closeSync(fd);
      const waited = Date.now() - started;
      if (waited >= 1000) console.info(`[qwen-llm-slot] acquired after ${(waited / 1000).toFixed(1)}s label=${label}`);
      return () => { try { fs.unlinkSync(LOCAL_LLM_SLOT_LOCK); } catch { /* ignore */ } };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "EEXIST") throw e;
      tryStealStaleSlot(LOCAL_LLM_SLOT_LOCK);
      const waited = Date.now() - started;
      if (waited - lastLog >= SLOT_LOG_EVERY_MS) {
        let holder = "?";
        try { holder = fs.readFileSync(LOCAL_LLM_SLOT_LOCK, "utf8").trim().replace(/\n/g, " "); } catch { /* ignore */ }
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
