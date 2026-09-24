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
import { OUTCOME_SHAPE, REVIEW_OUTCOMES, outcomeNote, postedOutcome, reviewOutcome, salvagedReview, type OutcomeJob, type PostedOutcome, type ReviewOutcome } from "./review-outcome.ts";
import { isConvergedFindings, parseFindingsTotal } from "./review-loop.ts";
import type { Finding, ReviewProvider } from "./types.ts";

const CL: ReviewProvider[] = ["chatgpt", "local"];
const CGL: ReviewProvider[] = ["chatgpt", "grok", "local"];
const VC = "verify-clean" as const;
type RowJob = OutcomeJob & { localVerifyNote?: string };
const job = (patch: Partial<RowJob> = {}): RowJob => ({ reviewProviders: CL, assumptions: [], ...patch });
const held = (patch: Partial<RowJob> = {}) => job({ localReviewRole: VC, ...patch });
const verifying = (patch: Partial<RowJob> = {}) => held({ localVerifyStartedAt: 1, ...patch });

describe("reviewOutcome: the one decision point", () => {
  const rows: Array<[string, OutcomeJob, number, ReviewOutcome]> = [
    ["D1 race findings", job({ localReviewRole: "race" }), 1, "findings"],
    ["D2 race raw", job({ localReviewRole: "race", rawReview: "P1 x" }), 0, "raw"],
    ["D3 race skipped local", job({ localReviewRole: "race", assumptions: ["Skipped local (x)"] }), 0, "incomplete"],
    ["D4 race clean", job({ localReviewRole: "race" }), 0, "clean"],
    ["D5 legacy/tape job without a role", job({ reviewProviders: ["chatgpt"] }), 0, "clean"],
    ["D6 FP round merges as race", held({ chatFpRound: true }), 0, "clean"],
    ["D7 verify-clean, chat only", held({ reviewProviders: ["chatgpt"] }), 0, "clean"],
    ["D8 verify-clean, local only", held({ reviewProviders: ["local"] }), 0, "clean"],
    ["D9 held, chat findings post now", held(), 1, "findings"],
    ["D10 held, chat raw is not clean", held({ rawReview: "P1 x" }), 0, "raw"],
    ["D11 held, chat clean starts verification", held(), 0, "verify"],
    ["D12 held, a skipped chat reviewer still verifies", held({ reviewProviders: CGL, assumptions: ["Skipped grok (quota)"] }), 0, "verify"],
    ["D13 local verified clean", verifying({ localVerified: true }), 0, "verified-clean"],
    ["D14 local verified with findings", verifying({ localVerified: true }), 1, "findings"],
    ["D15 local reply unparseable", verifying({ localVerified: false, rawReview: "P1 a.ts:1 LOCAL-RAW" }), 0, "raw-unverified"],
    ["D16 local failed", verifying({ localVerified: false }), 0, "unverified-clean"],
    ["D17 local never stamped", verifying(), 0, "unverified-clean"],
    ["D18 verified but a chat reviewer skipped", verifying({ reviewProviders: CGL, localVerified: true, assumptions: ["Skipped grok (quota or unavailable)"] }), 0, "incomplete"],
    ["D19 local as the chat-down fallback, clean", held({ localFallbackAt: 1 }), 0, "clean"],
    ["D20 local as the chat-down fallback, raw", held({ localFallbackAt: 1, rawReview: "P1 x" }), 0, "raw"],
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
  findings: { job: job({ localReviewRole: "race", rawReview: "P1 chat raw" }), findings: [finding] },
  raw: { job: job({ localReviewRole: "race", rawReview: "P1 chat raw" }), findings: [] },
  "raw-unverified": { job: verifying({ localVerified: false, rawReview: RAW, localVerifyNote: "chatgpt found nothing; local verification's reply was not parseable review JSON; it is posted verbatim below. Not a clean pass." }), findings: [] },
  clean: { job: job({ localReviewRole: "race" }), findings: [] },
  "verified-clean": { job: verifying({ localVerified: true, localVerifyNote: "chatgpt found nothing; local verification agreed." }), findings: [] },
  "unverified-clean": { job: verifying({ localVerified: false, localVerifyNote: "chatgpt found nothing; local verification did not complete (x), so this is chatgpt's unverified clean result." }), findings: [] },
  incomplete: { job: job({ localReviewRole: "race", assumptions: ["Skipped local (x)"] }), findings: [] },
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
    assert.match(body, /Review posted verbatim — the reply was not parseable JSON/);
  });

  it("raw-unverified: the verifier's reply is kept verbatim inside the raw block, flagged unverified", () => {
    const body = render("raw-unverified");
    assert.equal(body.split("\n")[0], REVIEW_SUMMARY_MARK);
    assert.equal(trailer(body), "total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0 unverified=1");
    assert.match(body, /local verification's reply was not parseable review JSON/);
    assert.match(body, /Local verification reply posted verbatim — it was not parseable review JSON\./);
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
  it("N1 verified-clean", () => assert.equal(outcomeNote("verified-clean", { chat, verifying: true, findings: 0 }), "chatgpt found nothing; local verification agreed."));
  it("N2 local findings in the verification round", () => assert.equal(outcomeNote("findings", { chat, verifying: true, findings: 2 }), "chatgpt found nothing; local verification found 2."));
  it("N3 chat findings (no verification round)", () => assert.equal(outcomeNote("findings", { chat, verifying: false, findings: 2 }), ""));
  it("N4 unverified-clean names the failure", () => assert.match(outcomeNote("unverified-clean", { chat, verifying: true, findings: 0, localError: "x" }), /did not complete \(x\)/));
  it("N5 raw-unverified says the reply is posted verbatim and is not clean", () => {
    const note = outcomeNote("raw-unverified", { chat, verifying: true, findings: 0 });
    assert.match(note, /not parseable review JSON; it is posted verbatim below\. Not a clean pass\./);
  });
  it("N6 credits only the chat reviewers pinned as clean (a skipped grok found nothing by absence)", () => {
    assert.equal(outcomeNote("verified-clean", { chat: ["chatgpt"], verifying: true, findings: 0 }).startsWith("chatgpt found nothing"), true);
  });
  it("N7 clean, raw and incomplete carry no note", () => {
    for (const kind of ["clean", "raw", "incomplete"] as const) assert.equal(outcomeNote(kind, { chat, verifying: false, findings: 0 }), "", kind);
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
