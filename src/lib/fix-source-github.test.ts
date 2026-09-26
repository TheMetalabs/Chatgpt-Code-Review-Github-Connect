import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DEFAULT_SETTINGS, type BotSettings } from "./types.ts";
import { runFixRound } from "./fix-agent.ts";
import type { GitDataApi } from "./fix-commit.ts";
import type { FixRequest } from "./bridge-fix.server.ts";
import { FIX_ATTACHMENT_MAX_BYTES, isCanonicalLine, rendersAsTyped } from "./fix-attachment.ts";
import { parseFixResponse } from "./fix-apply.ts";
import { CONNECTOR_UNAVAILABLE_REPLY, ConnectorUnavailableError, type GithubFixSource } from "./fix-source-github.ts";
import { requestChatFix } from "./review-loop-runtime.server.ts";

/** The git blob SHA of `content` (what GitHub's tree reports). */
const blobSha = (content: string) => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
};

const HEAD = "a1b2c3d4".repeat(5);
const A = "src/a.ts";
const B = "src/b.ts";
const HEAD_FILES: Record<string, string> = { [A]: "export const a = 1;\n", [B]: "export const b = 1;\n" };
const HEAD_BLOBS = new Map(Object.entries(HEAD_FILES).map(([p, c]) => [p, blobSha(c)]));
const REF = { owner: "o", repo: "r", pr: 7 };
const NEW_PATH = "src/c.ts";

const chat = (): BotSettings => ({ ...DEFAULT_SETTINGS, fixAgent: { ...DEFAULT_SETTINGS.fixAgent, enabled: true, provider: "chatgpt", delivery: "script-apply", mode: "apply" } });

function source(over: Partial<GithubFixSource> = {}): GithubFixSource {
  return {
    ...REF,
    headSha: HEAD,
    paths: [A, B, NEW_PATH],
    findings: "[F1] [P1] src/a.ts:1 — `a` is wrong\n  fix: set it to **2**",
    headBlobs: async () => HEAD_BLOBS,
    switched: {},
    ...over,
  };
}

/** A fake bridge: each call gets the next scripted answer (a string resolves, an Error rejects). */
function bridge(script: Array<string | Error | ((r: FixRequest) => string)>) {
  const calls: FixRequest[] = [];
  const loadBridge = async () => ({
    requestBridgeFix: async (r: FixRequest) => {
      calls.push(r);
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(r) : next;
    },
  });
  return { calls, loadBridge };
}

/** A fenced reply as the page hands it back. */
const reply = (o: Record<string, unknown>) => "```json\n" + JSON.stringify(o) + "\n```";
const canary = (sha = HEAD_BLOBS.get(A)!, path = A) => ({ path, blobSha: sha });
const NEW_A = "export const a = 2;\n";
const EDIT_A = { path: A, baseBlobSha: HEAD_BLOBS.get(A), search: "export const a = 1;", replace: "export const a = 2;" };
const good = (over: Record<string, unknown> = {}) =>
  reply({ summary: "a fixed", canary: canary(), edits: [EDIT_A], dispositions: [{ finding: "F1", action: "fixed", note: "set a to 2" }], ...over });

const ATTACHMENT_FAILED = new Error("chatgpt fix request failed: attachment_failed: the fix attachment could not be staged: upload failed; nothing was sent");
const HUGE = "x".repeat(FIX_ATTACHMENT_MAX_BYTES);

/** A fake Git Data API recording every write (blobs are content-addressed like GitHub's). */
function gitApi() {
  const blobs = new Map<string, string>();
  const trees: Array<{ base: string; entries: Array<{ path: string; sha: string }> }> = [];
  const refUpdates: Array<{ branch: string; commit: string; expectedOldSha: string }> = [];
  const api: GitDataApi = {
    baseTreeSha: async () => "base-tree",
    createBlob: async (content) => {
      const sha = blobSha(content);
      blobs.set(sha, content);
      return sha;
    },
    createTree: async (base, entries) => (trees.push({ base, entries }), "new-tree"),
    createCommit: async () => "c".repeat(40),
    updateBranchRef: async (branch, commit, expectedOldSha) => {
      if (expectedOldSha !== HEAD) throw new Error("branch moved");
      refUpdates.push({ branch, commit, expectedOldSha });
    },
  };
  return { api, blobs, trees, refUpdates };
}

describe("fixSource=github: the fallback when the fix attachment cannot be delivered", () => {
  it("over the attachment cap the request goes to the GitHub source: one typed line, no attachment", async () => {
    const b = bridge([good()]);
    const src = source();
    assert.equal(await requestChatFix(chat(), REF, "chatgpt", HUGE, { loadBridge: b.loadBridge, github: src }), good());
    assert.equal(b.calls.length, 1);
    const [req] = b.calls;
    assert.equal(req.attachment, undefined, "no attachment in the GitHub source");
    assert.deepEqual([req.owner, req.repo, req.pr, req.provider], ["o", "r", 7, "chatgpt"]);
    assert.equal(src.switched.reason, "attachment_too_large");
    assert.ok(!req.prompt.includes("xxxxxxxx"), "the file content is never typed");
  });

  it("the typed prompt names the repo, PR, full head SHA, editable paths and the canary path (not its blob), canonical and Markdown-free", async () => {
    const b = bridge([good()]);
    await requestChatFix(chat(), REF, "chatgpt", HUGE, { loadBridge: b.loadBridge, github: source() });
    const { prompt } = b.calls[0];
    assert.ok(prompt.includes("o/r"), "the repository");
    assert.ok(prompt.includes("pull request #7"), "the PR number");
    assert.ok(prompt.includes(`at commit ${HEAD} exactly`), "the FULL head SHA");
    assert.ok(prompt.includes(`Editable files (JSON): ${JSON.stringify([A, B, NEW_PATH])}`), "the editable paths");
    assert.ok(prompt.includes(`Connector check: read ${JSON.stringify(A)} at that commit`), "the canary path");
    assert.ok(!prompt.includes(HEAD_BLOBS.get(A)!), "the canary's blob SHA is read by the model, never given to it");
    assert.ok(prompt.includes(CONNECTOR_UNAVAILABLE_REPLY));
    assert.match(prompt, /"baseBlobSha"/, "the schema asks for each file's base blob");
    assert.match(prompt, /"edits": \[\{"path": "<an editable path>", "baseBlobSha": "[^"]+", "search": "[^"]+", "replace"/, "targeted edits, not whole files");
    assert.match(prompt, /Never return an existing file whole/);
    assert.match(prompt, /11\. Preserve: keep every existing comment, test and the file's formatting/);
    assert.match(prompt, /a is wrong/, "the findings");
    assert.ok(isCanonicalLine(prompt), "one whitespace-canonical line (#103)");
    assert.ok(rendersAsTyped(prompt), "no Markdown-active characters");
    assert.ok(!/[`*]/.test(prompt));
  });

  it("attachment_failed from the page retries once through the GitHub source; later attempts go there directly", async () => {
    const b = bridge([ATTACHMENT_FAILED, good()]);
    const src = source();
    assert.equal(await requestChatFix(chat(), REF, "chatgpt", "FIX PROMPT", { loadBridge: b.loadBridge, github: src }), good());
    assert.equal(b.calls.length, 2, "the attachment try, then ONE GitHub-source try");
    assert.ok(b.calls[0].attachment, "the primary path is the hashed attachment");
    assert.equal(b.calls[1].attachment, undefined);
    assert.ok(b.calls[1].prompt.includes(HEAD));
    assert.equal(src.switched.reason, "attachment_failed");
    // the round's next attempt (retry feedback attached) does not stage the failing file again
    await requestChatFix(chat(), REF, "chatgpt", "FIX PROMPT\n\nPREVIOUS ATTEMPT REJECTED", { loadBridge: b.loadBridge, github: { ...src, retryNote: "PREVIOUS ATTEMPT REJECTED (parse-failed)" } });
    assert.equal(b.calls.length, 3);
    assert.equal(b.calls[2].attachment, undefined);
    assert.match(b.calls[2].prompt, /PREVIOUS ATTEMPT REJECTED \(parse-failed\)/);
  });

  it("a GitHub-source request that fails again is not retried a second time", async () => {
    const b = bridge([ATTACHMENT_FAILED, new Error("chatgpt fix request failed: timed out")]);
    await assert.rejects(requestChatFix(chat(), REF, "chatgpt", "FIX PROMPT", { loadBridge: b.loadBridge, github: source() }), /timed out/);
    assert.equal(b.calls.length, 2);
  });

  it("without a GitHub source, or on any other failure, the attachment path behaves as before", async () => {
    const plain = bridge([ATTACHMENT_FAILED]);
    await assert.rejects(requestChatFix(chat(), REF, "chatgpt", "FIX PROMPT", { loadBridge: plain.loadBridge }), /attachment_failed/);
    assert.equal(plain.calls.length, 1);
    await assert.rejects(requestChatFix(chat(), REF, "chatgpt", HUGE, { loadBridge: plain.loadBridge }), /^Error: attachment_too_large/);
    const other = bridge([new Error("chatgpt fix request failed: send_unconfirmed: no turn")]);
    await assert.rejects(requestChatFix(chat(), REF, "chatgpt", "FIX PROMPT", { loadBridge: other.loadBridge, github: source() }), /send_unconfirmed/);
    assert.equal(other.calls.length, 1, "only an attachment failure switches the source");
  });

  it("a wrong, missing or refused canary echo fails as connector_unavailable", async () => {
    const cases = [
      good({ canary: canary("0".repeat(40)) }), // read another commit (or guessed)
      good({ canary: canary(HEAD_BLOBS.get(B), B) }), // echoed another file
      good({ canary: undefined }), // no echo at all
      CONNECTOR_UNAVAILABLE_REPLY, // no connector access
      "I cannot access GitHub from here.",
    ];
    for (const answer of cases) {
      const b = bridge([answer]);
      await assert.rejects(requestChatFix(chat(), REF, "chatgpt", HUGE, { loadBridge: b.loadBridge, github: source() }), (e: Error) => {
        assert.ok(e instanceof ConnectorUnavailableError, `${answer.slice(0, 60)}: ${e.message}`);
        assert.match(e.message, /^connector_unavailable: /);
        return true;
      });
    }
  });

  it("parsing stays in fix-apply: baseBlobSha and the canary are read there, a malformed baseBlobSha fails the parse", () => {
    const ok = parseFixResponse(good());
    assert.ok(ok.ok);
    assert.deepEqual(ok.fix.edits, [EDIT_A]);
    assert.deepEqual(ok.fix.canary, canary());
    const bad = parseFixResponse(good({ edits: [{ ...EDIT_A, baseBlobSha: "not-a-sha" }] }));
    assert.ok(!bad.ok && /baseBlobSha/.test(bad.error));
  });
});

describe("fixSource=github: server validation before the commit (runFixRound, apply)", () => {
  const round = async (answer: string) => {
    const b = bridge([answer]);
    const git = gitApi();
    const res = await runFixRound(
      { requestFix: (p) => requestChatFix(chat(), REF, "chatgpt", p, { loadBridge: b.loadBridge, github: source() }), api: git.api, validate: async () => ({ ok: true }) },
      { prompt: HUGE, mode: "apply", branch: "feature", baseCommitSha: HEAD, message: "fix", allowedPaths: [A, B, NEW_PATH], baseFiles: new Map(Object.entries(HEAD_FILES)), flagged: [{ path: A, line: 1 }], findingCount: 1 },
    );
    return { res, git };
  };

  it("happy path: the edit on the head blob commits through the guarded path with the expected tree", async () => {
    const { res, git } = await round(good());
    assert.equal(res.outcome, "applied");
    assert.equal(res.commitSha, "c".repeat(40));
    assert.deepEqual(git.trees, [{ base: "base-tree", entries: [{ path: A, sha: blobSha(NEW_A) }] }]);
    assert.equal(git.blobs.get(blobSha(NEW_A)), NEW_A);
    assert.deepEqual(git.refUpdates, [{ branch: "feature", commit: "c".repeat(40), expectedOldSha: HEAD }], "expectedOldSha is the reviewed head");
  });

  it("a baseBlobSha that is not the head blob is stale content: rejected, nothing committed", async () => {
    const { res, git } = await round(good({ edits: [{ ...EDIT_A, baseBlobSha: blobSha("export const a = 0;\n") }] }));
    assert.equal(res.outcome, "request-failed");
    assert.match(res.error ?? "", /stale content for "src\/a\.ts"/);
    assert.deepEqual([git.blobs.size, git.trees.length, git.refUpdates.length], [0, 0, 0]);
  });

  it("a missing baseBlobSha is rejected, nothing committed", async () => {
    const { res, git } = await round(good({ edits: [{ path: A, search: EDIT_A.search, replace: EDIT_A.replace }] }));
    assert.equal(res.outcome, "request-failed");
    assert.match(res.error ?? "", /has no baseBlobSha/);
    assert.equal(git.refUpdates.length, 0);
  });

  it("a path outside the editable list is rejected, nothing committed", async () => {
    const { res, git } = await round(good({ edits: [{ ...EDIT_A, path: "src/other.ts", baseBlobSha: "1".repeat(40) }] }));
    assert.equal(res.outcome, "request-failed");
    assert.match(res.error ?? "", /out-of-scope paths rejected: "src\/other\.ts"/);
    assert.deepEqual([git.blobs.size, git.refUpdates.length], [0, 0]);
  });

  it("a canary mismatch is connector_unavailable, nothing committed", async () => {
    const { res, git } = await round(good({ canary: canary("f".repeat(40)) }));
    assert.equal(res.outcome, "request-failed");
    assert.match(res.error ?? "", /^connector_unavailable: /);
    assert.equal(git.refUpdates.length, 0);
  });

  it("a search that is not in the head blob is rejected (validation-failed, retryable), nothing committed", async () => {
    const { res, git } = await round(good({ edits: [{ ...EDIT_A, search: "export const a = 0;" }] }));
    assert.equal(res.outcome, "validation-failed");
    assert.match(res.error ?? "", /"search" not found in the current file/);
    assert.deepEqual([git.blobs.size, git.refUpdates.length], [0, 0]);
  });

  it("a new file needs no baseBlobSha and commits; a newFiles entry for an existing file is rejected", async () => {
    const created = "export const c = 1;\n";
    const { res, git } = await round(good({ edits: [EDIT_A], newFiles: [{ path: NEW_PATH, content: created }] }));
    assert.equal(res.outcome, "applied");
    assert.deepEqual(git.trees[0].entries, [{ path: A, sha: blobSha(NEW_A) }, { path: NEW_PATH, sha: blobSha(created) }]);
    const whole = await round(good({ edits: [], newFiles: [{ path: A, content: NEW_A }] }));
    assert.equal(whole.res.outcome, "request-failed");
    assert.match(whole.res.error ?? "", /"src\/a\.ts" exists at that commit; change it with edits/);
    assert.equal(whole.git.refUpdates.length, 0);
  });
});
