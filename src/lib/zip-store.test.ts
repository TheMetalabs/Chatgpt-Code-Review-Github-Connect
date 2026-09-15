import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crc32, zipStore } from "./zip-store.ts";

describe("zipStore", () => {
  it("writes a zip local file signature", () => {
    const zip = zipStore([{ name: "hello.txt", data: new TextEncoder().encode("hi") }]);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
    assert.ok(zip.length > 30);
    assert.notEqual(crc32(new TextEncoder().encode("hi")), 0);
  });
});
