// Default-deny edit boundary for the local-LLM branch.
// Fails if any changed file (committed on this branch, staged, unstaged, or untracked)
// is outside the allowlist. Keeps ChatGPT/Grok/bridge/merge code frozen while the
// local reviewer leg is reworked. See BOUNDARY.md.
import { execFileSync } from "node:child_process";

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
  "src/lib/settings.server.test.ts",
  "tests/review/local.test.mjs",
  "tests/review/local-http.test.mjs",
  "tests/review/local-llm.test.mjs",
  "BOUNDARY.md",
  "scripts/check-local-llm-boundary.mjs",
  "package.json",
  "README.md",
]);

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
  // Untracked files.
  for (const f of git(["ls-files", "--others", "--exclude-standard"])) changed.add(f);
} catch (e) {
  // A missing/unfetched base ref must fail the check cleanly, not crash with a stack trace.
  console.error(`✗ boundary check could not diff against "${BASE}": ${e instanceof Error ? e.message : e}`);
  console.error("Fetch the base ref (e.g. git fetch origin main) or set BOUNDARY_BASE to a resolvable ref.");
  process.exit(1);
}

const offenders = [...changed].filter((f) => !ALLOW.has(f) && !IGNORE.has(f));

if (offenders.length) {
  console.error(`✗ boundary violation: ${offenders.length} file(s) outside the local-LLM allowlist`);
  for (const f of offenders) console.error(`   - ${f}`);
  console.error("\nThese belong to the ChatGPT/Grok/bridge/merge path and are frozen on this branch.");
  console.error("If a change is genuinely local-LLM-only, add the path to ALLOW in scripts/check-local-llm-boundary.mjs and note it in BOUNDARY.md.");
  process.exit(1);
}

console.log(`✓ boundary ok: ${changed.size} changed file(s), all within the local-LLM allowlist`);
