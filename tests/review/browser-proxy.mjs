// All browser HTTPS traffic terminates locally. Unlike context.route(), the proxy
// covers chrome.tabs.create's first navigation before Playwright attaches a Page.
import {createServer} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {connect} from 'node:net';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export async function chatFixtureProxy(html) {
 const dir=await mkdtemp(join(tmpdir(),'ashlar-fixture-cert-'));
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=chatgpt.com'],{stdio:'ignore'});
  const requests=[],sockets=new Set();
  const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));};
  const tls=createTlsServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
   requests.push(req.url);
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);
  });
  tls.on('connection',track);
  await new Promise((resolve,reject)=>{tls.once('error',reject);tls.listen(0,'127.0.0.1',resolve);});
  const proxy=createServer((_req,res)=>{res.writeHead(403);res.end();});
  proxy.on('connection',track);
  proxy.on('connect',(req,socket,head)=>{
   if(req.url!=='chatgpt.com:443'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   const upstream=connect(tls.address().port,'127.0.0.1');track(upstream);
   upstream.on('connect',()=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
   });
   upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
   socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
  });
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
  return {port:proxy.address().port,server:`http://127.0.0.1:${proxy.address().port}`,requests,async close(){
   for(const socket of sockets)socket.destroy();
   await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>tls.close(resolve))]);
   await rm(dir,{recursive:true,force:true});
  }};
 } catch(error){await rm(dir,{recursive:true,force:true});throw error;}
}
