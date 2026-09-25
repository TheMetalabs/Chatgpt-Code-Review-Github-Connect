import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINDING_412 } from "./samples.ts";
import {
  CLEAN_REVIEW_BODY,
  REVIEW_RAW_END,
  REVIEW_RAW_START,
  REVIEW_SUMMARY_MARK,
  UNVERIFIED_CLEAN_REVIEW_BODY,
  redactSalvagedReviewBody,
  reviewSummaryBody,
} from "./review-format.ts";
import { OUTCOME_SHAPE, REVIEW_OUTCOMES, outcomeNote, postedOutcome, rawCauseText, reviewOutcome, salvagedReview, type OutcomeJob, type PostedOutcome, type ReviewOutcome } from "./review-outcome.ts";
import { isConvergedFindings, parseFindingsTotal } from "./review-loop.ts";
import type { Finding, Job, ReviewProvider } from "./types.ts";

const CL: ReviewProvider[] = ["chatgpt", "local"];
const CGL: ReviewProvider[] = ["chatgpt", "grok", "local"];
const VC = "verify-clean" as const;
type RowJob = OutcomeJob & Partial<Pick<Job, "localVerifyNote" | "rawCauses">>;
const job = (patch: Partial<RowJob> = {}): RowJob => ({ reviewProviders: CL, assumptions: [], ...patch });
const held = (patch: Partial<RowJob> = {}) => job({ localReviewRole: VC, ...patch });
const verifying = (patch: Partial<RowJob> = {}) => held({ localVerifyStartedAt: 1, ...patch });
const ASSUMES_SKIPPED = "Generated fixtures were skipped because they are irrelevant.";

describe("reviewOutcome: the one decision point", () => {
  const rows: Array<[string, OutcomeJob, number, ReviewOutcome]> = [
    ["D1 race findings", job({ localReviewRole: "race" }), 1, "findings"],
    ["D2 race raw", job({ localReviewRole: "race", rawReview: "P1 x" }), 0, "raw"],
    ["D3 race skipped local", job({ localReviewRole: "race", skippedProviders: ["local"] }), 0, "incomplete"],
    ["D4 race clean", job({ localReviewRole: "race" }), 0, "clean"],
    ["D5 legacy/tape job without a role", job({ reviewProviders: ["chatgpt"] }), 0, "clean"],
    ["D6 FP round merges as race", held({ chatFpRound: true }), 0, "clean"],
    ["D7 verify-clean, chat only", held({ reviewProviders: ["chatgpt"] }), 0, "clean"],
    ["D8 verify-clean, local only", held({ reviewProviders: ["local"] }), 0, "clean"],
    ["D9 held, chat findings post now", held(), 1, "findings"],
    ["D10 held, chat raw is not clean", held({ rawReview: "P1 x" }), 0, "raw"],
    ["D11 held, chat clean starts verification", held(), 0, "verify"],
    ["D12 held, a skipped chat reviewer still verifies", held({ reviewProviders: CGL, skippedProviders: ["grok"] }), 0, "verify"],
    ["D13 local verified clean", verifying({ localVerified: true }), 0, "verified-clean"],
    ["D14 local verified with findings", verifying({ localVerified: true }), 1, "findings"],
    ["D15 local reply unparseable", verifying({ localVerified: false, rawReview: "P1 a.ts:1 LOCAL-RAW", rawCauses: { local: "unparseable" } }), 0, "raw-unverified"],
    ["D16 local failed", verifying({ localVerified: false }), 0, "unverified-clean"],
    ["D17 local never stamped", verifying(), 0, "unverified-clean"],
    ["D18 verified but a chat reviewer skipped", verifying({ reviewProviders: CGL, localVerified: true, skippedProviders: ["grok"] }), 0, "incomplete"],
    ["D19 local as the chat-down fallback, clean", held({ localFallbackAt: 1 }), 0, "clean"],
    ["D20 local as the chat-down fallback, raw", held({ localFallbackAt: 1, rawReview: "P1 x" }), 0, "raw"],
    // A skipped reviewer is structured provider state; a reviewer's own assumption that says
    // "skipped" is free text and never makes a complete review incomplete (race or verify-clean).
    ["D21 race clean, a reviewer assumption says skipped", job({ localReviewRole: "race", assumptions: [ASSUMES_SKIPPED] }), 0, "clean"],
    ["D22 verified clean, a reviewer assumption says skipped", verifying({ localVerified: true, assumptions: [ASSUMES_SKIPPED] }), 0, "verified-clean"],
    ["D23 held clean, a reviewer assumption says skipped, still verifies", held({ assumptions: [ASSUMES_SKIPPED] }), 0, "verify"],
    ["D24 an empty skipped list is nothing skipped", job({ localReviewRole: "race", skippedProviders: [] }), 0, "clean"],
    // A reviewer whose payload was not its complete verdict (Job.incompleteProviders) never leaves a
    // result clean, starts or passes a verification round, on race or verify-clean. Its reply normally
    // posts as evidence (raw); these rows pin the classification even without that evidence.
    ["D25 race, a reviewer with no complete verdict", job({ localReviewRole: "race", incompleteProviders: ["chatgpt"] }), 0, "incomplete"],
    ["D26 held, a chat reviewer with no complete verdict never starts verification", held({ reviewProviders: CGL, incompleteProviders: ["grok"] }), 0, "incomplete"],
    ["D27 verified, but a chat reviewer returned no complete verdict", verifying({ reviewProviders: CGL, localVerified: true, incompleteProviders: ["grok"] }), 0, "incomplete"],
    ["D28 fallback clean beside chat with no complete verdict", held({ localFallbackAt: 1, incompleteProviders: ["chatgpt"] }), 0, "incomplete"],
    ["D29 its evidence posted: raw", job({ localReviewRole: "race", incompleteProviders: ["chatgpt"], rawReview: "P1 x" }), 0, "raw"],
    ["D30 an empty incomplete list is nothing incomplete", job({ localReviewRole: "race", incompleteProviders: [] }), 0, "clean"],
    // raw-unverified says the raw block is local verification's own reply: it needs local's leg among
    // the salvaged ones. A chat run that landed during the round with evidence of its own, while local
    // returned nothing, is plain raw (its reply is never credited to local).
    ["D31 local failed, a late chat reply is the only raw evidence", verifying({ reviewProviders: CGL, localVerified: false, rawReview: "GROK-RAW", rawCauses: { grok: "not-a-verdict" }, incompleteProviders: ["grok"] }), 0, "raw"],
    ["D32 local verified, a late chat reply is raw evidence", verifying({ reviewProviders: CGL, localVerified: true, rawReview: "GROK-RAW", rawCauses: { grok: "unparseable" }, incompleteProviders: ["grok"] }), 0, "raw"],
    ["D33 local's reply and a late chat reply are both raw evidence", verifying({ reviewProviders: CGL, localVerified: false, rawReview: "x", rawCauses: { grok: "unparseable", local: "not-a-verdict" } }), 0, "raw-unverified"],
    ["D34 no salvaged leg recorded: never attributed to local", verifying({ localVerified: false, rawReview: "x" }), 0, "raw"],
  ];
  for (const [name, j, findings, expected] of rows) {
    it(name, () => assert.equal(reviewOutcome(j, findings), expected));
  }

  it("G1 a held result that reaches the renderer never renders as a clean pass", () => {
    assert.equal(postedOutcome(held(), 0), "unverified-clean");
    const body = reviewSummaryBody({ ...held(), headSha: "abc1234ffff", coverage: [] }, [], "ashlar-bot");
    assert.equal(body.split("\n")[0], UNVERIFIED_CLEAN_REVIEW_BODY);
    assert.equal(isConvergedFindings(body), false);
  });
});

const finding: Finding = { ...FINDING_412, id: "f1" };
const RAW = "P1 a.ts:1 LOCAL-RAW duplicate request writes twice";
/** One job per posted kind, used by the render rows and by the invariants over the whole enum. */
const RENDER: Record<PostedOutcome, { job: RowJob; findings: Finding[] }> = {
  findings: { job: job({ localReviewRole: "race", rawReview: "P1 chat raw", rawCauses: { chatgpt: "unparseable" } }), findings: [finding] },
  raw: { job: job({ localReviewRole: "race", rawReview: "P1 chat raw", rawCauses: { chatgpt: "unparseable" } }), findings: [] },
  "raw-unverified": { job: verifying({ localVerified: false, rawReview: RAW, rawCauses: { local: "unparseable" }, localVerifyNote: "chatgpt found nothing; local verification's reply could not be used as a review (not review JSON); it is posted verbatim below. Not a clean pass." }), findings: [] },
  clean: { job: job({ localReviewRole: "race" }), findings: [] },
  "verified-clean": { job: verifying({ localVerified: true, localVerifyNote: "chatgpt found nothing; local verification agreed." }), findings: [] },
  "unverified-clean": { job: verifying({ localVerified: false, localVerifyNote: "chatgpt found nothing; local verification did not complete (x), so this is chatgpt's unverified clean result." }), findings: [] },
  incomplete: { job: job({ localReviewRole: "race", skippedProviders: ["local"] }), findings: [] },
};
const render = (kind: PostedOutcome) => reviewSummaryBody({ ...RENDER[kind].job, headSha: "abc1234ffff", coverage: [] }, RENDER[kind].findings, "ashlar-bot");
const trailer = (body: string) => /<!--\s*ashlar-findings\s+([^>]*?)\s*-->\s*$/.exec(body)?.[1] ?? null;

describe("reviewSummaryBody: every part of the body comes from the outcome", () => {
  it("findings: summary, the findings marker, and a salvaged block alongside", () => {
    const body = render("findings");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.equal(trailer(body), "total=1 inline=1 body=0 p0=0 p1=1 p2=0");
    assert.ok(body.includes(REVIEW_RAW_START) && body.includes("P1 chat raw"));
  });

  it("raw: summary with the raw marker", () => {
    const body = render("raw");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.equal(trailer(body), "total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0");
    assert.match(body, /Review posted verbatim — the reply was not valid review JSON/);
  });

  it("raw-unverified: the verifier's reply is kept verbatim inside the raw block, flagged unverified", () => {
    const body = render("raw-unverified");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.equal(trailer(body), "total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0 unverified=1");
    assert.match(body, /local verification's reply could not be used as a review/);
    assert.match(body, /Local verification reply posted verbatim — it could not be used as a review\./);
    const block = body.slice(body.indexOf(REVIEW_RAW_START), body.indexOf(REVIEW_RAW_END));
    assert.ok(block.includes(RAW), "the verifier's finding text is inside the raw block");
  });

  it("clean and verified-clean: the clean sentinel first line and a zero marker", () => {
    for (const kind of ["clean", "verified-clean"] as const) {
      const body = render(kind);
      assert.equal(body.split("\n")[0], CLEAN_REVIEW_BODY, kind);
      assert.equal(trailer(body), "total=0 inline=0 body=0 p0=0 p1=0 p2=0", kind);
    }
    assert.match(render("verified-clean"), /local verification agreed/);
  });

  it("unverified-clean: never the sentinel, and the marker is flagged", () => {
    const body = render("unverified-clean");
    assert.equal(body.split("\n")[0], UNVERIFIED_CLEAN_REVIEW_BODY);
    assert.equal(trailer(body), "total=0 inline=0 body=0 p0=0 p1=0 p2=0 unverified=1");
  });

  it("incomplete: summary and no marker at all", () => {
    const body = render("incomplete");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.match(body, /did not finish a full review/);
    assert.equal(parseFindingsTotal(body), null);
  });

  it("incomplete for a reviewer without a complete verdict: named from provider state, never the sentinel or a marker", () => {
    const body = reviewSummaryBody({ ...job({ localReviewRole: "race", incompleteProviders: ["grok"] }), headSha: "abc1234ffff", coverage: [] }, [], "ashlar-bot");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.match(body, /- No complete review from grok \(reply posted as evidence\)/);
    assert.match(body, /not every reviewer returned a complete review/);
    assert.equal(parseFindingsTotal(body), null);
    assert.equal(isConvergedFindings(body), false);
  });
});

describe("the raw header says why, from the cause the merge stamped (never from the outcome)", () => {
  const rawBody = (rawCauses: Job["rawCauses"], findings: Finding[] = []) =>
    reviewSummaryBody({ ...job({ localReviewRole: "race", rawReview: "P1 chat raw", rawCauses }), headSha: "abc1234ffff", coverage: [] }, findings, "ashlar-bot");
  const header = (body: string) => /\*\*⚠️ Review posted verbatim — ([^*]*)\*\*/.exec(body)?.[1];

  it("a salvage before the gate says the reply was not valid review JSON (it may have parsed and failed the schema), and nothing about local repair", () => {
    const body = rawBody({ chatgpt: "unparseable" });
    assert.equal(header(body), "the reply was not valid review JSON.");
    assert.doesNotMatch(body, /not parseable|local repair/i);
  });

  it("rows past the gate's cap: the reply parsed, its unread rows are why; never a parse failure or local repair", () => {
    for (const body of [rawBody({ chatgpt: "unread-rows" }), rawBody({ chatgpt: "unread-rows" }, [finding])]) {
      assert.equal(header(body), "the reply parsed, but its findings past the gate's row cap were not inspected.");
      assert.doesNotMatch(body, /not parseable|not valid review JSON|local repair/i);
    }
  });

  it("a released held local reply that is not a verdict says so", () => {
    assert.equal(header(rawBody({ local: "not-a-verdict" })), "the reply could not be used as a complete structured review.");
  });

  it("no recorded cause is cause-neutral: it claims neither a parse failure nor unread rows", () => {
    for (const causes of [undefined, {}, { chatgpt: "bogus" } as unknown as Job["rawCauses"], { toString: "unparseable" } as unknown as Job["rawCauses"]]) {
      const body = rawBody(causes);
      assert.equal(header(body), "a reply could not be used as structured review JSON.");
      assert.doesNotMatch(body, /not parseable|not valid review JSON|local repair|row cap/i);
    }
  });

  it("several salvaged legs: one labeled clause each, in merge order", () => {
    assert.equal(
      rawCauseText({ chatgpt: "unparseable", local: "unread-rows" }),
      "ChatGPT: the reply was not valid review JSON; Local LLM: the reply parsed, but its findings past the gate's row cap were not inspected",
    );
  });
});

describe("invariants over the closed enum", () => {
  for (const kind of REVIEW_OUTCOMES) {
    it(`${kind}`, () => {
      if (kind === "verify") {
        assert.equal(postedOutcome(held(), 0), "unverified-clean", "verify is a hold, never a rendered kind");
        return;
      }
      const row = RENDER[kind];
      assert.ok(row, `no render row for ${kind}: add one and decide its OUTCOME_SHAPE`);
      assert.equal(postedOutcome(row.job, row.findings.length), kind, "the row exercises its kind");
      const body = render(kind);
      const shape = OUTCOME_SHAPE[kind];
      assert.equal(isConvergedFindings(body), shape.converged, "CONVERGED is the declared shape");
      assert.equal(body.toLowerCase().includes("didn't find any major issues"), shape.converged, "clean sentinel iff converged");
      assert.equal(/(?:^|\s)unverified=1(?:\s|$)/.test(trailer(body) ?? ""), shape.unverified, "unverified flag iff declared");
      const raw = row.job.rawReview;
      if (raw) {
        assert.ok(body.includes(raw), "a salvaged reply is never filtered out of the body");
        const pub = redactSalvagedReviewBody(body);
        assert.equal(pub.includes(raw), false, "public snapshot redacts it");
        assert.equal(trailer(pub), trailer(body), "and keeps the marker");
      } else {
        assert.equal(body.includes(REVIEW_RAW_START), false, "no raw block without a salvaged reply");
      }
    });
  }
});

describe("outcomeNote", () => {
  const chat: ReviewProvider[] = ["chatgpt"];
  it("N1 verified-clean", () => assert.equal(outcomeNote("verified-clean", { chat, verifying: true, findings: 0, findingsBy: {} }), "chatgpt found nothing; local verification agreed."));
  it("N2 local findings in the verification round", () => assert.equal(outcomeNote("findings", { chat, verifying: true, findings: 2, findingsBy: { chatgpt: 0, local: 2 } }), "chatgpt found nothing; local verification found 2."));
  it("N3 chat findings (no verification round)", () => assert.equal(outcomeNote("findings", { chat, verifying: false, findings: 2, findingsBy: { chatgpt: 2 } }), ""));
  it("N4 unverified-clean names the failure", () => assert.match(outcomeNote("unverified-clean", { chat, verifying: true, findings: 0, findingsBy: {}, localError: "x" }), /did not complete \(x\)/));
  it("N5 raw-unverified names why the reply was unusable, says it is posted verbatim and is not clean", () => {
    const note = outcomeNote("raw-unverified", { chat, verifying: true, findings: 0, findingsBy: {} });
    assert.match(note, /could not be used as a review \(not review JSON\); it is posted verbatim below\. Not a clean pass\./);
    assert.match(outcomeNote("raw-unverified", { chat, verifying: true, findings: 0, findingsBy: {}, localError: "1 finding(s) missing required fields" }), /\(1 finding\(s\) missing required fields\)/);
  });
  it("N6 credits only the chat reviewers pinned as clean (a skipped grok found nothing by absence)", () => {
    assert.equal(outcomeNote("verified-clean", { chat: ["chatgpt"], verifying: true, findings: 0, findingsBy: {} }).startsWith("chatgpt found nothing"), true);
  });
  it("N7 clean, raw and incomplete carry no note outside a verification round", () => {
    for (const kind of ["clean", "raw", "incomplete"] as const) assert.equal(outcomeNote(kind, { chat, verifying: false, findings: 0, findingsBy: {} }), "", kind);
  });
  it("N8 incomplete in a verification round still says whether local verified", () => {
    assert.equal(outcomeNote("incomplete", { chat, verifying: true, findings: 0, findingsBy: {}, localVerified: true }), "chatgpt found nothing; local verification agreed.");
    assert.equal(outcomeNote("incomplete", { chat, verifying: true, findings: 0, findingsBy: {}, localVerified: false, localError: "HTTP 500" }), "chatgpt found nothing; local verification did not complete (HTTP 500).");
  });
  // A chat run that started before the round can land during it: its findings are its own, never local's.
  it("N9 a late chat reviewer's findings are credited to it, and local only with its own", () => {
    const late = { chat, verifying: true, findings: 1, localVerified: true };
    assert.equal(outcomeNote("findings", { ...late, findingsBy: { chatgpt: 0, grok: 1, local: 0 } }), "chatgpt found nothing; grok found 1; local verification found nothing.");
    assert.equal(outcomeNote("findings", { ...late, findings: 3, findingsBy: { chatgpt: 0, grok: 1, local: 2 } }), "chatgpt found nothing; grok found 1; local verification found 2.");
    assert.equal(outcomeNote("findings", { ...late, localVerified: false, localError: "HTTP 500", findingsBy: { chatgpt: 0, grok: 1 } }), "chatgpt found nothing; grok found 1; local verification did not return a verdict (HTTP 500).");
  });
  it("N10 a pinned clean chat reviewer that now reports findings is not called clean", () => {
    assert.equal(outcomeNote("findings", { chat, verifying: true, findings: 1, localVerified: true, findingsBy: { chatgpt: 1, local: 0 } }), "chatgpt found 1; local verification found nothing.");
  });
  it("N11 with no reviewer to credit the wording is provider-neutral, never local's", () => {
    const note = outcomeNote("findings", { chat, verifying: true, findings: 1, localVerified: true, findingsBy: { chatgpt: 0, local: 0 } });
    assert.equal(note, "chatgpt found nothing; the review found 1.");
  });
  // A late chat reply is the raw block of a verification round: the note names whose reply it is and
  // what local verification did, never that local's reply is posted.
  it("N12 raw in a verification round credits the raw reply to its reviewer and states local's result", () => {
    const late = { chat, verifying: true, findings: 0, findingsBy: {}, rawBy: ["grok"] as ReviewProvider[] };
    assert.equal(
      outcomeNote("raw", { ...late, localVerified: false, localError: "local LLM HTTP 500" }),
      "chatgpt found nothing; local verification did not complete (local LLM HTTP 500); grok's reply could not be used as a review and is posted verbatim below. Not a clean pass.",
    );
    assert.equal(
      outcomeNote("raw", { ...late, localVerified: true }),
      "chatgpt found nothing; local verification found nothing; grok's reply could not be used as a review and is posted verbatim below. Not a clean pass.",
    );
    assert.doesNotMatch(outcomeNote("raw", { ...late, rawBy: [] }), /local verification's reply/);
  });
});

describe("salvagedReview", () => {
  it("keeps every salvaged leg, the verifier's included, labeled when more than one", () => {
    assert.equal(salvagedReview([{ provider: "chatgpt" }, { provider: "local", rawReview: "LOCAL-RAW" }], 100), "LOCAL-RAW");
    const both = salvagedReview([{ provider: "chatgpt", rawReview: "CHAT-RAW" }, { provider: "local", rawReview: "LOCAL-RAW" }], 1000) ?? "";
    assert.match(both, /\*\*ChatGPT:\*\*\n\nCHAT-RAW\n\n---\n\n\*\*Local LLM:\*\*\n\nLOCAL-RAW/);
  });

  it("is undefined with nothing salvaged, and truncates past the limit", () => {
    assert.equal(salvagedReview([{ provider: "chatgpt" }], 100), undefined);
    assert.match(salvagedReview([{ provider: "local", rawReview: "x".repeat(50) }], 10) ?? "", /^x{10}\n\n…\(truncated/);
  });
});
