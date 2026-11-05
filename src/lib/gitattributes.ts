/**
 * The repository's own record of which paths are not its code: `.gitattributes` lines that set
 * `linguist-vendored` or `linguist-generated` (GitHub Linguist). A review leaves those paths out
 * (Settings finding_precision.skip_vendored): live WalkieBoard #523 vendored WhisperKit 1.1.1 unchanged
 * (Packages/WhisperKit/Sources/**, 100+ files, marked linguist-vendored), and every one of 16 rounds
 * raised new findings on the upstream sources while each local review held the model for about an hour.
 *
 * Pure: parsing and matching only. Pattern semantics follow gitattributes(5): a pattern without a slash
 * matches a file name at any depth, one with a slash is relative to the repository root, `**` spans
 * directories, `*` / `?` / `[...]` stay within one path segment, a later line overrides an earlier one,
 * and `-attr`, `attr=false`, `!attr` unset what an earlier line set. Negative patterns (`!pattern`) are
 * not allowed in .gitattributes and are ignored, as git does.
 */

export type VendoredKind = "vendored" | "generated";

type Rule = { re: RegExp; vendored?: boolean; generated?: boolean };

const ATTRS: Record<string, keyof Omit<Rule, "re">> = {
  "linguist-vendored": "vendored",
  "linguist-generated": "generated",
};

/** One attribute token's value for our two attributes: true (set), false (unset / =false), or undefined. */
function attrValue(token: string): { key: keyof Omit<Rule, "re">; value: boolean } | undefined {
  const lower = token.toLowerCase();
  for (const [name, key] of Object.entries(ATTRS)) {
    if (lower === name || lower === `${name}=true` || lower === `${name}=1`) return { key, value: true };
    if (lower === `-${name}` || lower === `!${name}` || lower === `${name}=false` || lower === `${name}=0`) return { key, value: false };
  }
  return undefined;
}

/** A gitattributes path pattern as an anchored regular expression over a repo-relative path. */
export function patternToRegExp(pattern: string): RegExp | undefined {
  let p = pattern.trim();
  if (!p || p.startsWith("!")) return undefined;
  // A trailing slash names a directory, which gitattributes never matches by itself (only files).
  if (p.endsWith("/")) return undefined;
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const before = i === 0 || p[i - 1] === "/";
        const after = p[i + 2] === "/" || i + 2 === p.length;
        if (before && after) {
          // "**/" spans zero or more directories; a trailing "/**" matches everything inside.
          if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; continue; }
          re += ".*"; i += 1; continue;
        }
        re += "[^/]*"; i += 1; continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = p.indexOf("]", i + 2);
      if (close < 0) { re += "\\["; continue; }
      let body = p.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (c === "\\" && i + 1 < p.length) {
      re += p[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  try {
    return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
  } catch {
    return undefined;
  }
}

/** The vendored/generated rules of a .gitattributes text, in file order. Lines setting neither are skipped. */
export function parseGitattributes(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // A quoted pattern ("path with spaces") is rare: take it whole, then the attributes after it.
    let pattern: string;
    let rest: string;
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1);
      if (end < 0) continue;
      pattern = line.slice(1, end);
      rest = line.slice(end + 1);
    } else {
      const m = /^(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      pattern = m[1];
      rest = m[2];
    }
    const rule: Rule = { re: /$^/ };
    let touches = false;
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      const v = attrValue(token);
      if (v) { rule[v.key] = v.value; touches = true; }
    }
    if (!touches) continue;
    const re = patternToRegExp(pattern);
    if (!re) continue;
    rule.re = re;
    rules.push(rule);
  }
  return rules;
}

/** Why `path` is left out of review (the last matching line wins per attribute), or undefined. */
export function vendoredKind(path: string, rules: readonly Rule[]): VendoredKind | undefined {
  let vendored: boolean | undefined;
  let generated: boolean | undefined;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (r.vendored !== undefined) vendored = r.vendored;
    if (r.generated !== undefined) generated = r.generated;
  }
  if (vendored) return "vendored";
  if (generated) return "generated";
  return undefined;
}

/** The changed paths the .gitattributes texts leave out of review, each with its reason. Texts apply in
 * order (base first, then head), so the PR's own .gitattributes decides for its head. A change TO a
 * .gitattributes file itself is always reviewed: it is how a PR would hide its own code. */
export function vendoredPaths(paths: readonly string[], texts: readonly (string | null | undefined)[]): { path: string; kind: VendoredKind }[] {
  const rules = texts.flatMap((t) => (t ? parseGitattributes(t) : []));
  if (!rules.length) return [];
  const out: { path: string; kind: VendoredKind }[] = [];
  for (const path of paths) {
    if (/(^|\/)\.gitattributes$/.test(path)) continue;
    const kind = vendoredKind(path, rules);
    if (kind) out.push({ path, kind });
  }
  return out;
}
