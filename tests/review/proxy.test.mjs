import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';

test('browser fixture proxy serves only local HTML for ChatGPT TLS navigation',async t=>{
 const {chatFixtureProxy}=await import('./browser-proxy.mjs');
 const proxy=await chatFixtureProxy('<html>controlled fixture</html>');t.after(()=>proxy.close());
 const socket=net.connect(proxy.port,'127.0.0.1');await once(socket,'connect');
 socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n');
 const [head]=await once(socket,'data');assert.match(head.toString(),/200 Connection Established/);
 const secure=tls.connect({socket,rejectUnauthorized:false,servername:'chatgpt.com'});await once(secure,'secureConnect');
 secure.write('GET /?temporary-chat=true HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n');
 let response='';for await(const chunk of secure)response+=chunk;
 assert.match(response,/<html>controlled fixture<\/html>/);
 assert.deepEqual(proxy.requests,['/?temporary-chat=true']);
});
test('browser fixture proxy rejects every other external destination',async t=>{
 const {chatFixtureProxy}=await import('./browser-proxy.mjs');
 const proxy=await chatFixtureProxy('fixture');t.after(()=>proxy.close());
 const socket=net.connect(proxy.port,'127.0.0.1');await once(socket,'connect');
 socket.write('CONNECT external.invalid:443 HTTP/1.1\r\nHost: external.invalid:443\r\n\r\n');
 let response='';for await(const chunk of socket)response+=chunk;
 assert.match(response,/403 Forbidden/);assert.equal(proxy.requests.length,0);
});
