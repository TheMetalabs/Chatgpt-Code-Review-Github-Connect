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
async function repoFixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"ashlar-updater-test-"));
 await git(root,["init","-b","main"]);await git(root,["config","user.email","fixture@example.test"]);await git(root,["config","user.name","Fixture"]);
 const write=async(version,label)=>{await mkdir(path.join(root,"extension"),{recursive:true});await writeFile(path.join(root,"extension","manifest.json"),JSON.stringify({manifest_version:3,name:"Fixture",version}));await writeFile(path.join(root,"extension","background.js"),`globalThis.version="${label}";\n`);await git(root,["add","."]);await git(root,["commit","-m",label]);return git(root,["rev-parse","HEAD"]);};
 const oldCommit=await write("1.1.21","old"), newCommit=await write("1.1.22","new");
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
