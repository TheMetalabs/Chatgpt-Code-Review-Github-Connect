import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChatJson as server } from '../../src/lib/extract-chat-json.ts';
import { content } from './helpers.mjs';
const extension = content().context.extractChatJson;
for (const evidence of ['if (x === "}") {', 'quote \\" } end', 'path C:\\src\\', '\\'.repeat(8) + '"}', 'line\n\t"} {"']) {
  test(`extractor parity: ${JSON.stringify(evidence)}`, () => {
    const raw = JSON.stringify({ findings: [{ evidence }], merge_recommendation: 'REQUEST_CHANGES' });
    for (const input of [raw, 'thinking {\n' + raw, '```json\n' + raw + '\n```', '```json\n' + raw]) {
      assert.equal(server(input), raw);
      assert.equal(extension(input), raw);
    }
  });
}
test('both parsers reject non-review and incomplete JSON', () => {
  for (const input of ['', '{"x":1}', '{"findings":[', '{"findings":["unfinished }']) {
    assert.equal(server(input), null); assert.equal(extension(input), null);
  }
});
import { chatGenerationFinished } from '../../src/lib/chat-settle.ts';
test('server and extension completion predicates agree on every signal combination', () => {
  const extensionDone = content().context.chatGenerationFinished;
  for (const stopVisible of [false, true]) for (const replyActionsVisible of [false, true]) for (const sawStop of [false, true]) {
    const input = { stopVisible, replyActionsVisible, sawStop };
    assert.equal(chatGenerationFinished(input), extensionDone(input), JSON.stringify(input));
  }
});
