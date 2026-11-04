import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEvidenceQuotes,
  findingPrecisionNote,
  GATE_MODES,
  normalizeGateMode,
  findPriorDuplicate,
  gateFindings,
  gateStatsLine,
  mergeGateStats,
  summarizeGate,
  type GateContext,
  type GateOptions,
} from "./finding-gate.ts";
import type { Finding } from "./types.ts";

// Synthetic snapshot: a changed order module, an unchanged pricing helper it imports, and the
// module's CLAUDE.md, which this PR also changes.
const SUBMIT = `import { saveOrder } from "./store";
import { readTotal } from "../pricing/total";

export async function submitOrder(cart: Cart, user: User) {
  const total = readTotal(cart);
  if (!user.verified) throw new Error("unverified user");
  await saveOrder({ userId: user.id, total, items: cart.items });
  logger.info("order saved", { userId: user.id });
  return { ok: true, total };
}
`;
const TOTAL = `export function readTotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;
const DOC = `# Orders module

submitOrder throws on an unverified user so the caller shows the sign-in prompt.
`;
const DIFF = `diff --git a/src/orders/submit.ts b/src/orders/submit.ts
--- a/src/orders/submit.ts
+++ b/src/orders/submit.ts
@@ -3,6 +3,8 @@ import { readTotal } from "../pricing/total";
 export async function submitOrder(cart: Cart, user: User) {
   const total = readTotal(cart);
-  await saveOrder({ userId: user.id, items: cart.items });
+  if (!user.verified) throw new Error("unverified user");
+  await saveOrder({ userId: user.id, total, items: cart.items });
+  logger.info("order saved", { userId: user.id });
   return { ok: true, total };
 }
diff --git a/src/orders/CLAUDE.md b/src/orders/CLAUDE.md
--- a/src/orders/CLAUDE.md
+++ b/src/orders/CLAUDE.md
@@ -1,1 +1,3 @@
 # Orders module
+
+submitOrder throws on an unverified user so the caller shows the sign-in prompt.
`;

function ctx(extra: Partial<GateContext> = {}): GateContext {
  return {
    headFiles: new Map([
      ["src/orders/submit.ts", SUBMIT],
      ["src/pricing/total.ts", TOTAL],
      ["src/orders/CLAUDE.md", DOC],
    ]),
    changedPaths: ["src/orders/submit.ts", "src/orders/CLAUDE.md"],
    diff: DIFF,
    headSha: "1111111aaaaaaa",
    ...extra,
  };
}

const ON: GateOptions = { mode: "rules", p1ClosedPath: true, notes: true, dedupePrior: true };
/** Evidence verified at head but only in UNCHANGED code (the pricing helper). */
const UNCHANGED_EV = "src/pricing/total.ts:2 `return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);`";

let n = 0;
function mk(p: Partial<Finding> = {}): Finding {
  n += 1;
  return {
    id: `f-${n}`,
    status: "accepted",
    severity: "P1",
    file: "src/orders/submit.ts",
    line: 7,
    side: "RIGHT",
    title: "Order total is saved before the stock check",
    failureScenario: "Two carts reserving the last item both save an order; the second customer is charged for stock that does not exist.",
    rootCause: "saveOrder runs before any stock reservation.",
    evidence: "src/orders/submit.ts:7 `await saveOrder({ userId: user.id, total, items: cart.items });`",
    recommendedFix: "Reserve stock first.",
    recommendedTest: "Two concurrent submits for one remaining item: one fails.",
    ...p,
  };
}

function one(f: Finding, c: GateContext = ctx(), o: GateOptions = ON) {
  const r = gateFindings([f], c, o);
  assert.equal(r.decisions.length, 1);
  return r.decisions[0];
}

describe("finding gate: mode", () => {
  it("off is the identity: everything kept, no notes, no reasons", () => {
    const fs = [mk({ rootCause: "unverified dependency" }), mk({ title: "Rename variable" })];
    const r = gateFindings(fs, ctx(), { ...ON, mode: "off" });
    assert.deepEqual(r.kept, fs);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.dropped, []);
    assert.ok(r.decisions.every((d) => d.action === "keep" && d.reasons.length === 0));
  });

  it("has exactly two modes, and a stored legacy \"refute\" reads as rules", () => {
    assert.deepEqual([...GATE_MODES], ["off", "rules"]);
    assert.equal(normalizeGateMode("refute"), "rules");
    assert.equal(normalizeGateMode("off"), "off");
    assert.equal(normalizeGateMode("rules"), "rules");
    assert.equal(normalizeGateMode("strict"), "rules");
    assert.equal(normalizeGateMode(undefined, "off"), "off");
  });

  it("keeps a concrete finding whose quote sits on a changed line, at P1", () => {
    const d = one(mk());
    assert.equal(d.action, "keep");
    assert.equal(d.finding.severity, "P1");
  });
});

describe("finding gate: R1 speculation", () => {
  it("drops an admitted-unverified premise (English) without a changed-line quote", () => {
    const d = one(mk({ rootCause: "Whether the controller registers this guard is unverified; if it does not, orders save without auth.", evidence: UNCHANGED_EV }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "speculative");
  });

  it("reads a bare 'unverified' as a weak hedge when a verified quote sits on a changed line", () => {
    // The quote ties the claim to code this PR changed: kept (C2 may demote the hedged P1 headline).
    const d = one(mk({ rootCause: "Whether the controller registers this guard is unverified; if it does not, orders save without auth." }));
    assert.notEqual(d.action, "drop", JSON.stringify(d.reasons));
    for (const title of ["Request body is passed unverified to saveOrder", "Order saved while the account email is still unverified", "Webhook payload accepted unverified"]) {
      const k = one(mk({ title }));
      assert.equal(k.action, "keep", `${title} -> ${k.reasons.join("; ")}`);
      assert.equal(k.finding.severity, "P1", title);
    }
    // Without a changed-line quote the same wording is still speculation (R1 as before).
    assert.equal(one(mk({ title: "Request body is passed unverified to saveOrder", evidence: UNCHANGED_EV })).reasons[0], "speculative");
  });

  it("still drops a headline that admits the subject is unverified, whatever the quotes", () => {
    for (const title of ["Spec expects the audit row but the service implementation is unverified", "Order save relies on the unverified helper in the store"]) {
      const d = one(mk({ title }));
      assert.equal(d.action, "drop", title);
      assert.equal(d.reasons[0], "speculative", title);
    }
  });

  it("keeps a security capability stated with 'could' at P1 when a changed-line quote proves it", () => {
    const d = one(mk({ title: "Attackers could bypass the verified-user check", failureScenario: "An unverified account submits an order by retrying.", rootCause: "The check runs after saveOrder." }));
    assert.equal(d.action, "keep", JSON.stringify(d.reasons));
    assert.equal(d.finding.severity, "P1");
    // Without a changed-line quote "could" is still a hedge.
    assert.equal(one(mk({ title: "Attackers could bypass the verified-user check", evidence: UNCHANGED_EV })).reasons[0], "speculative");
    // A non-security "could" headline is still only a possibility.
    assert.equal(one(mk({ title: "Rolled-back save could leave the order row behind" })).reasons[0], "speculative");
  });

  it("drops 'not in the reviewed group' / 'not present in the snapshot'", () => {
    assert.equal(one(mk({ failureScenario: "The route handler is not in the reviewed group, so the input may be unvalidated." })).reasons[0], "speculative");
    assert.equal(one(mk({ rootCause: "The store implementation is not present in the snapshot." })).reasons[0], "speculative");
  });

  it("drops a Korean admission (미확인 / 확인할 수 없)", () => {
    assert.equal(one(mk({ rootCause: "호출부 등록 여부 미확인 — 등록되지 않으면 인증 없이 저장됩니다." })).reasons[0], "speculative");
    assert.equal(one(mk({ rootCause: "store 구현을 확인할 수 없어 트랜잭션 보장이 불분명합니다." })).reasons[0], "speculative");
  });

  it("does not read 'unverified' describing the code's own data as a reviewer admission", () => {
    const d = one(mk({ title: "Order saved for an unverified user", rootCause: "The user is unverified when the retry path calls saveOrder." }));
    assert.notEqual(d.reasons[0], "speculative");
  });

  it("ignores a hedge word inside quoted code", () => {
    const d = one(mk({ rootCause: "`if (!user.verified) throw new Error(\"unverified user\");` runs after readTotal, so the total is computed for every request." }));
    assert.notEqual(d.reasons[0], "speculative");
  });

  it("drops a weak hedge ('may') when no verified quote sits on a changed line", () => {
    const d = one(mk({
      rootCause: "readTotal may return NaN for an item without a price.",
      evidence: "src/pricing/total.ts:2 `return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);`",
    }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "speculative");
  });

  it("keeps a weakly hedged claim proven by a changed-line quote, but not at P1", () => {
    const d = one(mk({ rootCause: "saveOrder may run twice when the client retries." }));
    assert.equal(d.action, "demote");
    assert.equal(d.finding.severity, "P2");
    assert.ok(d.reasons.some((r) => /hedged claim/.test(r)));
  });
});

describe("finding gate: R1 speculation (integration tuning)", () => {
  it("drops a finding whose title is only a possibility, even with a changed-line quote", () => {
    for (const title of ["Rolled-back save may leave the order row behind", "Retry might double the total", "재고 검사가 누락된 상태일 수 있음"]) {
      const d = one(mk({ title }));
      assert.equal(d.action, "drop", title);
      assert.equal(d.reasons[0], "speculative", title);
      assert.match(d.reasons[1], /title:/, title);
    }
  });

  it("reads Korean 아마 / 추정 as a hedge only in their hedging forms", () => {
    // Not hedges: a word that contains 아마 (아마존) and 추정 naming a value (추정 시간, 추정치).
    assert.equal(one(mk({ title: "아마존 S3 업로드 실패 시 주문 총액이 저장되지 않음" })).action, "keep");
    assert.equal(one(mk({ title: "배송 추정 시간이 두 배로 저장됨" })).action, "keep");
    assert.equal(one(mk({ rootCause: "추정치가 아니라 실제 total을 재고 확인 전에 저장한다." })).action, "keep");
    // Hedges: still a possibility in the headline / the claim.
    assert.equal(one(mk({ title: "아마 재고 확인 전에 주문이 저장됨" })).reasons[0], "speculative");
    assert.equal(one(mk({ title: "재고 확인 전에 주문이 저장되는 것으로 추정됨" })).reasons[0], "speculative");
    assert.equal(one(mk({ rootCause: "재시도 경로에서 저장이 두 번 일어나는 것으로 추정된다." })).action, "demote");
  });

  it("keeps a title whose condition is the failure trigger or the code's own assumption", () => {
    // Not dropped by the title rule (C2 may still demote a hedged P1 headline to P2).
    assert.notEqual(one(mk({ title: "Submit crashes if the cart does not exist" })).action, "drop");
    assert.notEqual(one(mk({ title: "submitOrder assumes every item has a price" })).action, "drop");
    assert.equal(one(mk({ title: "Order save could not be retried after a timeout" })).action, "keep");
  });

  it("reads single-quoted state or code as a quote, not as the reviewer's voice", () => {
    const d = one(mk({ rootCause: "The caller cannot tell 'order was not saved' from 'save could not be confirmed', so it retries a saved order." }));
    assert.equal(d.action, "keep", JSON.stringify(d.reasons));
  });

  it("keeps an apostrophe-heavy claim intact (no false quote pairing)", () => {
    const d = one(mk({ rootCause: "The store's retry doesn't check the user's state; whether it re-validates is unverified.", evidence: UNCHANGED_EV }));
    assert.equal(d.reasons[0], "speculative");
  });

  it("reads attributive 'an unverified <data>' as the code's data, but 'the unverified helper' as an admission", () => {
    assert.equal(one(mk({ failureScenario: "The order is dropped over an unverified read of the stock table, not a real shortage." })).action, "keep");
    assert.equal(one(mk({ rootCause: "The failure depends on the unverified helper that persists the order.", evidence: UNCHANGED_EV })).reasons[0], "speculative");
  });
});

describe("finding gate: R2 self-retraction", () => {
  it("drops a finding that concludes there is no defect", () => {
    const d = one(mk({
      rootCause: "Wait — re-reading the guard, it already returns early, so this path is safe.",
      recommendedFix: "No change needed.",
      recommendedTest: "n/a",
    }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "self_retracted");
  });

  it("drops a no-op fix and a Korean retraction", () => {
    assert.equal(one(mk({ recommendedFix: "none" })).reasons[0], "self_retracted");
    assert.equal(one(mk({ rootCause: "가드가 먼저 실행되므로 문제 없음.", recommendedFix: "수정 불필요" })).reasons[0], "self_retracted");
  });

  it("keeps a finding that only contrasts a safe path with the broken one", () => {
    const d = one(mk({ rootCause: "The sync path is safe, but the retry path saves the order a second time." }));
    assert.notEqual(d.reasons[0], "self_retracted");
  });

  it("reads only the claim: a fix or test plan that says what is safe or needs no change does not retract", () => {
    for (const patch of [
      { recommendedFix: "Reserve stock before saveOrder; no code changes needed in callers." },
      { recommendedFix: "saveOrder 전에 재고를 예약하면 안전합니다." },
      { recommendedTest: "재고가 충분한 주문은 문제 없음, 마지막 재고 1개에 동시 주문 2건 중 1건만 성공하는지 확인" },
      { failureScenario: "Two carts reserving the last item both save an order. The rest of this code is fine." },
    ] as Partial<Finding>[]) {
      const d = one(mk(patch));
      assert.equal(d.action, "keep", `${JSON.stringify(patch)} -> ${d.reasons.join("; ")}`);
    }
  });

  it("reads a Korean verdict as a retraction only when it concludes the finding itself", () => {
    // Contrast / another path: not a retraction.
    for (const rootCause of [
      "현금 주문은 안전하다. 그러나 카드 주문은 재고 확인 없이 저장된다.",
      "조회 경로는 문제 없다. 하지만 재시도 경로는 주문을 두 번 저장한다.",
      "부분 저장은 안전합니다 — 전체 저장은 재고 확인 전에 일어납니다.",
    ]) {
      assert.equal(one(mk({ rootCause })).action, "keep", rootCause);
    }
    // The finding's own path, a conclusion, or a no-change verdict: a retraction.
    for (const rootCause of ["가드가 먼저 실행되므로 이 경로는 안전합니다.", "재고 확인이 이미 앞에서 이뤄진다. 따라서 문제 없음.", "문제 없습니다.", "재시도는 멱등이라 수정 불필요."]) {
      assert.equal(one(mk({ rootCause })).reasons[0], "self_retracted", rootCause);
    }
    assert.equal(one(mk({ recommendedFix: "수정할 필요 없음" })).reasons[0], "self_retracted");
  });
});

describe("finding gate: R3 evidence verification", () => {
  it("drops quotes that do not exist at head", () => {
    const d = one(mk({ evidence: "src/orders/submit.ts:7 `await saveOrder(order, { retries: 3 });`" }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "evidence_unverified");
  });

  it("drops evidence with no code quote at all", () => {
    assert.equal(one(mk({ evidence: "src/orders/submit.ts:7-9 saves before reserving" })).reasons[0], "evidence_unverified");
  });

  it("drops as unavailable when neither the cited file nor a quote can be checked", () => {
    const d = one(mk({ file: "src/other/missing.ts", evidence: "src/other/missing.ts:4 `doThing(input, { force: true });`" }));
    assert.equal(d.reasons[0], "evidence_unavailable");
  });

  it("keeps a concrete finding quoting two locations, one in an unchanged reference file", () => {
    const d = one(mk({
      title: "Free items make the order total wrong",
      evidence:
        "src/orders/submit.ts:7 `await saveOrder({ userId: user.id, total, items: cart.items });` | src/pricing/total.ts:2 `return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);`",
    }));
    assert.equal(d.action, "keep");
    assert.equal(d.finding.severity, "P1");
  });

  it("verifies whitespace-normalized, ellipsis-split and removed-line quotes", () => {
    assert.equal(one(mk({ evidence: "submit.ts:7 \"await   saveOrder({ userId: user.id, total, items: cart.items });\"" })).action, "keep");
    assert.equal(one(mk({ evidence: "`await saveOrder({ userId: user.id, ... items: cart.items });`" })).action, "keep");
    assert.equal(one(mk({ evidence: "the PR removed `await saveOrder({ userId: user.id, items: cart.items });`" })).action, "keep");
  });

  it("keeps a spread (`...rows`) intact while splitting on a reviewer's elision", () => {
    assert.ok(extractEvidenceQuotes("`out.push(...rows);`").includes("out.push(...rows)"));
    assert.ok(extractEvidenceQuotes("`await saveOrder({ userId: user.id, ... })`").includes("await saveOrder({ userId: user.id"));
  });

  it("extracts locator, backtick, quoted and fenced quotes", () => {
    assert.deepEqual(extractEvidenceQuotes("a.ts:3 `const x = f(a);` | b.ts:9-10 return y ? z : [];"), ["const x = f(a)", "return y ? z : []"]);
    assert.ok(extractEvidenceQuotes("```ts\nconst a = b(c);\n```").includes("const a = b(c)"));
  });

  it("skips verification only when there is no head content and no diff at all", () => {
    const d = one(mk({ evidence: "no quote" }), { headFiles: new Map(), changedPaths: ["src/orders/submit.ts"], diff: "" });
    assert.notEqual(d.action, "drop");
    assert.ok(d.reasons.some((r) => r.startsWith("evidence_unchecked")));
  });
});

describe("finding gate: R4 diff-contradicted claims", () => {
  it("drops 'CLAUDE.md not updated' when the module's CLAUDE.md is in this PR", () => {
    const d = one(mk({ severity: "P2", title: "CLAUDE.md not updated for the new verified-user rule", rootCause: "The module CLAUDE.md was not updated to describe the new throw." }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "contradicted_by_diff");
  });

  it("drops a Korean 'PR diff에 … 수정이 없' claim about a changed doc", () => {
    const d = one(mk({ severity: "P2", title: "문서 누락", rootCause: "PR diff에 src/orders/CLAUDE.md 수정이 없으며 새 동작이 문서화되지 않았습니다." }));
    assert.equal(d.reasons[0], "contradicted_by_diff");
  });

  it("reads 'needs update' as a doc claim only when the doc is the finding's subject", () => {
    // The doc is cited as the source of an expectation: a code claim, not a docs-not-updated claim.
    const cited = one(mk({ title: "Order total must be updated after a discount", rootCause: "As src/orders/CLAUDE.md states, totals are final at save time, but saveOrder stores the pre-discount total." }));
    assert.notEqual(cited.reasons[0], "contradicted_by_diff", JSON.stringify(cited.reasons));
    // The doc is the subject (named in the title before the phrase, or after "update"): contradicted.
    for (const title of ["src/orders/CLAUDE.md needs an update for the verified-user rule", "CLAUDE.md 갱신 필요 — 새 throw 규칙", "Update CLAUDE.md for the verified-user rule"]) {
      const d = one(mk({ severity: "P2", title, rootCause: "The module CLAUDE.md should be updated to describe the new throw." }));
      assert.equal(d.reasons[0], "contradicted_by_diff", title);
    }
  });

  it("never judges a stale call site claim inside a changed code file", () => {
    for (const rootCause of [
      "The retry call site in src/orders/submit.ts was not updated to pass the total.",
      "The PR does not update the call site in src/orders/submit.ts, so the old signature is still used.",
      "이 PR에서 src/orders/submit.ts의 재시도 호출부가 수정되지 않아 total이 전달되지 않습니다.",
    ]) {
      assert.notEqual(one(mk({ rootCause })).reasons[0], "contradicted_by_diff", rootCause);
    }
  });

  it("drops a claim that a changed code file is absent from the PR", () => {
    const d = one(mk({ rootCause: "src/orders/submit.ts is not part of this PR, so the guard never ships." }));
    assert.equal(d.reasons[0], "contradicted_by_diff");
  });
});

describe("finding gate: R5 own-reply contradiction", () => {
  const intent = (note: string) => ctx({ investigatedSafe: [note] });
  const throwFinding = (p: Partial<Finding> = {}) =>
    mk({ title: "submitOrder throws on an unverified user", rootCause: "The throw aborts the request instead of returning an error.", evidence: UNCHANGED_EV, ...p });

  it("drops a finding the same reply's investigated_safe note calls intended behaviour", () => {
    for (const note of [
      "src/orders/CLAUDE.md documents that submitOrder throws on an unverified user by design",
      "src/orders/submit.ts: submitOrder throws on an unverified user — intended, the caller shows the sign-in prompt",
    ]) {
      const d = one(throwFinding(), intent(note));
      assert.equal(d.action, "drop", note);
      assert.equal(d.reasons[0], "contradicted_by_own_reply", note);
    }
  });

  it("never drops a finding proven by a verified quote on a changed line", () => {
    const d = one(throwFinding({ evidence: "src/orders/submit.ts:6 `if (!user.verified) throw new Error(\"unverified user\");`" }),
      intent("src/orders/CLAUDE.md documents that submitOrder throws on an unverified user by design"));
    assert.equal(d.action, "keep", JSON.stringify(d.reasons));
  });

  it("reads only explicit design intent about the same behaviour, never coverage rows or 'safe'/'handled' notes", () => {
    const f = throwFinding();
    for (const c of [
      // Not intent: says the path is fine.
      intent("src/orders/submit.ts: submitOrder throws on an unverified user; the error is handled and safe"),
      intent("src/orders/submit.ts: unverified user throw is expected and guarded by the caller's retry"),
      // Intent, but about other behaviour (the title is not the clause).
      intent("src/orders/submit.ts: logging only the user id is intended"),
      // A coverage row, even a cleared one that says "by design".
      ctx({ coverage: [{ path: "src/orders/CLAUDE.md", status: "cleared", reason: "documents that submitOrder throws on an unverified user by design" }] }),
    ]) {
      const d = one(f, c);
      assert.notEqual(d.reasons[0], "contradicted_by_own_reply", JSON.stringify(c.investigatedSafe ?? c.coverage));
    }
  });
});

describe("finding gate: C1 notes", () => {
  const cases: [string, Partial<Finding>, string][] = [
    ["docs file", { file: "src/orders/CLAUDE.md", line: 3, title: "Doc wording is vague", evidence: "src/orders/CLAUDE.md:3 \"submitOrder throws on an unverified user so the caller shows the sign-in prompt.\"" }, "note:docs"],
    ["i18n", { severity: "P2", title: "Hard-coded Korean text in the confirmation email", rootCause: "The subject string is not localized." }, "note:i18n"],
    ["style", { title: "Ref assigned during render", rootCause: "A ref is written in the render body instead of an effect." }, "note:style"],
    ["log wording", { title: "Log message wording is misleading", rootCause: "The log line says saved before the commit." }, "note:log"],
    ["test advice", { title: "Spec does not verify the unverified-user branch", rootCause: "No test covers the throw." }, "note:test"],
  ];
  for (const [name, patch, reason] of cases) {
    it(`routes ${name} to notes`, () => {
      const d = one(mk(patch));
      assert.equal(d.action, "note", JSON.stringify(d.reasons));
      assert.equal(d.reasons[0], reason);
    });
  }

  // A note-category remark with no verifiable quote (none, or one that is not at head) is still a note:
  // R3 exists to stop unproven DEFECT claims, and a note is never counted or posted inline.
  const noQuote: [string, Partial<Finding>, string][] = [
    ["style without a quote", { title: "Ref assigned during render", rootCause: "A ref is written in the render body instead of an effect.", evidence: "src/orders/submit.ts:7 ref written in render" }, "note:style"],
    ["log wording with an unverifiable quote", { severity: "P2", title: "Log message wording is misleading", rootCause: "The log line says saved before the commit.", evidence: "src/orders/submit.ts:9 `logger.info(\"order persisted\", { id });`" }, "note:log"],
    ["i18n with prose evidence", { severity: "P2", title: "Hard-coded Korean text in the confirmation email", rootCause: "The subject string is not localized.", evidence: "the email subject is a literal" }, "note:i18n"],
    ["test advice with no evidence", { title: "Spec does not verify the unverified-user branch", rootCause: "No test covers the throw.", evidence: "" }, "note:test"],
    ["docs with an unverifiable quote", { file: "src/orders/CLAUDE.md", line: 3, title: "Doc wording is vague", evidence: "src/orders/CLAUDE.md:3 \"the caller retries the order on any failure\"" }, "note:docs"],
  ];
  for (const [name, patch, reason] of noQuote) {
    it(`routes ${name} to notes instead of dropping it as unverified`, () => {
      const d = one(mk(patch));
      assert.equal(d.action, "note", JSON.stringify(d.reasons));
      assert.equal(d.reasons[0], reason);
      assert.ok(d.reasons.some((r) => r.startsWith("note_evidence_unverified")), JSON.stringify(d.reasons));
    });
  }

  it("still drops a defect claim without a verified quote, and keeps the unverified reason when notes are off", () => {
    assert.equal(one(mk({ evidence: "src/orders/submit.ts:7-9 saves before reserving" })).reasons[0], "evidence_unverified");
    const style = mk({ title: "Ref assigned during render", rootCause: "A ref is written in the render body instead of an effect.", evidence: "ref written in render" });
    assert.equal(one(style, ctx(), { ...ON, notes: false }).reasons[0], "evidence_unverified");
  });

  it("classifies by the claim: a real defect in a test file stays a finding", () => {
    const c = ctx();
    c.headFiles.set("src/orders/submit.test.ts", "export function fakeClock() {\n  return { advance: (ms: number) => timers.filter((t) => t.at < now + ms).forEach(run) };\n}\n");
    c.changedPaths.push("src/orders/submit.test.ts");
    const d = one(mk({
      file: "src/orders/submit.test.ts",
      line: 2,
      title: "fakeClock never fires timers due exactly at the deadline",
      rootCause: "The filter uses < instead of <=, so a timer due at now + ms never runs and the retry test passes without retrying.",
      evidence: "src/orders/submit.test.ts:2 `return { advance: (ms: number) => timers.filter((t) => t.at < now + ms).forEach(run) };`",
    }), c);
    assert.notEqual(d.action, "note");
  });

  it("routes coverage advice on a test file to notes even when it names a failure path", () => {
    const c = ctx();
    c.headFiles.set("src/orders/submit.spec.ts", "it('saves', async () => {\n  await submitOrder(cart, user);\n});\n");
    c.changedPaths.push("src/orders/submit.spec.ts");
    const d = one(mk({
      file: "src/orders/submit.spec.ts",
      line: 2,
      severity: "P2",
      title: "Spec mocks the store but not the stock rules",
      failureScenario: "If saveOrder throws for an empty cart, the spec does not exercise that path.",
      rootCause: "The store layer is mocked entirely.",
      evidence: "src/orders/submit.spec.ts:2 `await submitOrder(cart, user);`",
      recommendedFix: "Add a spec case that makes saveOrder throw and asserts the error propagates.",
    }), c);
    assert.equal(d.action, "note", JSON.stringify(d.reasons));
    assert.equal(d.reasons[0], "note:test");
  });

  it("routes a claim about what a log line reports to notes", () => {
    const d = one(mk({ severity: "P2", title: "Log reports saved=0 when the lock is not acquired", rootCause: "The finally block logs the same line for a skipped run and an empty run." }));
    assert.equal(d.action, "note", JSON.stringify(d.reasons));
    assert.equal(d.reasons[0], "note:log");
  });

  it("keeps security claims that only look like log or text findings", () => {
    assert.notEqual(one(mk({ title: "Log line writes the user's password", rootCause: "The log message includes the password field." })).action, "note");
    assert.notEqual(one(mk({ title: "Hard-coded API key in the request", rootCause: "A secret key is committed." })).action, "note");
  });

  it("matches categories on the title and reads defect cues across the whole claim", () => {
    for (const patch of [
      { title: "Misleading variable name hides a doubled order total", failureScenario: "A cart of 10 is saved with a total of 20." },
      { title: "Order total is saved twice; no test covers it" },
      { title: "Renaming the total field breaks the receipt mail", failureScenario: "Receipts render an empty amount." },
      { title: "Order total is saved before the stock check", rootCause: "saveOrder runs before the reservation; there is no test for the last-item case." },
      { title: "번역된 주문 총액이 두 배로 저장됨", failureScenario: "10원 주문이 20원으로 저장된다." },
      { title: "Readability of submitOrder: the total is computed incorrectly for free items", failureScenario: "A cart with a free item is saved with a wrong total." },
    ] as Partial<Finding>[]) {
      const d = one(mk(patch));
      assert.equal(d.action, "keep", `${patch.title} -> ${d.reasons.join("; ")}`);
    }
  });

  it("never routes a P0/P1 proven on a changed line that states a failure outcome to notes", () => {
    const f = { title: "Readability refactor of submitOrder: guest orders are not saved", failureScenario: "A guest checkout shows success but the order is not saved." };
    assert.equal(one(mk(f)).action, "keep");
    // The same remark at P2, or without a changed-line quote, is still a style note.
    assert.equal(one(mk({ ...f, severity: "P2" })).reasons[0], "note:style");
    assert.equal(one(mk({ ...f, evidence: UNCHANGED_EV })).reasons[0], "note:style");
    // A pure lint remark at P1 with a changed-line quote and no failure outcome is still a note.
    assert.equal(one(mk({ title: "Ref assigned during render", failureScenario: "React strict mode double-invokes render and the linter flags the write." })).reasons[0], "note:style");
  });

  it("leaves categories as findings when notes are off", () => {
    assert.notEqual(one(mk({ title: "Ref assigned during render" }), ctx(), { ...ON, notes: false }).action, "note");
  });
});

describe("finding gate: C2 P1 closed path", () => {
  it("demotes a P1 whose only verified quote is in unchanged code", () => {
    const d = one(mk({ title: "Order totals ignore discounts", evidence: "src/pricing/total.ts:2 `return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);`" }));
    assert.equal(d.action, "demote");
    assert.equal(d.severityBefore, "P1");
    assert.equal(d.severityAfter, "P2");
    assert.equal(d.reasons[0], "p1_path_not_closed");
  });

  it("does not demote when the switch is off, and never touches a P2", () => {
    const f = mk({ evidence: "src/pricing/total.ts:2 `return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);`" });
    assert.equal(one(f, ctx(), { ...ON, p1ClosedPath: false }).action, "keep");
    assert.equal(one({ ...f, severity: "P2", id: "p2" }).action, "keep");
  });
});

describe("finding gate: D dedupe against prior findings", () => {
  it("drops a finding the bot posted on an earlier head (near-identical title)", () => {
    const d = one(mk(), ctx({ priorFindings: [{ file: "src/orders/submit.ts", title: "Order total saved before the stock check", commitId: "0000000bbbbbbb" }] }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "already_reported");
  });

  it("drops a re-review of the same head that quotes the same code under another title", () => {
    const d = one(mk(), ctx({ priorFindings: [{ file: "src/orders/submit.ts", title: "Stock race on checkout", evidence: "`await saveOrder({ userId: user.id, total, items: cart.items });`", commitId: "1111111aaaaaaa" }] }));
    assert.equal(d.reasons[0], "already_reported");
    assert.match(d.reasons[1], /this head/);
  });

  it("drops a reworded repeat posted on the same line with the same short quote, but not on another line", () => {
    const f = mk({ severity: "P2", line: 5, title: "Total computed before the user check", evidence: "src/orders/submit.ts:5 `readTotal(cart)`" });
    const prior = (line: number) => [{ file: "src/orders/submit.ts", line, title: "Total is computed ahead of user validation", evidence: "src/orders/submit.ts:5 (`readTotal(cart)`)", commitId: "0000000bbbbbbb" }];
    const d = one(f, ctx({ priorFindings: prior(5) }));
    assert.equal(d.action, "drop");
    assert.equal(d.reasons[0], "already_reported");
    assert.equal(one(f, ctx({ priorFindings: prior(6) })).action, "keep");
    const otherClaim = [{ ...prior(5)[0], title: "Discount rules ignored for gift cards" }];
    assert.equal(one(f, ctx({ priorFindings: otherClaim })).action, "keep", "a different claim about the same line is new");
  });

  it("does not tie two findings by a similar title alone", () => {
    // Jaccard 0.6: the same failure in another function is another finding.
    const prior = [{ file: "src/orders/submit.ts", title: "Unhandled promise rejection in submitOrder", commitId: "0000000bbbbbbb" }];
    const f = mk({ title: "Unhandled promise rejection in readTotal" });
    assert.equal(one(f, ctx({ priorFindings: prior })).action, "keep");
    // …but it is a repeat on the same posted line, or quoting the same code.
    assert.equal(one(f, ctx({ priorFindings: [{ ...prior[0], line: f.line }] })).reasons[0], "already_reported");
    assert.equal(one(f, ctx({ priorFindings: [{ ...prior[0], evidence: "`items: cart.items });`" }] })).reasons[0], "already_reported");
  });

  it("keeps a different file or a different claim, and everything when dedupe is off", () => {
    const prior = [{ file: "src/orders/submit.ts", title: "Order total saved before the stock check" }];
    assert.equal(findPriorDuplicate(mk({ file: "src/orders/other.ts" }), { priorFindings: prior }), undefined);
    assert.equal(findPriorDuplicate(mk({ title: "Unverified users can still save drafts" }), { priorFindings: prior }), undefined);
    assert.equal(one(mk(), ctx({ priorFindings: prior }), { ...ON, dedupePrior: false }).action, "keep");
  });
});

// Recall guards: wording that describes the CODE must never read as the reviewer hedging, retracting,
// or nitpicking.
describe("finding gate: recall guards", () => {
  it("keeps code-voice phrasing that resembles an admission or a retraction", () => {
    for (const rootCause of [
      "The validator didn't check the length, so an empty cart reaches saveOrder.",
      "When the cache did not find the key, the handler saves a zero total.",
      "The retry loop keeps re-reading the cart on every attempt and saves twice.",
      "The duplicate detector reports a false positive for carts with one item, so the order is rejected.",
      "The sync path is safe, but the retry path saves the order a second time.",
      "This path is safe for cash orders but card orders skip the stock check.",
    ]) {
      const d = one(mk({ rootCause }));
      assert.equal(d.action, "keep", `${rootCause} -> ${d.reasons.join("; ")}`);
    }
  });

  it("keeps a defect whose title happens to use a style word", () => {
    const d = one(mk({ title: "Naming collision routes orders to the wrong handler", rootCause: "Two exports named submitOrder: the import resolves to the legacy one." }));
    assert.equal(d.action, "keep");
  });

  it("verifies a quote that re-spaces punctuation or swaps quote style", () => {
    assert.equal(one(mk({ evidence: "`await saveOrder( { userId: user.id, total, items: cart.items } )`" })).action, "keep");
    assert.equal(one(mk({ evidence: "`if (!user.verified) throw new Error('unverified user');`" })).action, "keep");
  });

  it("does not tie two findings together by a short common line", () => {
    const prior = [{ file: "src/orders/submit.ts", title: "Something else entirely", evidence: "`return { ok: true, total };`" }];
    const f = mk({ title: "Total is returned before the save settles", evidence: "`await saveOrder({ userId: user.id, total, items: cart.items });` then `return { ok: true, total };`" });
    assert.equal(one(f, ctx({ priorFindings: prior })).action, "keep");
  });
});

describe("finding gate: reporting", () => {
  it("summarizes kept / notes / dropped per reason for the ops comment", () => {
    const r = gateFindings(
      [mk(), mk({ title: "Ref assigned during render" }), mk({ rootCause: "unverified premise", evidence: UNCHANGED_EV }), mk({ recommendedFix: "none" })],
      ctx(),
      ON,
    );
    const s = summarizeGate(r);
    assert.deepEqual({ kept: s.kept, notes: s.notes, dropped: s.dropped }, { kept: 1, notes: 1, dropped: 2 });
    assert.equal(s.reasons.speculative, 1);
    assert.equal(s.reasons.self_retracted, 1);
    assert.equal(gateStatsLine(s), "Gate: kept 1, notes 1, dropped 2 (self-retracted 1, speculative 1)");
    const merged = mergeGateStats([s, s, undefined]);
    assert.equal(merged?.dropped, 4);
    assert.equal(mergeGateStats([undefined]), undefined);
  });

  it("applies the rules in the documented order (dedupe before retraction before speculation)", () => {
    const f = mk({ rootCause: "unverified, so this path is safe", recommendedFix: "none" });
    assert.equal(one(f, ctx({ priorFindings: [{ file: f.file, title: f.title }] })).reasons[0], "already_reported");
    assert.equal(one(f).reasons[0], "self_retracted");
  });
});

describe("finding gate: Settings copy", () => {
  it("says the same-head repost skip and latest-head-only still apply with the gate off", () => {
    const off = findingPrecisionNote({ findingGate: "off", findingDedupePrior: true, postLatestHeadOnly: true });
    assert.match(off, /^Gate OFF/);
    assert.match(off, /only repeats findings already posted on this head is still not posted/);
    assert.match(off, /head the PR has moved past is still not posted/);
    assert.doesNotMatch(off, /dedupe switches apply only while the gate is on/);
    const bare = findingPrecisionNote({ findingGate: "off", findingDedupePrior: false, postLatestHeadOnly: false });
    assert.doesNotMatch(bare, /Even with the gate off/);
    assert.match(findingPrecisionNote({ findingGate: "rules" }), /^Gate ON \(rules\)/);
  });
});
