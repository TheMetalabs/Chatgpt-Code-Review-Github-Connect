// Default-deny edit boundary for the local-LLM branch.
// Fails if any changed file (committed on this branch, staged, unstaged, or untracked)
// is outside the allowlist. Keeps ChatGPT/Grok/bridge/merge code frozen while the
// local reviewer leg is reworked. See BOUNDARY.md.
import { execFileSync } from "node:child_process";

const BASE = process.env.BOUNDARY_BASE || "origin/main";

// Allowlist: only these paths may change on this branch.
const ALLOW = new Set([
  "src/lib/local-llm.server.ts",
  "src/lib/local-chat-request.server.ts",
  "src/lib/local-review-loop.server.ts",
  "src/lib/local-fallback.ts",
  "src/lib/harbor.server.ts",
  "src/lib/settings.server.ts",
  "src/lib/types.ts",
  "src/lib/json-repair.server.ts",
  "src/routes/api/harbor.ts",
  "src/lib/local-llm.test.ts",
  "src/lib/local-review-loop.test.ts",
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
// Committed on this branch + all tracked working-tree changes vs the base.
for (const f of git(["diff", "--name-only", BASE])) changed.add(f);
// Untracked files.
for (const f of git(["ls-files", "--others", "--exclude-standard"])) changed.add(f);

const offenders = [...changed].filter((f) => !ALLOW.has(f) && !IGNORE.has(f));

if (offenders.length) {
  console.error(`✗ boundary violation: ${offenders.length} file(s) outside the local-LLM allowlist`);
  for (const f of offenders) console.error(`   - ${f}`);
  console.error("\nThese belong to the ChatGPT/Grok/bridge/merge path and are frozen on this branch.");
  console.error("If a change is genuinely local-LLM-only, add the path to ALLOW in scripts/check-local-llm-boundary.mjs and note it in BOUNDARY.md.");
  process.exit(1);
}

console.log(`✓ boundary ok: ${changed.size} changed file(s), all within the local-LLM allowlist`);
