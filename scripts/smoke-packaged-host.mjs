import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const stage = resolve("release/host"); const executable = resolve(stage, "runtime/node.exe"); const server = resolve(stage, "dist/server.js"); const npmCli = resolve(stage, "node_modules/npm/bin/npm-cli.js"); const piRuntime = resolve(stage, "node_modules/@earendil-works/pi-coding-agent"); const port = await freePort(); const database = resolve(tmpdir(), `fitz-packaged-smoke-${randomUUID()}.db`);
for (const required of [executable, server, npmCli, piRuntime]) if (!existsSync(required)) throw new Error(`Packaged host is missing ${required}`);
const child = spawn(executable, [server], { cwd: stage, windowsHide: true, stdio: "pipe", env: { ...process.env, FITZ_PORT: String(port), FITZ_DATABASE_PATH: database } }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
try { let health; for (let attempt = 0; attempt < 40 && !health; attempt += 1) { try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) health = await response.json(); } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 200)); } } if (health?.status !== "ok") throw new Error(`Packaged host did not become healthy: ${stderr}`); process.stdout.write("FITZ_PACKAGED_HOST_SMOKE_OK\n"); }
finally { child.kill(); await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))]); for (const path of [database, `${database}-wal`, `${database}-shm`]) if (existsSync(path)) rmSync(path); }
function freePort() { return new Promise((resolvePort, reject) => { const socket = createServer(); socket.once("error", reject); socket.listen(0, "127.0.0.1", () => { const address = socket.address(); if (!address || typeof address === "string") return reject(new Error("Could not allocate smoke port")); socket.close(() => resolvePort(address.port)); }); }); }
