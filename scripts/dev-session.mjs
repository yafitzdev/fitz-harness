import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OWNER_START_TOLERANCE_MS = 10_000;

/**
 * Atomically becomes the sole dev supervisor for a data root. A newer launch
 * replaces the previous verified supervisor; stale locks and PID reuse are
 * reclaimed without signalling an unrelated process.
 */
export async function acquireDevSession({ lockPath, workspaceRoot, port }) {
  const record = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    workspaceRoot: resolve(workspaceRoot),
    port: Number(port),
  };
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (publishLock(lockPath, record)) return createLease(lockPath, record);
    const owner = readDevSession(lockPath);
    if (!owner) {
      removeLock(lockPath);
      continue;
    }
    if (!processIsAlive(owner.pid)) {
      removeOwnedLock(lockPath, owner.token);
      continue;
    }

    const ownerProcess = listSystemProcesses().find((candidate) => candidate.pid === owner.pid);
    if (!ownerProcess || !recordMatchesProcess(owner, ownerProcess)) {
      // The PID was reused after an unclean exit. The ownership file is stale,
      // but the live process is not ours and must never be terminated.
      removeOwnedLock(lockPath, owner.token);
      continue;
    }

    console.info(`Replacing Fitz dev session ${owner.pid} with ${process.pid}...`);
    const graceful = await requestGracefulHostShutdown(owner);
    if (graceful) await waitForHostRelease(join(dirname(lockPath), "host.lock"), 10_000);
    terminateProcessTree(owner.pid);
    try {
      await waitForProcessExit(owner.pid, 2_000);
    } catch {
      terminateProcessTree(owner.pid, true);
      await waitForProcessExit(owner.pid, 3_000);
    }
    removeOwnedLock(lockPath, owner.token);
  }

  throw new Error("Could not take ownership of the Fitz dev session");
}

/** Remove pre-supervisor and orphaned tsx sessions for this exact workspace. */
export async function stopLegacyDevSessions(workspaceRoot, excludingPid = process.pid) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roots = findWorkspaceDevRoots(workspaceRoot, listSystemProcesses(), excludingPid);
    if (roots.length === 0) return;
    for (const pid of roots) {
      console.info(`Closing previous Fitz dev process tree (PID ${pid})...`);
      terminateProcessTree(pid, attempt > 0);
    }
    await delay(100);
  }
  const remaining = findWorkspaceDevRoots(workspaceRoot, listSystemProcesses(), excludingPid);
  if (remaining.length > 0) throw new Error(`Could not close previous Fitz dev process tree(s): ${remaining.join(", ")}`);
}

/**
 * Finds the narrowest safe process-tree roots belonging to this checkout. It
 * only follows ancestors that name the exact source server or scripts/dev.mjs.
 */
export function findWorkspaceDevRoots(workspaceRoot, processes, excludingPid = process.pid) {
  const serverPath = canonical(join(resolve(workspaceRoot), "apps", "host", "src", "server.ts"));
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const roots = new Set();

  for (const candidate of processes) {
    if (candidate.pid === excludingPid || !canonical(candidate.commandLine).includes(serverPath)) continue;
    let root = candidate;
    let ancestor = byPid.get(candidate.parentPid);
    for (let depth = 0; ancestor && depth < 12; depth += 1) {
      const command = canonical(ancestor.commandLine);
      if (command.includes(serverPath) || isDevController(command)) {
        root = ancestor;
        if (isDevController(command)) break;
        ancestor = byPid.get(ancestor.parentPid);
        continue;
      }
      break;
    }
    if (root.pid !== excludingPid) roots.add(root.pid);
  }

  // If both a parent and child were discovered from separate candidates, only
  // terminate the parent. taskkill/process-tree traversal handles descendants.
  return [...roots].filter((pid) => !hasAncestorInSet(pid, roots, byPid));
}

export function recordMatchesProcess(owner, candidate) {
  if (!isDevController(canonical(candidate.commandLine))) return false;
  const ownerStartedAt = Date.parse(owner.startedAt);
  const processStartedAt = Date.parse(candidate.startedAt);
  return Number.isFinite(ownerStartedAt)
    && Number.isFinite(processStartedAt)
    && Math.abs(ownerStartedAt - processStartedAt) <= OWNER_START_TOLERANCE_MS;
}

export function listSystemProcesses() {
  return process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
}

export function terminateProcessTree(pid, force = false) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    if (result.error) throw result.error;
    // taskkill returns 128 when the target completed between inspection and
    // termination. Either outcome means there is nothing left to own.
    if (result.status !== 0 && processIsAlive(pid)) throw new Error(`Could not terminate process tree ${pid}`);
    return;
  }

  const processes = listSystemProcesses();
  const descendants = descendantsOf(pid, processes).reverse();
  for (const target of [...descendants, pid]) signalIfAlive(target, force ? "SIGKILL" : "SIGTERM");
}

export async function waitForPortAvailable(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await portIsListening(port))) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    `Port ${port} is still occupied after previous Fitz dev sessions were closed. `
      + `Stop the unrelated process using it, or set FITZ_PORT to a free port.`,
  );
}

function createLease(path, record) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    removeOwnedLock(path, record.token);
  };
  process.once("exit", release);
  return { ...record, release };
}

function publishLock(path, contents) {
  const candidate = `${path}.${contents.pid}.${contents.token}.tmp`;
  try {
    writeFileSync(candidate, JSON.stringify(contents), { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(candidate, path);
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    return false;
  } finally {
    try { unlinkSync(candidate); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
}

function readDevSession(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && typeof parsed.startedAt === "string"
      && typeof parsed.workspaceRoot === "string"
      && Number.isInteger(parsed.port)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function removeOwnedLock(path, token) {
  if (readDevSession(path)?.token !== token) return;
  removeLock(path);
}

function removeLock(path) {
  try { unlinkSync(path); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}

async function requestGracefulHostShutdown(owner) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${owner.port}/__fitz/dev/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHostRelease(hostLockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const owner = readHostOwner(hostLockPath);
    if (!owner || !processIsAlive(owner.pid)) return;
    await delay(100);
  } while (Date.now() < deadline);
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(50);
  if (processIsAlive(pid)) throw new Error(`Previous Fitz dev session ${pid} did not exit`);
}

function readHostOwner(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
}

async function portIsListening(port) {
  const { createConnection } = await import("node:net");
  return new Promise((resolveListening) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    let settled = false;
    const done = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(500, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function listWindowsProcesses() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine) | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect Windows processes: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry.ProcessId),
    parentPid: Number(entry.ParentProcessId),
    startedAt: String(entry.CreationDate ?? ""),
    commandLine: String(entry.CommandLine ?? ""),
  }));
}

function listPosixProcesses() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,lstart=,args="], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect processes: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: new Date(match[3]).toISOString(), commandLine: match[4] }] : [];
  });
}

function descendantsOf(pid, processes) {
  const children = new Map();
  for (const entry of processes) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parentPid, siblings);
  }
  const found = [];
  const visit = (parent) => {
    for (const child of children.get(parent) ?? []) { found.push(child); visit(child); }
  };
  visit(pid);
  return found;
}

function signalIfAlive(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
}

function hasAncestorInSet(pid, roots, byPid) {
  let current = byPid.get(pid);
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (roots.has(current.parentPid)) return true;
    current = byPid.get(current.parentPid);
  }
  return false;
}

function isDevController(command) {
  return /(?:^|\s|["'])scripts\/dev\.mjs(?:\s|$|["'])/.test(command);
}

function canonical(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
