import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnvText, quoteEnvValue, upsertEnvText } from "./dotenv-file.server.ts";

describe("dotenv upsert", () => {
  it("parses and replaces keys without dropping comments", () => {
    const src = "# keep\nASHLAR_REVIEW_LOCAL=false\nOTHER=1\n";
    const next = upsertEnvText(src, { ASHLAR_REVIEW_LOCAL: "true", ASHLAR_LOCAL_LLM_MODEL: "qwen" });
    assert.match(next, /^# keep/m);
    assert.match(next, /^ASHLAR_REVIEW_LOCAL=true$/m);
    assert.match(next, /^ASHLAR_LOCAL_LLM_MODEL=qwen$/m);
    assert.match(next, /^OTHER=1$/m);
    assert.equal(parseEnvText(next).ASHLAR_REVIEW_LOCAL, "true");
  });

  it("quotes values with spaces and newlines", () => {
    const q = quoteEnvValue("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    assert.equal(q.startsWith('"'), true);
    const parsed = parseEnvText(`GITHUB_APP_PRIVATE_KEY=${q}\n`);
    assert.match(parsed.GITHUB_APP_PRIVATE_KEY, /BEGIN PRIVATE KEY/);
    assert.match(parsed.GITHUB_APP_PRIVATE_KEY, /\nabc\n/);
  });
});
