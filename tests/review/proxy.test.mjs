import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {once,EventEmitter} from 'node:events';
import {join} from 'node:path';
import {loadTs} from './load-source.mjs';

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

// Inject a transport reset deterministically, including before a CONNECT is
// accepted. Chromium also opens connections which the local allowlist rejects.
function proxyTransportFixture() {
 const servers=[],upstreams=[];
 const createServer=()=>{
  const server=new EventEmitter();
  server.listen=(_port,_host,callback)=>callback();
  server.address=()=>({port:12345});
  server.close=callback=>callback();
  servers.push(server);return server;
 };
 const socket=()=>{
  const stream=new EventEmitter();stream.destroyed=false;stream.response='';
  stream.end=text=>{stream.response+=text;};stream.write=()=>{};stream.pipe=()=>{};
  stream.destroy=()=>{stream.destroyed=true;stream.emit('close');};
  return stream;
 };
 const api=loadTs('tests/review/browser-proxy.mjs',{
  createServer,createTlsServer:createServer,
  connect:()=>{const stream=socket();upstreams.push(stream);return stream;},
  execFileSync(){},mkdtemp:async()=>'/fixture',readFile:async()=>Buffer.from('fixture certificate'),
  rm:async()=>{},tmpdir:()=>'/tmp',join,
 });
 return {api,servers,upstreams,socket};
}
for (const phase of ['before CONNECT','rejected CONNECT','TLS transport']) {
 test(`browser fixture closes ${phase} sockets on ECONNRESET without an uncaught exception`,async()=>{
  const fixture=proxyTransportFixture();const proxy=await fixture.api.chatFixtureProxy('fixture');
  try {
   const server=fixture.servers[phase==='TLS transport'?0:1];
   const socket=fixture.socket();server.emit('connection',socket);
   if(phase==='rejected CONNECT') {
    server.emit('connect',{url:'external.invalid:443'},socket,Buffer.alloc(0));
    assert.match(socket.response,/403 Forbidden/);
   }
   const reset=Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'});
   assert.doesNotThrow(()=>socket.emit('error',reset));
   assert.equal(socket.destroyed,true);
   assert.equal(fixture.upstreams.length,0,'a reset or denied host must never open an upstream');
  } finally {await proxy.close();}
 });
}
