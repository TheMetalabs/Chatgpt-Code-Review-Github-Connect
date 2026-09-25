/** Pure validation for format repair. No model invocation, mutation or publication. */
export const REPAIR_SCHEMA_VERSION = "review-format-1";
export type RepairSchema = "review" | "fp";
export const MAX_REPAIR_CHARS = 500_000;
type ObjectValue = Record<string, unknown>;
export type FormatCheck = {ok: true; raw: string; value: ObjectValue} | {ok: false; errors: string[]};
const object = (value: unknown): value is ObjectValue => Boolean(value && typeof value === "object" && !Array.isArray(value));
const aliases: Record<string, string> = {failureScenario:"failure_scenario",rootCause:"root_cause",recommendedFix:"recommended_fix",recommendedTest:"recommended_test",mergeRecommendation:"merge_recommendation",highestRisk:"highest_risk",investigatedSafe:"investigated_safe"};
const findingStrings = ["file","title","failure_scenario","root_cause","evidence","recommended_fix","recommended_test"];
const findingKeys = [...findingStrings,"severity","line","side"];
export function jsonBody(raw: string): string {
  const text = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/i.exec(text);
  if (fence) return fence[1].trim();
  // The browser capture is the rendered DOM: a ```json block renders its language label ("JSON")
  // and header wrappers as a line of its own plus blank lines before the object. Only that bare
  // label is dropped; any other text before the JSON stays and fails validation.
  const label = /^json[ \t]*\n\s*(?=[{[])/i.exec(text);
  return label ? text.slice(label[0].length) : text;
}
const MAX_STRAY_QUOTE_FIXES = 8;
/** Index of the first quote that closes a string but is followed by something no JSON string can
 * be followed by (anything except , } ] : or the end), or -1. A plain string scan: the wording and
 * position in JSON.parse's error message belong to the engine and may change with a Node upgrade. */
function prematureStringEnd(text: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    if (!inString) { inString = text[i] === '"'; continue; }
    if (text[i] === "\\") { i++; continue; }
    if (text[i] !== '"') continue;
    inString = false;
    let next = i + 1;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (next < text.length && !",}]:".includes(text[next])) return i;
  }
  return -1;
}
/** Deterministic, character-preserving repair for one observed model slip: inside a string the
 * model writes an escaped backslash and forgets the quote's own escape (`\\"` for `\\\"`), which
 * ends the string early. Only such a quote, preceded by an even run of two or more backslashes and
 * followed by something that cannot follow a string, is escaped, at most 8 times; any other parse
 * failure returns null. The caller still runs validateRepairCandidate on the result. */
export function escapeStrayQuotes(raw: string): string | null {
  let text = jsonBody(raw);
  for (let fixes = 0; ; fixes++) {
    try { JSON.parse(text); return fixes ? text : null; } catch { /* locate the slip below */ }
    if (fixes >= MAX_STRAY_QUOTE_FIXES) return null;
    const quote = prematureStringEnd(text);
    if (quote < 0) return null;
    let slashes = 0;
    for (let i = quote - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    if (slashes === 0 || slashes % 2 !== 0) return null;
    text = `${text.slice(0, quote)}\\${text.slice(quote)}`;
  }
}
export function repairSchemaDefinition(kind: RepairSchema) {
  const string = {type:"string",minLength:1};
  const finding = {type:"object",additionalProperties:false,required:findingKeys,
    properties:{...Object.fromEntries(findingStrings.map(key=>[key,string])),severity:{enum:["P0","P1","P2"]},line:{type:"integer",minimum:1},side:{enum:["LEFT","RIGHT"]}}};
  return kind === "review" ? {type:"object",additionalProperties:false,required:["findings"],properties:{
    findings:{type:"array",items:finding},merge_recommendation:{enum:["REQUEST_CHANGES","COMMENT","APPROVE"]},highest_risk:{type:"string"},
    investigated_safe:{type:"array",items:{type:"string"}},assumptions:{type:"array",items:{type:"string"}},
    coverage:{type:"array",items:{type:"object",properties:{file:{type:"string"},status:{enum:["cleared","not_cleared"]},reason:{type:"string"}}}}}} :
    {type:"object",additionalProperties:false,required:["keep","drop"],properties:{keep:{type:"array",items:finding},drop:{type:"array",items:{type:"object",additionalProperties:false,
      required:["file","line","title","reason"],properties:{file:string,line:{type:"integer",minimum:1},title:string,reason:string}}}}};
}
/** JSON.parse accepts duplicate keys; a repair must not silently lose those values. */
function uniqueJsonKeys(text: string): boolean {
  let pos=0, depth=0;
  const space=()=>{while(/\s/.test(text[pos] || "") && pos<text.length)pos++;};
  const string=()=>{
    space();const start=pos;if(text[pos++]!=='"')throw Error("string");
    for(;pos<text.length;pos++) {
      if(text[pos]==="\\"){pos++;continue;}
      if(text[pos]==='"'){pos++;return JSON.parse(text.slice(start,pos)) as string;}
    }
    throw Error("string");
  };
  const walk=()=>{
    space();if(++depth>64)throw Error("depth");
    if(text[pos]==="{") {
      pos++;space();const seen=new Set<string>();
      while(text[pos]!=="}") {
        const key=string();if(seen.has(key))throw Error("duplicate");seen.add(key);
        space();if(text[pos++]!==":")throw Error("colon");walk();space();
        if(text[pos]!==",")break;pos++;
      }
      if(text[pos++]!=="}")throw Error("object");
    } else if(text[pos]==="[") {
      pos++;space();while(text[pos]!=="]") {walk();space();if(text[pos]!==",")break;pos++;}
      if(text[pos++]!=="]")throw Error("array");
    } else if(text[pos]==='"')string();
    else {const start=pos;while(pos<text.length && !/[\s,}\]]/.test(text[pos]))pos++;if(pos===start)throw Error("value");}
    depth--;
  };
  try{walk();space();return pos===text.length;}catch{return false;}
}
export function inspectReviewFormat(raw: string, kind: RepairSchema): FormatCheck {
  if (!raw || raw.length > MAX_REPAIR_CHARS) return {ok:false,errors:["response_empty_or_oversized"]};
  let value: unknown;
  try { value = JSON.parse(jsonBody(raw)); } catch { return {ok:false,errors:["invalid_json_syntax"]}; }
  if (!object(value)) return {ok:false,errors:["root_must_be_object"]};
  if (!uniqueJsonKeys(jsonBody(raw))) return {ok:false,errors:["duplicate_keys_or_excessive_nesting"]};
  const errors: string[] = [];
  const keys = (row: ObjectValue, allowed: string[], path: string) => {
    if (Object.keys(row).some(key=>!allowed.includes(key))) errors.push(`${path}:unknown_field`);
  };
  const text = (v: unknown, path: string) => { if (typeof v !== "string" || !v.trim()) errors.push(`${path}:required_string`); };
  const line = (v: unknown, path: string) => { if (!Number.isSafeInteger(v) || Number(v)<1) errors.push(`${path}:positive_integer`); };
  const findings = (rows: unknown, path: string) => {
    if (!Array.isArray(rows)) {errors.push(`${path}:required_array`);return;}
    rows.forEach((row,index)=>{
      const here = `${path}[${index}]`;
      if (!object(row)) {errors.push(`${here}:required_object`);return;}
      keys(row,findingKeys,here);
      findingStrings.forEach(key=>text(row[key],`${here}.${key}`));
      line(row.line,`${here}.line`);
      if ((typeof row.severity!=="string" || !["P0","P1","P2"].includes(row.severity))) errors.push(`${here}.severity:invalid_enum`);
      if ((typeof row.side!=="string" || !["RIGHT","LEFT"].includes(row.side))) errors.push(`${here}.side:invalid_enum`);
    });
  };
  if (kind === "review") {
    // `coverage` is a legitimate, prompt-requested field (self-reported model coverage). It never
    // affects the verdict and is parsed leniently downstream, so it must be allowed here — otherwise
    // every review that follows the prompt trips "unknown_field" → a spurious repair request.
    keys(value,["findings","merge_recommendation","highest_risk","investigated_safe","assumptions","coverage"],"review");
    findings(value.findings,"findings");
    if (value.merge_recommendation !== undefined && (typeof value.merge_recommendation!=="string" || !["REQUEST_CHANGES","COMMENT","APPROVE"].includes(value.merge_recommendation))) errors.push("merge_recommendation:invalid_enum");
    if (value.highest_risk !== undefined && typeof value.highest_risk !== "string") errors.push("highest_risk:string_required");
    for (const key of ["investigated_safe","assumptions"]) if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(v=>typeof v === "string"))) errors.push(`${key}:string_array_required`);
    if (value.coverage !== undefined && !Array.isArray(value.coverage)) errors.push("coverage:array_required");
  } else {
    keys(value,["keep","drop"],"fp");findings(value.keep,"keep");
    if (!Array.isArray(value.drop)) errors.push("drop:required_array");
    else value.drop.forEach((row,index)=>{
      const path=`drop[${index}]`;
      if (!object(row)) {errors.push(`${path}:required_object`);return;}
      keys(row,["file","line","title","reason"],path);["file","title","reason"].forEach(key=>text(row[key],`${path}.${key}`));line(row.line,`${path}.line`);
    });
  }
  return errors.length ? {ok:false,errors:errors.slice(0,32)} : {ok:true,value,raw:JSON.stringify(value)};
}
/** Only documented representation changes, no field defaults or inferred evidence. */
function canonical(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map(v=>canonical(v));
  if (object(value)) {
    if (!key && Object.keys(value).length === 1 && ["review","result","data"].includes(Object.keys(value)[0])) return canonical(Object.values(value)[0]);
    const result: ObjectValue = Object.create(null);
    for (const original of Object.keys(value).sort()) {
      const name = Object.hasOwn(aliases, original) ? aliases[original] : original;
      if (Object.hasOwn(result,name)) throw new Error("ambiguous_alias");
      result[name] = canonical(value[original],name);
    }
    if (["findings","keep"].includes(key)) return [result];
    return result;
  }
  if (key === "line" && typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return value;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
  return value;
}
/** Linear source alignment, not a heuristic JSON parser. Every original character
 * must be accounted for by the candidate's structure or literal values. Allow JSON
 * whitespace outside strings, missing/trailing commas and escaped versus rendered
 * punctuation inside strings. Values/field order must otherwise match. This narrow
 * subset rejects prose, changed evidence, missing rows and ambiguous restructuring.
 * One truncation is tolerated: a source that ends inside a LAST top-level `coverage`
 * member (#93: a capture that lost its final "}]}") may be closed by closing brackets
 * only. Every source character is still aligned, and no finding can be lost this way:
 * `findings` precedes it complete. A lost coverage row only leaves that file not cleared.
 */
function alignsWithRenderedSource(source: string, value: unknown): boolean {
  let pos=0,depth=0,inLastMember=false;
  const whitespace=()=>{while(pos<source.length && /\s/.test(source[pos]))pos++;};
  const token=(want:string)=>{
    whitespace();
    if(inLastMember && pos===source.length && (want==="]" || want==="}"))return;
    if(source.slice(pos,pos+want.length)!==want)throw Error("source_mismatch");pos+=want.length;
  };
  const string=(text:string)=>{
    token('"');
    const start = pos;
    for(const character of text) {
      const escaped=JSON.stringify(character).slice(1,-1);
      // Prefer escaped bytes only when this character has an escape representation.
      if(escaped!==character && source.startsWith(escaped,pos))pos+=escaped.length;
      else if(source.startsWith(character,pos))pos+=character.length;
      else throw Error("source_string_changed");
    }
    if(source[pos]!== '"')throw Error("source_string_changed");
    // An LLM must not absorb a second field/finding into a string to make its
    // schema pass. Unescaped member syntax inside a malformed string is
    // ambiguous, even if every byte can be aligned. Escaped JSON in valid code
    // evidence is handled by the exact parsed-value comparison instead.
    const span = source.slice(start, pos);
    for (const match of span.matchAll(/"[^"\\\r\n]{1,120}"\s*:/g)) {
      let escapes = 0;
      for (let i = match.index! - 1; i >= 0 && span[i] === "\\"; i--) escapes++;
      if (escapes % 2 === 0) throw Error("ambiguous_structural_string");
    }
    pos++;
  };
  const comma=()=>{whitespace();if(source[pos]===",")pos++;};
  const walk=(v:unknown)=>{
    if(++depth>64)throw Error("too_deep");
    if(typeof v === "string")string(v);
    else if(Array.isArray(v)){token("[");v.forEach((item,index)=>{if(index)comma();walk(item);});comma();token("]");}
    else if(object(v)){
      const top=depth===1, entries=Object.entries(v);
      token("{");
      entries.forEach(([key,item],index)=>{if(index)comma();string(key);token(":");if(top && index===entries.length-1 && key==="coverage")inLastMember=true;walk(item);});
      comma();token("}");
    }
    else token(JSON.stringify(v));
    depth--;
  };
  try{walk(value);whitespace();return pos===source.length;}catch{return false;}
}
export function validateRepairCandidate(original: string, candidate: string, kind: RepairSchema): FormatCheck {
  const checked=inspectReviewFormat(candidate,kind);
  if(!checked.ok)return checked;
  if(!original || original.length>MAX_REPAIR_CHARS)return {ok:false,errors:["original_empty_or_oversized"]};
  const source=jsonBody(original);
  let parsed: unknown;
  try{parsed=JSON.parse(source);}catch{
    return alignsWithRenderedSource(source,checked.value) ? checked : {ok:false,errors:["original_content_not_preserved"]};
  }
  if(!uniqueJsonKeys(source))return {ok:false,errors:["ambiguous_original_structure"]};
  try{
    return JSON.stringify(ordered(canonical(parsed)))===JSON.stringify(ordered(checked.value)) ? checked : {ok:false,errors:["original_content_not_preserved"]};
  }catch{return {ok:false,errors:["ambiguous_original_structure"]};}
}
