import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isIpv4, parseDohA } from "./github-dns.ts";

describe("parseDohA", () => {
  it("reads Cloudflare/Google A records", () => {
    const ip = parseDohA(
      JSON.stringify({ Answer: [{ type: 5, data: "github.com." }, { type: 1, data: "140.82.113.6" }] }),
    );
    assert.equal(ip, "140.82.113.6");
  });

  it("rejects junk", () => {
    assert.equal(parseDohA("not-json"), undefined);
    assert.equal(parseDohA("{}"), undefined);
    assert.equal(isIpv4("1.2.3.4"), true);
    assert.equal(isIpv4("api.github.com"), false);
  });
});
