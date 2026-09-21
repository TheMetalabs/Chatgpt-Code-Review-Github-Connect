import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT, importGraph, importSpecifiers, resolveRelativeImport } from "./import-resolve.ts";

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

  it("offers every supported module extension and directory index for an extensionless import", () => {
    const c = resolveRelativeImport("src/a.ts", "./worker");
    for (const e of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      assert.ok(c.includes(`src/worker.${e}`), `has .${e} candidate`);
      assert.ok(c.includes(`src/worker/index.${e}`), `has index.${e} candidate`);
    }
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

describe("importGraph", () => {
  it("binds named, aliased, and default imports to their module candidates; skips packages", () => {
    const src = [
      "import { addCalendarMonths as addMonths, Foo } from './date';",
      "import Membership from '../entities/membership';",
      "import { X } from 'typeorm';",
    ].join("\n");
    const g = importGraph("src/svc/pay.ts", src);
    const addMonths = g.find((b) => b.local === "addMonths");
    assert.equal(addMonths?.exported, "addCalendarMonths"); // alias resolved to exported name
    assert.ok(addMonths?.candidates.includes("src/svc/date.ts"));
    assert.equal(g.find((b) => b.local === "Foo")?.exported, "Foo");
    const def = g.find((b) => b.local === "Membership");
    assert.equal(def?.exported, DEFAULT_EXPORT); // default import
    assert.ok(def?.candidates.includes("src/entities/membership.ts"));
    assert.ok(!g.some((b) => b.local === "X"), "package import is skipped");
  });
});
