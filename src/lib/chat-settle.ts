/**
 * ChatGPT/Grok finished producing an answer — not a wall clock.
 * Copy/feedback toolbar (응답 작업) is the positive signal.
 * Hidden controls must be filtered by the DOM caller. A visible Stop means pending.
 * Missing stop before generation starts is NOT "done".
 */
export function chatGenerationFinished(input: {
  stopVisible: boolean;
  replyActionsVisible: boolean;
  sawStop?: boolean;
}): boolean {
  if (input.stopVisible) return false;
  return Boolean(input.replyActionsVisible);
}
