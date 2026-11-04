// SYNTHETIC large PR for the local-model budget tests (chat-prompt.ts LocalBudget). Every path, line
// and sentence is generated here; nothing is copied from a real repository. It is sized so the chat
// review (description up to 6,000 chars, module docs, call sites, changed docs, policy) is well over a
// ~30K-token local window while its code core (diff + changed code) fits one.

const pad = (n) => String(n).padStart(2, "0");

function moduleSource(i) {
  const lines = [`import { audit } from "../shared/audit";`, `import { clamp } from "../shared/math";`, ""];
  lines.push(`export function applyRule${i}(input: number, limit: number): number {`);
  lines.push(`  const bounded = clamp(input, 0, limit);`);
  lines.push(`  audit("rule${i}", bounded);`);
  lines.push(`  return bounded * ${i + 2};`);
  lines.push(`}`, "");
  for (let k = 0; k < 26; k += 1) {
    lines.push(`function helper${i}_${pad(k)}(value: number): number {`);
    lines.push(`  // keeps step ${k} of rule ${i} within the configured window`);
    lines.push(`  return value > ${k * 10} ? value - ${k} : value + ${k};`);
    lines.push(`}`);
  }
  return `${lines.join("\n")}\n`;
}

function callerSource(j, mods) {
  const lines = mods.map((i) => `import { applyRule${i} } from "../feature/mod${i}";`);
  lines.push("", `export function pipeline${j}(xs: number[], limit: number): number[] {`);
  for (const i of mods) lines.push(`  xs = xs.map((x) => applyRule${i}(x, limit));`);
  lines.push(`  return xs;`, `}`);
  for (let k = 0; k < 12; k += 1) lines.push(`export const STEP_${j}_${pad(k)} = ${k * j};`);
  return `${lines.join("\n")}\n`;
}

const para = (topic, n) => Array.from({ length: n }, (_, k) => `The ${topic} section, sentence ${k + 1}, describes how the generated rules interact with the limit window.`).join(" ");

function docText(title, sections, perSection) {
  const out = [`# ${title}`, ""];
  for (let s = 0; s < sections; s += 1) out.push(`## ${title} part ${s + 1}`, "", para(`${title} part ${s + 1}`, perSection), "");
  return out.join("\n");
}

/** A SamplePr with `codeFiles` changed modules (each one hunk at its exported function), callers in
 * unchanged reference modules, a long description whose design paragraph sits past the first 4,000
 * chars, large changed docs/config/tests, and large base policy docs. */
export function largePr({ codeFiles = 12 } = {}) {
  const mods = Array.from({ length: codeFiles }, (_, i) => i + 1);
  const files = [];
  const diffs = [];
  for (const i of mods) {
    const path = `src/feature/mod${i}.ts`;
    files.push({ path, content: moduleSource(i), language: "ts" });
    diffs.push(`--- ${path}\n@@ -4,4 +4,4 @@\n export function applyRule${i}(input: number, limit: number): number {\n-  const bounded = Math.min(input, limit);\n+  const bounded = clamp(input, 0, limit);\n   audit("rule${i}", bounded);\n   return bounded * ${i + 2};`);
  }
  const nonCode = [
    { path: "docs/feature-rules.md", content: docText("Feature rules", 16, 14) },
    { path: "src/feature/README.md", content: docText("Feature module", 10, 12) },
    { path: "config/rules.json", content: `${JSON.stringify({ rules: mods.map((i) => ({ id: `rule${i}`, factor: i + 2, window: [0, 100 * i] })) }, null, 2)}\n` },
    { path: "src/feature/mod1.test.ts", content: `import { applyRule1 } from "./mod1";\n${Array.from({ length: 60 }, (_, k) => `test("rule1 case ${k}", () => expect(applyRule1(${k}, 50)).toBe(${Math.min(k, 50) * 3}));`).join("\n")}\n` },
  ];
  for (const f of nonCode) {
    files.push({ ...f, language: f.path.split(".").pop() });
    const n = f.content.split("\n").length;
    diffs.push(`--- ${f.path}\n@@ -1,2 +1,3 @@\n ${f.content.split("\n")[0]}\n+${f.content.split("\n")[1] ?? ""}\n ${f.content.split("\n")[2] ?? ""}`.replace(/@@ -1,2 \+1,3 @@/, `@@ -1,2 +1,${Math.min(3, n)} @@`));
  }
  const referenceFiles = [];
  for (let j = 1; j <= 10; j += 1) referenceFiles.push({ path: `src/pipeline/p${j}.ts`, content: callerSource(j, mods), language: "ts" });
  referenceFiles.push({ path: "src/shared/math.ts", content: "export function clamp(v: number, lo: number, hi: number): number {\n  return Math.max(lo, Math.min(hi, v));\n}\n", language: "ts" });
  referenceFiles.push({ path: "src/shared/audit.ts", content: "export function audit(rule: string, value: number): void {\n  void rule;\n  void value;\n}\n", language: "ts" });
  const basePolicyFiles = [
    { path: "CLAUDE.md", content: docText("Repository rules", 14, 12), language: "md" },
    { path: "src/feature/CLAUDE.md", content: docText("Feature module rules", 10, 12), language: "md" },
  ];
  const body = [
    "## Summary",
    para("summary", 6),
    "## Changes",
    ...mods.map((i) => `- mod${i}: clamp the input to the [0, limit] window. ${para(`change ${i}`, 3)}`),
    "## Testing",
    para("testing", 8),
    "## Design",
    "DESIGN_NOTE: the clamp is intentional — negative inputs are rejected upstream, and the old Math.min path stays behind a default-off flag until the follow-up PR removes it.",
    "## Notes",
    para("notes", 40),
  ].join("\n\n");
  return {
    key: "large", owner: "synthetic", repo: "rules", pr: 7, title: "Clamp every rule input", body, sender: "author",
    headSha: "1234567890abcdef", baseSha: "fedcba0987654321", isFork: false, isDraft: false, labels: [],
    changedPaths: [...mods.map((i) => `src/feature/mod${i}.ts`), ...nonCode.map((f) => f.path)],
    files,
    referenceFiles,
    basePolicyFiles,
    diff: diffs.join("\n"),
    diffDroppedPaths: [],
  };
}
