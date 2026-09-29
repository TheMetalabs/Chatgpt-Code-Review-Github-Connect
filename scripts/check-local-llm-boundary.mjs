// Default-deny edit boundary for the local-LLM branch.
// Fails if any changed file (committed on this branch, staged, unstaged, or untracked)
// is outside the allowlist. Keeps ChatGPT/Grok/bridge/merge code frozen while the
// local reviewer leg is reworked. See BOUNDARY.md.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { notAdditionsOnly, outsideDeclarations } from "./boundary-scope.mjs";

// Measure this branch's own changes, not main's forward progress: diff from the merge-base so an
// advancing origin/main (other sessions merging ChatGPT-path fixes) never looks like a violation.
const REF = process.env.BOUNDARY_BASE || "origin/main";
function mergeBase(ref) {
  try {
    return execFileSync("git", ["merge-base", ref, "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // No common ancestor (or an unfetched ref). Diffing against the ref TIP would count the ref's own
    // forward progress as this branch's changes — the very false positive merge-base avoids — so warn
    // loudly rather than fail silently. The diff itself is still guarded below.
    console.error(`⚠ merge-base(${ref}, HEAD) failed; comparing against "${ref}" directly may over-report. Fetch the ref or set BOUNDARY_BASE.`);
    return ref;
  }
}
const BASE = mergeBase(REF);

// Allowlist: only these paths may change on this branch.
const ALLOW = new Set([
  "src/lib/local-llm.server.ts",
  "src/lib/local-chat-request.server.ts",
  "src/lib/local-review-loop.server.ts",
  "src/lib/local-fallback.ts",
  "src/lib/harbor.server.ts",
  // Local-lane rendering only: the local provider's in-flight branch surfaces heartbeat freshness.
  // The chat/Grok branches stay frozen (guarded by reviewer-progress.test.ts chat-lane cases).
  "src/lib/reviewer-progress.ts",
  "src/lib/reviewer-progress.test.ts",
  // Local-leg liveness (queued at the model server vs generating vs no response). The tracker is a
  // new local-only module; review-progress.ts gains two local_* stage labels + the optional
  // keepaliveAt stamp, review-history.server.ts gains two local.* server steps. Chat/bridge stages
  // and step recording are untouched.
  "src/lib/local-leg-activity.ts",
  // Process-wide FIFO lease a review's local leg holds across all its turns (+ its tests).
  "src/lib/local-model-lease.ts",
  "tests/review/local-model-lease.test.mjs",
  "tests/review/local-model-lease.e2e.mjs",
  // The local fix agent's model call (holds the local-model lease in the "fix" lane). The shared
  // runtime file that routes to it is SCOPED below, not allowlisted whole.
  "src/lib/local-fix-request.server.ts",
  "scripts/boundary-scope.mjs",
  "scripts/boundary-scope.test.mjs",
  "src/lib/local-leg-activity.test.ts",
  "src/lib/review-progress.ts",
  "src/lib/review-history.server.ts",
  ".env.example",
  // Context-assembly for BOTH reviewers (per-reviewer context tailoring). These build what each
  // reviewer SEES — snapshot slicing, cross-file definitions, repo-policy extraction, and the
  // head-file fetch. They are editable here to close the cross-file / domain-contract context gaps.
  // The bridge/merge/posting/extension path (bridge.server, poster, chat-settle, review-diff/format,
  // extension/**) stays FROZEN; the full npm test suite is the behavioral net for it.
  "src/lib/context-slice.ts",
  "src/lib/context-slice.test.ts",
  "src/lib/chat-prompt.ts",
  "src/lib/chat-prompt.test.ts",
  "src/lib/github-snapshot.ts",
  "src/lib/github-snapshot.test.ts",
  "src/lib/github.server.ts",
  "src/lib/import-resolve.ts",
  "src/lib/import-resolve.test.ts",
  "src/lib/settings.server.ts",
  "src/lib/types.ts",
  "src/lib/json-repair.server.ts",
  "src/routes/api/harbor.ts",
  "src/lib/local-llm.test.ts",
  "tests/review/local-loop.test.mjs",
  // Shared e2e fixture: #61 added getFile to harbor's import graph but not to this fixture's
  // github.server stub, so every appFixture test threw and hung the browser-e2e CI job. Fixing the
  // stub is test-infra, not a chat/bridge/merge behavior change.
  "tests/review/app-fixture.mjs",
  "src/lib/settings.server.test.ts",
  "tests/review/local.test.mjs",
  "tests/review/local-http.test.mjs",
  "tests/review/local-llm.test.mjs",
  "BOUNDARY.md",
  "scripts/check-local-llm-boundary.mjs",
  "package.json",
  "README.md",
]);

// Shared files this branch may touch only within a sub-file scope, checked by comparing the base blob
// with the working file (never diff output, which a binary classification or diff driver can empty):
// the rest of each file stays frozen and an edit there is a violation like any other.
const SCOPED = {
  // Only the productionRequestFix routing (its local-llm branch delegates to local-fix-request.server.ts).
  // requestChatFix (the Chrome-bridge fix transport) and the loop control in this file stay frozen.
  "src/lib/review-loop-runtime.server.ts": { declarations: ["productionRequestFix"] },
  // Tests for the local fix lane: new cases only; no existing line may change.
  "src/lib/review-loop-runtime.server.test.ts": { additionsOnly: true },
  // The fix watcher learns an application-level queue (waiting for the local-model lease) so the wait is
  // charged to queueMaxMs, not the generation deadline. Only the control type and the watcher itself.
  "src/lib/fix-request-watch.ts": { declarations: ["FixRequestControl", "watchFixRequest"] },
  "src/lib/fix-request-watch.test.ts": { additionsOnly: true },
  // The fix transport's control type gains the optional waitForModel hook; the fix agent stays frozen.
  "src/lib/fix-agent.ts": { declarations: ["RequestFix"] },
};

function checkScope(scope, oldText, newText, file) {
  return scope.additionsOnly ? notAdditionsOnly(oldText, newText) : outsideDeclarations(oldText, newText, scope.declarations, file);
}

// Both candidate versions are checked independently: the index (what the next commit records) and the
// working tree. A permitted copy in one never clears a prohibited blob, mode or file type in the other.
function scopeViolation(file) {
  const scope = SCOPED[file];
  let oldText;
  try { oldText = execFileSync("git", ["cat-file", "blob", `${BASE}:${file}`], { encoding: "utf8" }); }
  catch { return "not present at the base (a scoped file must already exist)"; }
  // Index: the staged entry's mode must be a regular file (100644/100755), and its blob in scope.
  const entry = execFileSync("git", ["ls-files", "-s", "--", file], { encoding: "utf8" }).trim();
  if (entry) {
    const mode = entry.split(/\s+/, 1)[0];
    if (mode !== "100644" && mode !== "100755") return `staged version is not a regular file (mode ${mode}${mode === "120000" ? ", symbolic link" : ""})`;
    const staged = execFileSync("git", ["cat-file", "blob", `:${file}`], { encoding: "utf8" });
    const why = checkScope(scope, oldText, staged, file);
    if (why) return `staged version ${why}`;
  }
  // Working tree: the path itself, not what it points to — a symlink (or any non-regular file)
  // replacing a scoped file is a violation even when its target holds the base text.
  let st;
  try { st = lstatSync(file); } catch { return "deleted"; }
  if (!st.isFile()) return `is no longer a regular file (${st.isSymbolicLink() ? "symbolic link" : "not a regular file"})`;
  return checkScope(scope, oldText, readFileSync(file, "utf8"), file);
}

// Never a real source change even though the symlink is not gitignored here.
const IGNORE = new Set(["node_modules"]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const changed = new Set();
try {
  // Committed on this branch + all tracked working-tree changes vs the base.
  // --no-renames: a rename is reported as delete(old)+add(new), so a frozen file renamed onto an
  // allowlisted path still surfaces its (forbidden) source path instead of hiding behind the destination.
  for (const f of git(["diff", "--name-only", "--no-renames", BASE])) changed.add(f);
  // Staged vs the base: an index-only change whose working-tree copy was restored still counts.
  for (const f of git(["diff", "--cached", "--name-only", "--no-renames", BASE])) changed.add(f);
  // Untracked files.
  for (const f of git(["ls-files", "--others", "--exclude-standard"])) changed.add(f);
} catch (e) {
  // A missing/unfetched base ref must fail the check cleanly, not crash with a stack trace.
  console.error(`✗ boundary check could not diff against "${BASE}": ${e instanceof Error ? e.message : e}`);
  console.error("Fetch the base ref (e.g. git fetch origin main) or set BOUNDARY_BASE to a resolvable ref.");
  process.exit(1);
}

const offenders = [...changed]
  .filter((f) => !ALLOW.has(f) && !IGNORE.has(f))
  .map((f) => ({ f, why: f in SCOPED ? scopeViolation(f) : "" }))
  .filter(({ why }) => why !== null);

if (offenders.length) {
  console.error(`✗ boundary violation: ${offenders.length} file(s) outside the local-LLM allowlist`);
  for (const { f, why } of offenders) console.error(`   - ${f}${why ? ` — scoped file ${why}` : ""}`);
  console.error("\nThese belong to the ChatGPT/Grok/bridge/merge path and are frozen on this branch.");
  console.error("If a change is genuinely local-LLM-only, add the path to ALLOW in scripts/check-local-llm-boundary.mjs and note it in BOUNDARY.md.");
  process.exit(1);
}

console.log(`✓ boundary ok: ${changed.size} changed file(s), all within the local-LLM allowlist`);
