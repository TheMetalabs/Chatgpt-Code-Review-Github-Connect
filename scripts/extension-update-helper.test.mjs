import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, writeFile, mkdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {ExtensionUpdater, compareVersions, startUpdaterServer} from "./extension-update-helper.mjs";

const exec = promisify(execFile);
async function git(cwd,args){return String((await exec("git",args,{cwd,encoding:"utf8"})).stdout).trim();}
async function writeVersion(root,version,label){
 await mkdir(path.join(root,"extension"),{recursive:true});
 await writeFile(path.join(root,"extension","manifest.json"),JSON.stringify({manifest_version:3,name:"Fixture",version}));
 await writeFile(path.join(root,"extension","background.js"),`globalThis.version="${label}";\n`);
 await git(root,["add","."]);await git(root,["commit","-m",label]);return git(root,["rev-parse","HEAD"]);
}
async function repoFixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"ashlar-updater-test-"));
 await git(root,["init","-b","main"]);await git(root,["config","user.email","fixture@example.test"]);await git(root,["config","user.name","Fixture"]);
 const oldCommit=await writeVersion(root,"1.1.21","old"), newCommit=await writeVersion(root,"1.1.22","new");
 return {root,oldCommit,newCommit,target:path.join(root,"installed"),stateFile:path.join(root,"state.json")};
}

test("version comparison is numeric, not lexical",()=>{
 assert.equal(compareVersions("1.1.22","1.1.21"),1);assert.equal(compareVersions("1.10.0","1.9.9"),1);assert.equal(compareVersions("1.1.22","1.1.22.0"),0);
});

test("updater atomically installs a newer extension and can roll back",async()=>{
 const f=await repoFixture();
 const oldUpdater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.oldCommit,fetchRemote:false,stateFile:f.stateFile});
 await oldUpdater.update({force:true});
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 const before=await updater.status({fetch:false});assert.equal(before.installedVersion,"1.1.21");assert.equal(before.availableVersion,"1.1.22");assert.equal(before.updateAvailable,true);
 const updated=await updater.update({expectedCommit:f.newCommit});assert.equal(updated.updated,true);
 assert.match(await readFile(path.join(f.target,"background.js"),"utf8"),/new/);
 const after=await updater.status({fetch:false});assert.equal(after.installedVersion,"1.1.22");assert.equal(after.backupVersion,"1.1.21");
 const rolled=await updater.rollback();assert.equal(rolled.toVersion,"1.1.21");
 assert.match(await readFile(path.join(f.target,"background.js"),"utf8"),/old/);
});

test("update refuses a stale check instead of silently installing a different commit",async()=>{
 const f=await repoFixture();
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 await assert.rejects(updater.update({expectedCommit:f.oldCommit}),/changed; check again/i);
});

test("HTTP helper is loopback-only in use and rejects non-extension origins",async t=>{
 const f=await repoFixture();
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 const {server,url}=await startUpdaterServer({updater,port:0,extensionId:"abcdefghijklmnopabcdefghijklmnop"});t.after(()=>server.close());
 const denied=await fetch(url+"/status",{headers:{Origin:"https://example.test"}});assert.equal(denied.status,403);
 const origin="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
 const allowed=await fetch(url+"/status",{headers:{Origin:origin}});assert.equal(allowed.status,200);assert.equal((await allowed.json()).availableVersion,"1.1.22");
});


test("status fetch advances the exact origin branch tracking ref",async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),"ashlar-updater-origin-"));
 const remote=path.join(base,"remote.git"), publisher=path.join(base,"publisher"), consumer=path.join(base,"consumer");
 await exec("git",["init","--bare",remote],{encoding:"utf8"});
 await git(base,["init","-b","main",publisher]);await git(publisher,["config","user.email","fixture@example.test"]);await git(publisher,["config","user.name","Fixture"]);
 const a=await writeVersion(publisher,"1.1.21","A");
 await git(publisher,["remote","add","origin",remote]);await git(publisher,["push","-u","origin","main"]);
 await git(remote,["symbolic-ref","HEAD","refs/heads/main"]);
 await exec("git",["clone",remote,consumer],{encoding:"utf8"});
 assert.equal(await git(consumer,["rev-parse","refs/remotes/origin/main"]),a);
 const b=await writeVersion(publisher,"1.1.23","B");await git(publisher,["push","origin","main"]);
 assert.equal(await git(consumer,["rev-parse","refs/remotes/origin/main"]),a,"fixture must begin with a stale tracking ref");
 const updater=new ExtensionUpdater({repoRoot:consumer,targetDir:path.join(base,"installed"),stateFile:path.join(base,"state.json")});
 const status=await updater.status({fetch:true});
 assert.equal(status.availableCommit,b);assert.equal(status.availableVersion,"1.1.23");
 assert.equal(await git(consumer,["rev-parse","refs/remotes/origin/main"]),b);
});

test("updater server fails closed without exact extension identity and rejects other extensions",async t=>{
 const f=await repoFixture();
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 await assert.rejects(startUpdaterServer({updater,port:0}),/exact 32-character Ashlar extension ID/);
 const extensionA="abcdefghijklmnopabcdefghijklmnop";
 const extensionB="ponmlkjihgfedcbaponmlkjihgfedcba";
 const {server,url}=await startUpdaterServer({updater,port:0,extensionId:extensionA});t.after(()=>server.close());
 for(const [method,pathname,body] of [["GET","/status"],["POST","/update",JSON.stringify({operationId:"foreign",expectedCommit:f.newCommit})],["POST","/rollback",JSON.stringify({operationId:"foreign"})]]){
   const denied=await fetch(url+pathname,{method,headers:{Origin:`chrome-extension://${extensionB}`,"content-type":"application/json"},body:method==="POST"?body:undefined});
   assert.equal(denied.status,403,`${method} ${pathname} must reject another extension`);
 }
 const allowed=await fetch(url+"/status",{headers:{Origin:`chrome-extension://${extensionA}`}});
 assert.equal(allowed.status,200);
});

test("helper persists mutation outcome so a new popup can recover its operation",async t=>{
 const f=await repoFixture();
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 const extensionId="abcdefghijklmnopabcdefghijklmnop", origin=`chrome-extension://${extensionId}`;
 const {server,url}=await startUpdaterServer({updater,port:0,extensionId});t.after(()=>server.close());
 const response=await fetch(url+"/update",{method:"POST",headers:{Origin:origin,"content-type":"application/json"},body:JSON.stringify({operationId:"maint-recover",expectedCommit:f.newCommit})});
 assert.equal(response.status,200);assert.equal((await response.json()).updated,true);
 const operation=await fetch(url+"/operation?id=maint-recover",{headers:{Origin:origin}}).then(r=>r.json());
 assert.equal(operation.operation.id,"maint-recover");assert.equal(operation.operation.phase,"done");assert.equal(operation.operation.ok,true);
 assert.equal(operation.operation.result.toVersion,"1.1.22");
});

test("helper restart marks an unfinished persisted mutation interrupted",async t=>{
 const f=await repoFixture();
 const updater=new ExtensionUpdater({repoRoot:f.root,targetDir:f.target,sourceRef:f.newCommit,fetchRemote:false,stateFile:f.stateFile});
 await updater.beginOperation("lost-popup","update");
 const extensionId="abcdefghijklmnopabcdefghijklmnop", origin=`chrome-extension://${extensionId}`;
 const {server,url}=await startUpdaterServer({updater,port:0,extensionId});t.after(()=>server.close());
 const operation=await fetch(url+"/operation?id=lost-popup",{headers:{Origin:origin}}).then(r=>r.json());
 assert.equal(operation.operation.phase,"interrupted");assert.equal(operation.operation.ok,false);
});
