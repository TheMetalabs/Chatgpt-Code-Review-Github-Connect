import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ashlarAllowedHosts, ashlarPublicHost, ashlarWebhookUrl, parseHostList } from "./ashlar-env.ts";

describe("parseHostList", () => {
  it("strips scheme and path, splits commas", () => {
    assert.deepEqual(parseHostList("https://tunnel.example/api/webhook, extra.test"), [
      "tunnel.example",
      "extra.test",
    ]);
  });

  it("rejects junk", () => {
    assert.deepEqual(parseHostList("https://user:pass@evil.test"), []);
    assert.deepEqual(parseHostList("../etc/passwd"), []);
    assert.deepEqual(parseHostList(""), []);
  });
});

describe("ashlar env hosts", () => {
  it("reads public host and allowed list from env only", () => {
    const env = { ASHLAR_PUBLIC_HOST: "bot.example.test", ASHLAR_ALLOWED_HOSTS: ".example.test" };
    assert.equal(ashlarPublicHost(env), "bot.example.test");
    assert.deepEqual(ashlarAllowedHosts(env), [".example.test", "bot.example.test"]);
    assert.equal(ashlarWebhookUrl(env), "https://bot.example.test/api/webhook");
  });

  it("is empty when unset", () => {
    assert.equal(ashlarPublicHost({}), "");
    assert.deepEqual(ashlarAllowedHosts({}), []);
    assert.equal(ashlarWebhookUrl({}), "");
  });
});
