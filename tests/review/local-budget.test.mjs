// The local model's window is ~30K tokens (Settings local_review.single_turn_max_tokens for the one-shot
// leg, ASHLAR_LOCAL_REVIEW_CTX_CAP_TOKENS for the grouped loop). The context sections the chat legs get
// in full (description, module docs, call sites, changed docs) must fit a local request: the single-turn
// prompt stays under the single-turn cap, and every group's first loop request leaves the loop room to
// read files under its context cap. The chat prompt keeps the full sections.
import test from "node:test";
import assert from "node:assert/strict";
import { bridgePromptText, buildChatParts, buildChatPrompt, buildLocalChatPrompt, estimateTokens, LOCAL_CHARS_PER_TOKEN, LOCAL_PR_DESCRIPTION_MAX_CHARS, splitChatAttachments } from "../../src/lib/chat-prompt.ts";
import { chooseLocalReviewMode, localFirstTurnBudgetTokens, runLocalReviewLoop } from "../../src/lib/local-review-loop.server.ts";
import { DEFAULT_SETTINGS } from "../../src/lib/types.ts";
import { largePr } from "./fixtures/large-pr.mjs";
import { appFixture, eventually } from "./app-fixture.mjs";

const settings = { ...DEFAULT_SETTINGS, reviewLocal: true, localLlmBaseUrl: "http://local/v1", localLlmModel: "m", localLlmApiKey: "k" };
const SINGLE_CAP = DEFAULT_SETTINGS.localReviewSingleTurnMaxTokens;
const CTX_CAP = 24_000; // local-review-loop.server.ts default ASHLAR_LOCAL_REVIEW_CTX_CAP_TOKENS
const opts = (sample) => ({ sample, contextMaxChars: settings.promptContextMaxChars, contextPadLines: settings.contextPadLines, policyMaxChars: settings.promptPolicyMaxChars });
const block = (text, marker) => new RegExp(`<<<${marker}>>>\\n([\\s\\S]*?)\\n<<<END>>>`).exec(text)?.[1] ?? "";
const attach = (text, name) => new RegExp(`<<<ATTACH:${name.replace(/\./g, "\\.")}>>>\\n([\\s\\S]*?)\\n<<<END_ATTACH>>>`).exec(text)?.[1] ?? "";
const codePaths = (sample) => sample.changedPaths.filter((p) => p.endsWith(".ts") && !p.includes(".test."));

test("the chat prompt of a large PR keeps the full description, module docs, call sites and changed docs", () => {
  const sample = largePr();
  const parts = buildChatParts(opts(sample));
  const chat = buildChatPrompt(opts(sample));
  assert.ok(estimateTokens(bridgePromptText(chat).length) > SINGLE_CAP, "the fixture is over the local window at chat sizes");
  assert.ok(parts.sections.descriptionChars > 5_000, JSON.stringify(parts.sections));
  assert.ok(parts.sections.callSitesChars > 10_000, JSON.stringify(parts.sections));
  assert.ok(parts.sections.changedDocsChars > 20_000, JSON.stringify(parts.sections));
  assert.equal(parts.sections.nonCodeListed, 0);
  const { files } = splitChatAttachments(chat);
  assert.equal(files.find((f) => f.name === "ashlar-policy.md").body.length, settings.promptPolicyMaxChars);
  assert.match(chat, /DESIGN_NOTE: the clamp is intentional/);
  assert.doesNotMatch(chat, /local context budget/);
});

test("the local single-turn prompt of the same PR stays under the single-turn cap and routes auto to single", () => {
  const sample = largePr();
  const local = buildLocalChatPrompt({ ...opts(sample), localBudget: { maxChars: Math.floor(SINGLE_CAP * LOCAL_CHARS_PER_TOKEN) } });
  assert.ok(estimateTokens(local.length) <= SINGLE_CAP, `${estimateTokens(local.length)} tokens`);
  assert.equal(chooseLocalReviewMode("auto", local.length, SINGLE_CAP), "single");
  // (1) the description: its opening and the design-intent paragraph, at most 1,500 chars
  const description = block(local, "UNTRUSTED_PR_DESCRIPTION");
  assert.ok(description.length <= LOCAL_PR_DESCRIPTION_MAX_CHARS, `${description.length}`);
  assert.match(description, /^## Summary/);
  assert.match(description, /DESIGN_NOTE: the clamp is intentional/);
  // (2) the nearest module doc is in the policy excerpt
  assert.match(attach(local, "ashlar-policy.md"), /--- src\/feature\/CLAUDE\.md/);
  // (3) call sites stay, (4) the changed non-code files are listed by path
  assert.match(block(local, "CALL_SITES"), /applyRule\d+\(x, limit\)/);
  const nonCode = block(local, "CHANGED_NON_CODE_FILES");
  assert.match(nonCode, /not attached in full \(local context budget\); what is not shown is unknown here/);
  for (const p of ["docs/feature-rules.md", "config/rules.json"]) assert.ok(nonCode.includes(p), p);
  // the code context is not cut: every changed code file is in the snapshot whole
  for (const p of codePaths(sample)) assert.ok(local.includes(`--- ${p} (L1-L`), p);
});

test("a PR whose chat prompt already fits gets the chat prompt itself on the local leg", () => {
  const sample = largePr({ codeFiles: 2 });
  sample.body = sample.body.slice(0, 900);
  sample.basePolicyFiles = sample.basePolicyFiles.map((f) => ({ ...f, content: f.content.slice(0, 2_000) }));
  const chat = bridgePromptText(buildChatPrompt(opts(sample)));
  assert.ok(estimateTokens(chat.length) <= SINGLE_CAP);
  assert.equal(buildLocalChatPrompt({ ...opts(sample), localBudget: { maxChars: Math.floor(SINGLE_CAP * LOCAL_CHARS_PER_TOKEN) } }), chat);
});

test("a forced single-turn on a PR too large even for the trimmed sections cuts the code context to the cap", () => {
  const sample = largePr({ codeFiles: 30 });
  const budget = { maxChars: Math.floor(SINGLE_CAP * LOCAL_CHARS_PER_TOKEN) };
  const trimmed = buildLocalChatPrompt({ ...opts(sample), localBudget: budget });
  assert.ok(estimateTokens(trimmed.length) > SINGLE_CAP, "without shrinkContext the code core stays whole (auto routes it to the loop)");
  assert.equal(chooseLocalReviewMode("auto", trimmed.length, SINGLE_CAP), "multiturn");
  const forced = buildLocalChatPrompt({ ...opts(sample), localBudget: { ...budget, shrinkContext: true } });
  assert.ok(estimateTokens(forced.length) <= SINGLE_CAP, `${estimateTokens(forced.length)} tokens`);
  assert.match(forced, /<<<ATTACH:ashlar-diff\.patch>>>/);
});

function reviewJson() {
  return JSON.stringify({ merge_recommendation: "COMMENT", findings: [], investigated_safe: ["checked"], coverage: [] });
}

test("every grouped-loop first request fits under the loop's context cap with room to read files", async () => {
  const sample = largePr();
  const bodies = [];
  const request = async (_b, _k, path, body) => {
    if (path === "models") return { data: [] };
    bodies.push(body);
    return { choices: [{ finish_reason: "stop", message: { content: reviewJson() } }], usage: { prompt_tokens: 100 } };
  };
  await runLocalReviewLoop(sample, { ...settings, localReviewMode: "multiturn" }, { request });
  assert.ok(bodies.length >= 2, `${bodies.length} groups`);
  const firstTurn = localFirstTurnBudgetTokens(settings, CTX_CAP);
  assert.ok(firstTurn < CTX_CAP);
  for (const body of bodies) {
    const chars = body.messages.reduce((n, m) => n + m.content.length, 0);
    assert.ok(Math.ceil(chars / LOCAL_CHARS_PER_TOKEN) <= firstTurn, `${Math.ceil(chars / LOCAL_CHARS_PER_TOKEN)} > ${firstTurn} tokens`);
    assert.ok(body.tools, "the first request offers tools (it is not forced final by the context cap)");
  }
  const codeGroup = bodies[0].messages[1].content;
  assert.match(codeGroup, /Review only: src\/feature\/mod/);
  assert.ok(block(codeGroup, "UNTRUSTED_PR_DESCRIPTION").length <= LOCAL_PR_DESCRIPTION_MAX_CHARS);
  assert.match(block(codeGroup, "UNTRUSTED_PR_DESCRIPTION"), /DESIGN_NOTE/);
  assert.match(block(codeGroup, "CHANGED_NON_CODE_FILES"), /read them with file_read before any claim about them: .*docs\/feature-rules\.md/);
});

test("the harbor's local single-turn request is the fitted prompt while the chat prompt keeps the full sections", async (t) => {
  const sample = largePr();
  const app = await appFixture({ reviewLocal: true, localReviewMode: "auto" }, { snapshot: sample });
  t.after(() => app.close());
  const out = await app.mention("local-budget");
  await eventually(() => app.localRequests.length > 0, "local request was not sent");
  const sent = app.localRequests[0].messages.map((m) => m.content).join("\n");
  assert.equal(app.localRequests[0].tools, undefined, "auto chose the single-turn leg");
  assert.ok(estimateTokens(sent.length) <= SINGLE_CAP, `${estimateTokens(sent.length)} tokens`);
  assert.ok(block(sent, "UNTRUSTED_PR_DESCRIPTION").length <= LOCAL_PR_DESCRIPTION_MAX_CHARS);
  const job = app.harbor.getHarbor().jobs.find((j) => j.id === out.jobId);
  assert.ok(estimateTokens(bridgePromptText(job.chatPrompt).length) > SINGLE_CAP);
  assert.ok(block(job.chatPrompt, "UNTRUSTED_PR_DESCRIPTION").length > 5_000);
  assert.equal(job.promptStats.descriptionChars, block(job.chatPrompt, "UNTRUSTED_PR_DESCRIPTION").length);
  assert.ok(job.promptStats.changedDocsChars > 20_000);
});
