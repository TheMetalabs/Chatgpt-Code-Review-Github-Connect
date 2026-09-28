// How the review body renders model/operator-controlled text. Shared by the body (review-format) and
// the merge that sizes the verbatim block (salvagedReview), so the block is measured as it is posted.

/** Render model/operator-controlled text inert to the body's HTML-comment delimiters and markers so
 * it cannot forge or break the raw wrapper or the findings marker. Entities still display as `<!--` /
 * `-->` in the GitHub body. Applied to EVERY interpolated field (never to the literal wrapper the code
 * emits), so exactly one genuine raw pair exists and public redaction is unambiguous. */
export function neutralizeMarkers(s: string): string {
  return String(s ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

/** A salvaged reply as the body posts it. The loop poller's clean-pass sentinel is reworded (matching
 * the SAME separator set it accepts, `Didn.t …` — any single char, so `Didnʼt`/backtick variants are
 * covered) so a salvaged body can't read as clean, then markers are neutralized so the reply can't
 * forge/break the raw wrapper or marker. Both can lengthen the text (each `-->` by 3), so the block is
 * sized by this length, never the reply's own. */
export function rawBodyText(s: string): string {
  return neutralizeMarkers(String(s ?? "").replace(/didn.t find any major issues\.?/gi, "(the model reported no major issues)"));
}
