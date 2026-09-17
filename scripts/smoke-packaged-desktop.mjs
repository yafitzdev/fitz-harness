import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const unpackedRoot = resolve("apps/desktop/release/win-unpacked");
const executable = join(unpackedRoot, "Fitz Harness.exe");

await smokeDesktopBootstrap();
await smokeDesktopWithoutHost();
await smokeSupervisedEmbeddedHost();
process.stdout.write("FITZ_PACKAGED_DESKTOP_SMOKE_OK\n");

async function smokeDesktopBootstrap() {
  const marker = resolve(tmpdir(), `fitz-desktop-smoke-${randomUUID()}.txt`);
  const child = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FITZ_DESKTOP_SMOKE: "1", FITZ_DESKTOP_SMOKE_OUTPUT: marker },
  });
  let exited;
  let stderr = "";
  child.once("exit", (code) => { exited = code; });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(marker) && exited === undefined; attempt += 1) await delay(200);
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== "FITZ_DESKTOP_SMOKE_OK") {
      throw new Error(`Packaged desktop bootstrap failed (exit=${exited ?? "timeout"}): ${stderr}`);
    }
  } finally {
    child.kill();
    if (existsSync(marker)) rmSync(marker);
  }
}

async function smokeDesktopWithoutHost() {
  const hostArchive = join(unpackedRoot, "resources", "host.asar");
  const disabledArchive = `${hostArchive}.smoke-disabled`;
  const dataRoot = resolve(tmpdir(), `fitz-desktop-offline-smoke-${randomUUID()}`);
  const hostPort = await freePort();
  const debuggingPort = await freePort();
  if (!existsSync(hostArchive)) throw new Error("Packaged desktop is missing its host archive");
  renameSync(hostArchive, disabledArchive);
  let child;
  let exited;
  let output = "";
  try {
    child = spawn(executable, [
      `--host-port=${hostPort}`,
      `--user-data-dir=${join(dataRoot, "desktop")}`,
      `--remote-debugging-port=${debuggingPort}`,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FITZ_DESKTOP_SMOKE: "", FITZ_DESKTOP_SMOKE_OUTPUT: "" },
    });
    child.once("exit", (code, signal) => { exited = code ?? signal ?? "unknown"; });
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const rendererReady = await waitForRenderer(debuggingPort, () => exited);
    if (!rendererReady || exited !== undefined) {
      throw new Error(`Desktop did not remain open without its host (exit=${exited ?? "timeout"}): ${output.slice(-4_000)}`);
    }
    const pairingReady = await waitForOfflinePairing(debuggingPort, () => exited);
    if (!pairingReady) throw new Error(`Desktop did not expose remote connection fields without its host: ${output.slice(-4_000)}`);
  } finally {
    child?.kill();
    if (child && exited === undefined) {
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(2_000),
      ]);
    }
    if (existsSync(disabledArchive) && !existsSync(hostArchive)) renameSync(disabledArchive, hostArchive);
    await removeTemporaryDirectory(dataRoot);
  }
}

async function smokeSupervisedEmbeddedHost() {
  const hostArchive = join(unpackedRoot, "resources", "host.asar");
  const startupLauncher = join(unpackedRoot, "resources", "start-host.ps1");
  if (!existsSync(hostArchive) || !existsSync(startupLauncher)) throw new Error("Packaged desktop is missing its host archive or startup launcher");

  const port = await freePort();
  const dataRoot = resolve(tmpdir(), `fitz-desktop-host-smoke-${randomUUID()}`);
  const shutdownToken = randomUUID();
  const child = spawn(executable, [`--host-port=${port}`, `--user-data-dir=${join(dataRoot, "desktop")}`], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FITZ_DESKTOP_SMOKE: "",
      FITZ_DESKTOP_SMOKE_OUTPUT: "",
      FITZ_DEV_SESSION_TOKEN: shutdownToken,
      FITZ_DATA_ROOT: dataRoot,
      FITZ_LLM_ROOT: join(dataRoot, "llm"),
      FITZ_ENGINE_MODE: "fake",
      FITZ_AUTH_MODE: "disabled",
      FITZ_AGENT_RUNTIME: "disabled",
    },
  });
  let exited;
  let output = "";
  child.once("exit", (code, signal) => { exited = code ?? signal ?? "unknown"; });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}`, () => exited);
    if (health?.status !== "ok") throw new Error(`Supervised embedded host failed (exit=${exited ?? "timeout"}): ${output.slice(-4_000)}`);
    const shutdown = await fetch(`http://127.0.0.1:${port}/__fitz/dev/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${shutdownToken}` },
    });
    if (shutdown.status !== 202) throw new Error(`Embedded host rejected smoke shutdown with HTTP ${shutdown.status}`);
    await waitForHostExit(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    if (exited === undefined) {
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(2_000),
      ]);
    }
    await removeTemporaryDirectory(dataRoot);
  }
}

async function waitForRenderer(debuggingPort, exited) {
  for (let attempt = 0; attempt < 100 && exited() === undefined; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.some((target) => target?.type === "page")) return true;
      }
    } catch {
      // The desktop renderer may still be opening.
    }
    await delay(100);
  }
  return false;
}

async function waitForOfflinePairing(debuggingPort, exited) {
  for (let attempt = 0; attempt < 100 && exited() === undefined; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      const target = Array.isArray(targets) ? targets.find((item) => item?.type === "page") : undefined;
      if (target?.webSocketDebuggerUrl) {
        const state = await evaluateRenderer(target.webSocketDebuggerUrl, `JSON.stringify({
          pairingVisible: document.querySelector("#pairing-page")?.hidden === false,
          serverUrlVisible: document.querySelector("#host-connection-url")?.offsetParent !== null,
          apiKeyVisible: document.querySelector("#host-connection-api-key")?.offsetParent !== null,
          offlineChoice: document.body.innerText.includes("The local Fitz host is unavailable")
        })`);
        if (state?.pairingVisible && state.serverUrlVisible && state.apiKeyVisible && state.offlineChoice) return true;
      }
    } catch {
      // Startup failure handling may still be switching to the pairing page.
    }
    await delay(100);
  }
  return false;
}

async function evaluateRenderer(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  try {
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => rejectResponse(new Error("Renderer evaluation timed out")), 2_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        resolveResponse(message);
      });
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    const message = await response;
    const value = message.result?.result?.value;
    return typeof value === "string" ? JSON.parse(value) : undefined;
  } finally {
    socket.close();
  }
}

async function waitForHealth(baseUrl, exited) {
  for (let attempt = 0; attempt < 150 && exited() === undefined; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return response.json();
    } catch {
      // The Electron runtime and embedded host may still be starting.
    }
    await delay(200);
  }
  return undefined;
}

async function waitForHostExit(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error("Embedded host did not stop after its smoke shutdown request");
}

async function removeTemporaryDirectory(path) {
  for (let attempt = 0; attempt < 20 && existsSync(path); attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      await delay(100);
    }
  }
  if (existsSync(path)) throw new Error(`Could not remove packaged desktop smoke directory: ${path}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate smoke port"));
      socket.close(() => resolvePort(address.port));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
