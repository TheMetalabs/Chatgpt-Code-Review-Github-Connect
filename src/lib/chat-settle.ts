/** ChatGPT/Grok finished producing an answer — not a wall clock. */
export function chatGenerationFinished(input: {
  stopVisible: boolean;
  replyActionsVisible: boolean;
}): boolean {
  if (input.replyActionsVisible) return true;
  return !input.stopVisible;
}
