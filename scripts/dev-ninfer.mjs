import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(
  process.execPath,
  [join(root, "node_modules", "tsx", "dist", "cli.mjs"), "watch", join(root, "apps", "host", "src", "server.ts")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      FITZ_ENGINE_MODE: "ninfer",
      FITZ_DATABASE_PATH: process.env.FITZ_DATABASE_PATH ?? join(root, "data", "fitz-ninfer.db"),
    },
  },
);

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
