import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitattributes, patternToRegExp, vendoredKind, vendoredPaths } from "./gitattributes.ts";

describe("gitattributes vendored/generated paths", () => {
  it("live WalkieBoard #523 shape: a vendored package tree is left out, the app code is not", () => {
    const text = "* text=auto\nPackages/WhisperKit/** linguist-vendored\n*.pbxproj -diff\n";
    const out = vendoredPaths(
      ["Packages/WhisperKit/Sources/WhisperKit/Core/Audio.swift", "Packages/WhisperKit/VENDORED.md", "App/Recorder.swift", "Packages/Other/A.swift"],
      [text],
    );
    assert.deepEqual(out.map((o) => o.path), ["Packages/WhisperKit/Sources/WhisperKit/Core/Audio.swift", "Packages/WhisperKit/VENDORED.md"]);
    assert.ok(out.every((o) => o.kind === "vendored"));
  });

  it("generated, and both forms of a true value", () => {
    const rules = parseGitattributes("api/*.pb.go linguist-generated=true\nvendor/** linguist-vendored=1\n");
    assert.equal(vendoredKind("api/user.pb.go", rules), "generated");
    assert.equal(vendoredKind("api/sub/user.pb.go", rules), undefined, "* stays in one segment");
    assert.equal(vendoredKind("vendor/x/y.go", rules), "vendored");
  });

  it("a pattern without a slash matches a file name at any depth; a leading slash anchors at the root", () => {
    const rules = parseGitattributes("*.min.js linguist-vendored\n/dist/** linguist-generated\n");
    assert.equal(vendoredKind("web/lib/jquery.min.js", rules), "vendored");
    assert.equal(vendoredKind("dist/app.js", rules), "generated");
    assert.equal(vendoredKind("web/dist/app.js", rules), undefined);
  });

  it("**/ spans zero or more directories", () => {
    const re = patternToRegExp("**/third_party/**")!;
    assert.ok(re.test("third_party/a.c"));
    assert.ok(re.test("x/y/third_party/z/a.c"));
    assert.ok(!re.test("x/third_partyz/a.c"));
  });

  it("a later line unsets an earlier one (-attr, attr=false, !attr)", () => {
    for (const unset of ["-linguist-vendored", "linguist-vendored=false", "!linguist-vendored"]) {
      const rules = parseGitattributes(`vendor/** linguist-vendored\nvendor/ours/** ${unset}\n`);
      assert.equal(vendoredKind("vendor/theirs/a.go", rules), "vendored");
      assert.equal(vendoredKind("vendor/ours/a.go", rules), undefined, unset);
    }
  });

  it("the head's .gitattributes applies after the base's", () => {
    const base = "lib/** linguist-vendored\n";
    const head = "lib/mine/** -linguist-vendored\n";
    assert.deepEqual(vendoredPaths(["lib/x.c", "lib/mine/y.c"], [base, head]).map((o) => o.path), ["lib/x.c"]);
  });

  it("a .gitattributes change itself is always reviewed", () => {
    assert.deepEqual(vendoredPaths([".gitattributes", "sub/.gitattributes"], ["* linguist-vendored\n"]), []);
  });

  it("comments, directory patterns, negative patterns and other attributes mark nothing", () => {
    const rules = parseGitattributes("# vendor/** linguist-vendored\nvendor/ linguist-vendored\n!src/** linguist-vendored\nsrc/** text eol=lf\n");
    assert.equal(rules.length, 0);
    assert.deepEqual(vendoredPaths(["vendor/a.c", "src/b.c"], [null, undefined, ""]), []);
  });

  it("character classes and escaped metacharacters", () => {
    const rules = parseGitattributes("gen/[ab]_*.ts linguist-generated\nweird\\[1\\].txt linguist-vendored\n");
    assert.equal(vendoredKind("gen/a_x.ts", rules), "generated");
    assert.equal(vendoredKind("gen/c_x.ts", rules), undefined);
    assert.equal(vendoredKind("weird[1].txt", rules), "vendored");
  });
});
