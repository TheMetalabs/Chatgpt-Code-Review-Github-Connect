import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importSpecifiers, resolveRelativeImport } from "./import-resolve.ts";

describe("importSpecifiers", () => {
  it("collects import and re-export module specifiers", () => {
    const src = [
      "import { A } from '../a/thing';",
      'import B from "./b";',
      "export { C } from './c';",
      "import type { T } from '../types';",
      "import './side-effect';",
      "const x = require('./nope');", // not from-syntax → ignored
    ].join("\n");
    const specs = importSpecifiers(src);
    assert.ok(specs.includes("../a/thing"));
    assert.ok(specs.includes("./b"));
    assert.ok(specs.includes("./c"));
    assert.ok(specs.includes("../types"));
    assert.ok(!specs.includes("./nope"), "require() is not an ESM from-specifier");
  });
});

describe("resolveRelativeImport", () => {
  it("resolves a relative import to candidate repo paths (extensions + index)", () => {
    const cands = resolveRelativeImport(
      "backend/src/modules/membership/services/membership.service.ts",
      "../../store-product/entities/store-product.entity",
    );
    assert.ok(cands.includes("backend/src/modules/store-product/entities/store-product.entity.ts"));
    assert.ok(cands.some((c) => c.endsWith("/index.ts")));
  });

  it("ignores package (non-relative) imports — no node_modules is fetched", () => {
    assert.deepEqual(resolveRelativeImport("src/x.ts", "@nestjs/common"), []);
    assert.deepEqual(resolveRelativeImport("src/x.ts", "typeorm"), []);
  });

  it("returns [] for an import that escapes above the file's own tree", () => {
    assert.deepEqual(resolveRelativeImport("a.ts", "../../../etc/passwd"), []);
  });

  it("uses the exact path for explicit-extension specifiers, mapping .js to the TS source", () => {
    // Regression: appending ".ts" to "./helper.ts" produced "helper.ts.ts" and fetched nothing.
    assert.deepEqual(resolveRelativeImport("src/a.ts", "./helper.ts"), ["src/helper.ts"]);
    const js = resolveRelativeImport("src/a.ts", "./helper.js");
    assert.ok(js.includes("src/helper.js"), "keeps the literal .js path");
    assert.ok(js.includes("src/helper.ts"), "also tries the .ts source (NodeNext .js specifier)");
    assert.ok(!js.some((c) => /\.(?:ts|js)\.(?:ts|js)$/.test(c)), "no doubled extensions");
  });

  it("never yields a candidate containing a parent traversal segment", () => {
    const cands = resolveRelativeImport("src/a/b/c.ts", "../../util");
    assert.ok(cands.length > 0);
    assert.ok(cands.every((c) => !c.includes("..")), "resolved candidates are plain repo paths");
    assert.ok(cands.includes("src/util.ts"));
  });
});
