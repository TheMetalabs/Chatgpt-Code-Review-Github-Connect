import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLocalLlmSlot, tryStealStaleSlot } from "./local-chat-request.server.ts";

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-slot-"));
  return path.join(dir, "llm.slot.lock");
}

test("tryStealStaleSlot removes dead-pid lock", () => {
  const lock = tmpLock();
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, label: "dead", at: 0 }) + "\n");
  tryStealStaleSlot(lock);
  assert.equal(fs.existsSync(lock), false);
});

test("tryStealStaleSlot restores when lock payload changed mid-steal", () => {
  const lock = tmpLock();
  const livePid = process.pid;
  // Simulate race: stealer read stale payload, but rename captured a NEW live lock.
  // We approximate by writing live lock, then calling steal which must NOT delete live owner.
  fs.writeFileSync(lock, JSON.stringify({ pid: livePid, label: "live", at: 1 }) + "\n");
  tryStealStaleSlot(lock);
  assert.equal(fs.existsSync(lock), true);
  const body = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(body.pid, livePid);
});

test("acquireLocalLlmSlot serializes holders on one lock path", async () => {
  const lock = tmpLock();
  const order: string[] = [];
  const a = acquireLocalLlmSlot("a", lock).then(async (release) => {
    order.push("a-in");
    await new Promise((r) => setTimeout(r, 80));
    order.push("a-out");
    release();
  });
  await new Promise((r) => setTimeout(r, 10));
  const b = acquireLocalLlmSlot("b", lock).then(async (release) => {
    order.push("b-in");
    release();
    order.push("b-out");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-in", "a-out", "b-in", "b-out"]);
});
