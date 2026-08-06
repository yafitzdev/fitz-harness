/**
 * OS-level containment for the agent's bash tool.
 *
 * On Linux (including WSL2) every shell command runs inside a bubblewrap (bwrap)
 * sandbox: the whole filesystem is mounted read-only and only the project workspace,
 * the Fitz runtime dirs, and the temp dirs are re-bound read-write. Deletes and writes
 * outside those zones then fail at the kernel level (EROFS) no matter how the command
 * is constructed — the machine guarantee that backs the policy engine's rewrites/blocks.
 * SSH key dirs are shadowed with empty tmpfs mounts so credential reads fail too.
 *
 * When bwrap is unavailable (e.g. a Windows dev host) commands fall back to a direct
 * spawn: the policy engine still rewrites deletes to trash and blocks destructive
 * commands, but there is no kernel-level write barrier. The service logs a warning.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SandboxOptions {
  /** The agent's working directory / project workspace; the primary writable root in the sandbox. */
  workspace: string;
  /** Fitz-owned runtime dirs (pi agent dir, llm root, logs, cache, engines) — writable. */
  runtimeDirs: readonly string[];
  /** OS temp dir(s) — writable. */
  tempDirs: readonly string[];
  /** The user's home dir; its `.ssh` is shadowed inside the sandbox. */
  homeDir: string;
  /** Shell to run the command with. Defaults to a platform-appropriate bash. */
  shell?: string;
}

export interface SandboxPlan {
  /** Full argv to spawn (bwrap wrapper, or the bare shell on fallback). */
  argv: string[];
  /** Whether the command will actually run inside the OS-level container. */
  contained: boolean;
  /** The shell binary used. */
  shell: string;
}

export interface SandboxRunOptions extends SandboxOptions {
  command: string;
  /** Timeout in seconds (optional, no default timeout). */
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Whether bwrap is available; defaults to probing the host. Injectable for tests. */
  available?: boolean;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  contained: boolean;
}

/** Injectable spawn seam (tests substitute a fake; the SDK has an analogous spawnHook). */
export type SandboxSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

let bwrapAvailableCache: boolean | undefined;

/** Whether bubblewrap is installed and runnable on this host. Cached after the first probe. */
export function bwrapAvailable(): boolean {
  if (bwrapAvailableCache !== undefined) return bwrapAvailableCache;
  bwrapAvailableCache = process.platform !== "win32" && probeCommand("bwrap");
  return bwrapAvailableCache;
}

function probeCommand(name: string): boolean {
  try {
    const result = spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/** A platform-appropriate bash, mirroring the SDK's shell discovery (Git Bash on Windows). */
export function resolveShell(): string {
  if (process.platform !== "win32") {
    if (existsSync("/bin/bash")) return "/bin/bash";
    return process.env.SHELL || "bash";
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!base) continue;
    const candidate = join(base, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
}

function isRootLike(path: string): boolean {
  return path === "/" || /^[A-Za-z]:[\\/]?$/.test(path);
}

/** `--bind src src` pairs for the writable zones; root-like paths stay read-only. */
function writableBinds(dirs: readonly string[]): string[] {
  const binds: string[] = [];
  for (const dir of dirs) {
    if (!dir || isRootLike(dir)) continue;
    binds.push("--bind", dir, dir);
  }
  return binds;
}

/**
 * Assemble the containment argv for one shell command. Pure: everything needed to
 * reason about the sandbox is in the arguments, so it is unit-testable on any platform.
 * `available` is injectable; it defaults to probing the real host for bwrap.
 */
export function buildSandboxPlan(command: string, options: SandboxOptions, available: boolean = bwrapAvailable()): SandboxPlan {
  const shell = options.shell ?? resolveShell();
  if (!available) {
    return { argv: [shell, "-c", command], contained: false, shell };
  }
  const argv = [
    "bwrap",
    // Fresh namespaces: pid (the sandbox cannot signal host processes), ipc, uts;
    // the mount namespace is implicit in the bind setup. Networking is deliberately NOT
    // unshared — the agent needs to install packages and fetch remotes.
    "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-mount",
    // Tear the sandbox down if the host process dies, so no agent shell outlives it.
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    // Everything read-only first; writable zones are re-bound below (later binds win).
    "--ro-bind", "/", "/",
    ...writableBinds([options.workspace, ...options.runtimeDirs, ...options.tempDirs]),
    // Shadow ssh keys: reads inside the sandbox see an empty dir instead of host keys.
    // The path must stay POSIX (forward slashes) even when building on a Windows host.
    ...(options.homeDir.startsWith("/") ? ["--tmpfs", `${options.homeDir.replace(/[\\/]+$/, "")}/.ssh`] : []),
    "--tmpfs", "/etc/ssh",
    "--chdir", options.workspace,
    shell, "-c", command,
  ];
  return { argv, contained: true, shell };
}

/** Hard cap on captured output per stream (memory bound for runaway output). */
const CAPTURE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Run one shell command through the containment wrapper and capture its output.
 * Rejects with `Error("aborted")` on abort and `Error("timeout:<seconds>")` on timeout,
 * matching the SDK's bash tool error contract (the sandboxed-bash tool formats both).
 */
export async function runSandboxed(options: SandboxRunOptions, spawnFn: SandboxSpawn = spawn): Promise<SandboxRunResult> {
  if (options.signal?.aborted) throw new Error("aborted");
  const plan = buildSandboxPlan(options.command, options, options.available);
  const env = { ...process.env, ...(options.env ?? {}), ...(plan.contained ? { FITZ_CONTAINED: "1" } : {}) };
  const child = spawnFn(plan.argv[0]!, plan.argv.slice(1), {
    cwd: options.workspace,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await new Promise<SandboxRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const kill = () => {
      if (child.pid) killProcessTree(child.pid);
    };
    const onAbort = () => {
      kill();
      settle(() => reject(new Error("aborted")));
    };
    if (options.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        kill();
        settle(() => reject(new Error(`timeout:${options.timeout}`)));
      }, options.timeout * 1000);
    }
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stream === "stdout") stdout = (stdout + text).slice(-CAPTURE_CAP_BYTES);
      else stderr = (stderr + text).slice(-CAPTURE_CAP_BYTES);
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (error) => settle(() => reject(error)));
    // 'close' fires after stdio streams have flushed, so stdout/stderr are complete.
    child.on("close", (code) => settle(() => resolve({ exitCode: code ?? 0, stdout, stderr, contained: plan.contained })));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Kill a process and its whole tree (taskkill on Windows, process group on Unix). */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
    } catch {
      // Best effort: if taskkill is unavailable the process tree stays, but nothing else we can do.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
