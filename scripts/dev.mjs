import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDevSession,
  stopLegacyDevSessions,
  terminateProcessTree,
  waitForPortAvailable,
} from "./dev-session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--fake") ? "fake" : "ninfer";
const port = parsePort(process.env.FITZ_PORT ?? "8787");
const dataRoot = resolve(process.env.FITZ_DATA_ROOT ?? join(root, "data"));

const devSession = await acquireDevSession({ lockPath: join(dataRoot, "dev-session.lock"), workspaceRoot: root, port });
try {
  await stopLegacyDevSessions(root);
  await waitForPortAvailable(port);
  await buildPackages();
  startDevelopmentProcesses(mode, devSession);
} catch (error) {
  devSession.release();
  throw error;
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Invalid FITZ_PORT: ${value}`);
  }
  return parsed;
}

function startDevelopmentProcesses(engineMode, session) {
  // Workspace packages are imported through their built dist entry points.
  // Keep those outputs current, then make the host watcher observe them too;
  // otherwise a source-host reload can retain an older package API in memory.
  const compiler = spawn(
    process.execPath,
    [join(root, "node_modules", "typescript", "lib", "tsc.js"), "-b", "--watch", "--preserveWatchOutput"],
    { cwd: root, stdio: "inherit" },
  );
  const host = spawn(
    process.execPath,
    [
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      "watch",
      "--include",
      join(root, "packages", "*", "dist", "**", "*.js"),
      join(root, "apps", "host", "src", "server.ts"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        FITZ_ENGINE_MODE: engineMode,
        FITZ_DEV_SESSION_TOKEN: session.token,
        // One repo-contained dev data root for everything: sessions, pi packages, logs, cache.
        FITZ_DATA_ROOT: dataRoot,
      },
    },
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (compiler.pid) terminateProcessTree(compiler.pid);
    if (host.pid) terminateProcessTree(host.pid);
    session.release();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const failed = () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stop();
  };
  compiler.once("error", failed);
  host.once("error", failed);
  const exited = (code, signal) => {
    if (stopping) return;
    failed();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  };
  compiler.once("exit", exited);
  host.once("exit", exited);
}

// Workspace packages resolve to built dist, so build first: a stale dist is the #1 cause
// of dev-time "does not provide an export named ..." / "module not found" failures.
async function buildPackages() {
  await new Promise((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "node_modules", "typescript", "lib", "tsc.js"), "-b"],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`tsc -b failed with exit code ${code}`));
    });
  });
}
