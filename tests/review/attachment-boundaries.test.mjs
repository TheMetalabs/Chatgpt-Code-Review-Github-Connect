import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {loadTs, source} from './load-source.mjs';
const server=loadTs('src/lib/chat-prompt.ts');
const page=vm.runInNewContext(source('extension/composer.js')+';({splitAttachments})');
const plain=value=>JSON.parse(JSON.stringify(value));
for(const [name,body] of [
 ['regex source','function split(){ return /<<<END_ATTACH>>>/g; }\nrest of source'],
 ['full delimiter lines','before\n<<<END_ATTACH>>>\n<<<ATTACH:in-source.txt>>>\nsource\n<<<END_ATTACH_V2>>>\nafter'],
 ['Unicode and CRLF','한글 😀\r\n\\"quoted\\"\r\nlast\n'],
])test(`attachment framing preserves ${name} without leaking source into composer`,()=>{
 const files=[{name:'diff.patch',body:'diff\n'},{name:'snapshot.md',body}];
 const encoded='Review only\n\n'+server.encodeChatAttachments(files);
 for(const split of [server.splitChatAttachments,page.splitAttachments]){
  const result=plain(split(encoded));assert.equal(result.prompt,'Review only');assert.deepEqual(result.files,files);
 }
});
test('legacy queued payload: an inline end-marker literal is not a frame boundary',()=>{
 const body='const marker = "<<<END_ATTACH>>>";\nnextLine();';
 const encoded=`Review only\n\n<<<ATTACH:snapshot.md>>>\n${body}\n<<<END_ATTACH>>>`;
 for(const split of [server.splitChatAttachments,page.splitAttachments]){
  const result=plain(split(encoded));assert.equal(result.prompt,'Review only');assert.equal(result.files[0].body.trim(),body);
 }
});
test('invalid structured framing is rejected instead of pasting broken wire/source text',()=>{
 for(const split of [server.splitChatAttachments,page.splitAttachments])
  assert.throws(()=>split('Review\n\n<<<ASHLAR_ATTACHMENTS_V2>>>\nnot-json\n<<<END_ASHLAR_ATTACHMENTS_V2>>>'),/attachment/i);
});
test('browser JSON contract preserves literal escapes with a code fence',()=>{
 assert.match(server.REVIEW_INSTRUCTIONS,/fenced.*json|json.*code block/i);
 assert.doesNotMatch(server.REVIEW_INSTRUCTIONS,/No markdown fences/);
});
test('old bridge clients receive legacy frames while capable clients receive lossless V2',()=>{
 const files=[{name:'diff.patch',body:'code\n"quotes"'}];
 const wire='Review\n\n'+server.encodeChatAttachments(files);
 assert.equal(server.bridgePromptText(wire,2),wire);
 const legacy=server.bridgePromptText(wire,1);assert.match(legacy,/<<<ATTACH:diff.patch>>>/);
 assert.doesNotMatch(legacy,/ASHLAR_ATTACHMENTS_V2/);
 assert.deepEqual(plain(page.splitAttachments(legacy)).files,files);
});
