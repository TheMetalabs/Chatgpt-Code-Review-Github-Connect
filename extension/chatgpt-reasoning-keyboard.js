async function selectMaxChatgptReasoningByKeyboard(chatgptPill, sleep) {
  const pill = typeof chatgptPill === "function" ? chatgptPill() : null;
  if (!pill) return "skipped";

  pill.click();
  await sleep(500);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

  for (let i = 0; i < 4; i++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await sleep(100);
  }

  await sleep(500);
  return "selected";
}

export { selectMaxChatgptReasoningByKeyboard };
