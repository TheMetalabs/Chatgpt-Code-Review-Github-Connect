import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLocalServerLoad,
  fetchLocalServerLoad,
  localIdleSkipEnabled,
} from "./local-status.server.ts";

describe("parseLocalServerLoad", () => {
  it("reads active/waiting counts and floors them at zero", () => {
    assert.deepEqual(parseLocalServerLoad({ active_requests: 1, waiting_requests: 0 }), { activeRequests: 1, waitingRequests: 0 });
    assert.deepEqual(parseLocalServerLoad({ active_requests: 0, waiting_requests: 3, extra: "ignored" }), { activeRequests: 0, waitingRequests: 3 });
    assert.deepEqual(parseLocalServerLoad({ active_requests: 2.9, waiting_requests: -1 }), { activeRequests: 2, waitingRequests: 0 });
  });

  it("returns null for shapes we do not recognise, so an unknown server never triggers a skip", () => {
    assert.equal(parseLocalServerLoad(null), null);
    assert.equal(parseLocalServerLoad("nope"), null);
    assert.equal(parseLocalServerLoad({}), null);
    assert.equal(parseLocalServerLoad({ active_requests: 1 }), null);
    assert.equal(parseLocalServerLoad({ active_requests: "1", waiting_requests: 0 }), null);
  });
});

describe("localIdleSkipEnabled", () => {
  it("is on by default and only off for the explicit opt-out", () => {
    assert.equal(localIdleSkipEnabled({}), true);
    assert.equal(localIdleSkipEnabled({ ASHLAR_LOCAL_IDLE_SKIP: "true" }), true);
    assert.equal(localIdleSkipEnabled({ ASHLAR_LOCAL_IDLE_SKIP: "false" }), false);
  });
});

describe("fetchLocalServerLoad", () => {
  const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

  it("resolves /api/status against the server root, not the OpenAI /v1 base", async () => {
    let seenUrl = "";
    const load = await fetchLocalServerLoad("http://127.0.0.1:1234/v1", "sk-local", undefined, {
      fetch: (async (url: string | URL) => { seenUrl = String(url); return okResponse({ active_requests: 0, waiting_requests: 0 }); }) as typeof fetch,
    });
    assert.equal(seenUrl, "http://127.0.0.1:1234/api/status");
    assert.deepEqual(load, { activeRequests: 0, waitingRequests: 0 });
  });

  it("sends the bearer key and returns null on a non-2xx status", async () => {
    let auth = "";
    const load = await fetchLocalServerLoad("http://h:8000/v1", "sk-abc", undefined, {
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        auth = String((init?.headers as Record<string, string>).authorization);
        return { ok: false, json: async () => ({}) } as Response;
      }) as typeof fetch,
    });
    assert.equal(auth, "Bearer sk-abc");
    assert.equal(load, null);
  });

  it("returns null when the request throws (unreachable), so it never forces a skip", async () => {
    const load = await fetchLocalServerLoad("http://h:8000/v1", "k", undefined, {
      fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    });
    assert.equal(load, null);
  });
});
