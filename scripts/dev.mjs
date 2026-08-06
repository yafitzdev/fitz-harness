import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--fake") ? "fake" : "ninfer";
const port = process.env.FITZ_PORT ?? "8787";

await guardPort(port);
await buildPackages();
startHost(mode);

function startHost(engineMode) {
  const child = spawn(
    process.execPath,
    [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", join(root, "apps", "host", "src", "server.ts")],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        FITZ_ENGINE_MODE: engineMode,
        // One repo-contained dev data root for everything: sessions, pi packages, logs, cache.
        FITZ_DATA_ROOT: process.env.FITZ_DATA_ROOT ?? join(root, "data"),
      },
    },
  );
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
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

// Two hosts on the same port fight over the database (SQLite locks) and sockets
// (EADDRINUSE), so refuse to start when something is already answering.
async function guardPort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    console.error(
      `A Fitz host is already answering on http://127.0.0.1:${port}/health (HTTP ${response.status}). ` +
        "Stop it before starting a dev host, or pick another port with FITZ_PORT.",
    );
    process.exit(1);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(
        `Port ${port} is occupied but nothing answered /health within 500ms. ` +
          "Stop whatever holds the port, or set FITZ_PORT to a free port.",
      );
      process.exit(1);
    }
    if (error?.cause?.code === "ECONNREFUSED") return;
    console.error(
      `Port ${port} is not usable (${error?.cause?.code ?? error?.name}). ` +
        "Stop whatever holds it, or set FITZ_PORT to a free port.",
    );
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}
