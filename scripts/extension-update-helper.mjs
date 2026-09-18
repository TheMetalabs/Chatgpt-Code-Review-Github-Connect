import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 17373;
const MAX_BODY = 8 * 1024;

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function git(cwd, args, {binary = false} = {}) {
  const {stdout} = await execFileAsync("git", args, {
    cwd,
    encoding: binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return binary ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)) : String(stdout).trim();
}

export function compareVersions(left, right) {
  const parse = value => String(value || "").split(".").map(part => {
    if (!/^\d+$/.test(part)) throw new Error(`invalid extension version: ${value}`);
    return Number(part);
  });
  const a = parse(left), b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

async function readManifest(dir) {
  try {
    const value = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    if (!value || value.manifest_version !== 3 || typeof value.version !== "string") throw new Error("invalid manifest");
    compareVersions(value.version, value.version);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}

async function writeState(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {mode:0o600});
  await rename(temp, file);
}

export class ExtensionUpdater {
  constructor({
    repoRoot,
    targetDir,
    branch = "main",
    sourceRef,
    fetchRemote = true,
    stateFile = path.join(homedir(), ".ashlar", "extension-updater.json"),
  }) {
    this.repoRoot = path.resolve(repoRoot);
    this.targetDir = path.resolve(targetDir);
    this.branch = branch;
    this.sourceRef = sourceRef;
    this.fetchRemote = fetchRemote;
    this.stateFile = path.resolve(stateFile);
  }

  async resolveSource({fetch = true} = {}) {
    if (fetch && this.fetchRemote) await git(this.repoRoot, ["fetch", "--quiet", "origin", this.branch]);
    const ref = this.sourceRef || `origin/${this.branch}`;
    const commit = await git(this.repoRoot, ["rev-parse", ref]);
    const manifest = JSON.parse(await git(this.repoRoot, ["show", `${ref}:extension/manifest.json`]));
    if (manifest?.manifest_version !== 3 || typeof manifest.version !== "string") throw new Error("source extension manifest is invalid");
    compareVersions(manifest.version, manifest.version);
    return {ref, commit, manifest};
  }

  async status({fetch = true} = {}) {
    const source = await this.resolveSource({fetch});
    const installed = await readManifest(this.targetDir);
    const state = await readState(this.stateFile);
    const backupDir = state.targetDir === this.targetDir ? state.backupDir : undefined;
    const backup = backupDir && await exists(backupDir) ? await readManifest(backupDir) : null;
    const updateAvailable = !installed || compareVersions(source.manifest.version, installed.version) > 0;
    return {
      ok:true,
      installedVersion: installed?.version || null,
      availableVersion: source.manifest.version,
      availableCommit: source.commit,
      updateAvailable,
      backupAvailable: Boolean(backup),
      backupVersion: backup?.version || null,
      branch: this.branch,
    };
  }

  async materialize(ref, destination) {
    const names = (await git(this.repoRoot, ["ls-tree", "-r", "--name-only", ref, "--", "extension"]))
      .split(/\r?\n/).filter(Boolean);
    if (!names.length) throw new Error("source ref contains no extension files");
    for (const name of names) {
      if (!name.startsWith("extension/") || name.includes("..")) throw new Error(`unsafe extension path: ${name}`);
      const relative = name.slice("extension/".length);
      if (!relative || path.isAbsolute(relative)) throw new Error(`unsafe extension path: ${name}`);
      const target = path.resolve(destination, relative);
      if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error(`unsafe extension path: ${name}`);
      await mkdir(path.dirname(target), {recursive:true});
      await writeFile(target, await git(this.repoRoot, ["show", `${ref}:${name}`], {binary:true}));
    }
    const manifest = await readManifest(destination);
    if (!manifest) throw new Error("staged extension manifest missing");
    return manifest;
  }

  async update({expectedCommit, force = false} = {}) {
    const source = await this.resolveSource({fetch:true});
    if (expectedCommit && expectedCommit !== source.commit) {
      const error = new Error("available extension changed; check again before updating");
      error.statusCode = 409; throw error;
    }
    const installed = await readManifest(this.targetDir);
    if (installed && compareVersions(source.manifest.version, installed.version) <= 0 && !force) {
      return {ok:true, updated:false, fromVersion:installed.version, toVersion:source.manifest.version, commit:source.commit};
    }

    const parent = path.dirname(this.targetDir);
    await mkdir(parent, {recursive:true});
    const stage = await mkdtemp(path.join(parent, ".ashlar-extension-stage-"));
    const backupDir = `${this.targetDir}.ashlar-backup`;
    let movedOld = false;
    try {
      const staged = await this.materialize(source.ref, stage);
      if (staged.version !== source.manifest.version) throw new Error("staged extension version mismatch");
      await rm(backupDir, {recursive:true, force:true});
      if (await exists(this.targetDir)) {
        await rename(this.targetDir, backupDir);
        movedOld = true;
      }
      try { await rename(stage, this.targetDir); }
      catch (error) {
        if (movedOld && !await exists(this.targetDir) && await exists(backupDir)) await rename(backupDir, this.targetDir);
        throw error;
      }
      await writeState(this.stateFile, {
        targetDir:this.targetDir,
        backupDir:movedOld ? backupDir : null,
        installedCommit:source.commit,
        installedVersion:source.manifest.version,
        previousVersion:installed?.version || null,
        updatedAt:Date.now(),
      });
      return {ok:true, updated:true, fromVersion:installed?.version || null, toVersion:source.manifest.version, commit:source.commit};
    } finally {
      await rm(stage, {recursive:true, force:true}).catch(()=>{});
    }
  }

  async rollback() {
    const state = await readState(this.stateFile);
    const backupDir = state.targetDir === this.targetDir ? state.backupDir : null;
    if (!backupDir || !await exists(backupDir)) {
      const error = new Error("no extension backup is available");
      error.statusCode = 409; throw error;
    }
    const current = await readManifest(this.targetDir);
    const backup = await readManifest(backupDir);
    if (!backup) throw new Error("extension backup manifest missing");
    const swap = `${this.targetDir}.ashlar-swap-${process.pid}`;
    await rm(swap, {recursive:true, force:true});
    await rename(this.targetDir, swap);
    try {
      await rename(backupDir, this.targetDir);
      await rename(swap, backupDir);
    } catch (error) {
      if (!await exists(this.targetDir) && await exists(swap)) await rename(swap, this.targetDir);
      throw error;
    }
    await writeState(this.stateFile, {
      ...state,
      targetDir:this.targetDir,
      backupDir,
      installedVersion:backup.version,
      previousVersion:current?.version || null,
      rolledBackAt:Date.now(),
    });
    return {ok:true, rolledBack:true, fromVersion:current?.version || null, toVersion:backup.version};
  }
}

function allowedOrigin(origin, extensionId) {
  if (!origin) return false;
  if (extensionId) return origin === `chrome-extension://${extensionId}`;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function sendJson(res, status, body, origin) {
  const headers = {"content-type":"application/json; charset=utf-8","cache-control":"no-store","vary":"Origin"};
  if (origin) headers["access-control-allow-origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0, raw = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), {statusCode:413});
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

export async function startUpdaterServer({updater, port = DEFAULT_PORT, extensionId} = {}) {
  const server = createServer(async (req, res) => {
    const origin = String(req.headers.origin || "");
    if (!allowedOrigin(origin, extensionId)) return sendJson(res, 403, {ok:false,error:"extension origin required"});
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin":origin,
        "access-control-allow-methods":"GET, POST, OPTIONS",
        "access-control-allow-headers":"content-type",
        "access-control-max-age":"600",
        "vary":"Origin",
      }); return res.end();
    }
    try {
      if (req.method === "GET" && req.url === "/status") return sendJson(res, 200, await updater.status({fetch:true}), origin);
      if (req.method === "POST" && req.url === "/update") {
        const body = await readBody(req);
        return sendJson(res, 200, await updater.update({expectedCommit:body.expectedCommit}), origin);
      }
      if (req.method === "POST" && req.url === "/rollback") {
        await readBody(req);
        return sendJson(res, 200, await updater.rollback(), origin);
      }
      return sendJson(res, 404, {ok:false,error:"not found"}, origin);
    } catch (error) {
      return sendJson(res, Number(error?.statusCode) || 500, {ok:false,error:String(error?.message || error)}, origin);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {server, url:`http://127.0.0.1:${address.port}`};
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const targetDir = path.resolve(arg("--dir") || process.env.ASHLAR_EXTENSION_DIR || path.join(repoRoot, "extension"));
  const branch = arg("--branch") || process.env.ASHLAR_EXTENSION_UPDATE_BRANCH || "main";
  const port = Number(arg("--port") || process.env.ASHLAR_EXTENSION_UPDATE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid updater port");
  const extensionId = process.env.ASHLAR_EXTENSION_UPDATER_EXTENSION_ID || undefined;
  const updater = new ExtensionUpdater({repoRoot,targetDir,branch});
  if (process.argv.includes("--status")) {
    process.stdout.write(JSON.stringify(await updater.status({fetch:true}), null, 2) + "\n");
    return;
  }
  const {url} = await startUpdaterServer({updater,port,extensionId});
  console.log(`Ashlar extension updater listening on ${url}`);
  console.log(`Target: ${targetDir}`);
  console.log(`Source: origin/${branch} (extension/ only)`);
  if (extensionId) console.log(`Allowed extension ID: ${extensionId}`);
  else console.log("Allowed origin: any local Chrome extension; set ASHLAR_EXTENSION_UPDATER_EXTENSION_ID to pin one ID.");
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) main().catch(error => { console.error(error); process.exitCode = 1; });
