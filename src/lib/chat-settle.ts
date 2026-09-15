/**
 * ChatGPT/Grok finished producing an answer — not a wall clock.
 * Copy/feedback toolbar (응답 작업) is the positive signal.
 * A leftover hidden stop node must not block that.
 * Missing stop before generation starts is NOT "done".
 */
export function chatGenerationFinished(input: {
  stopVisible: boolean;
  replyActionsVisible: boolean;
  sawStop?: boolean;
}): boolean {
  if (input.replyActionsVisible) return true;
  if (input.stopVisible) return false;
  return Boolean(input.sawStop);
}
