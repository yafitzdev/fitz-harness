import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { buildSandboxPlan, runSandboxed, type SandboxSpawn } from "./sandbox.js";

const tempRoots: string[] = [];
afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeTempWorkspace(): Promise<string> {
  const dir = mkdtemp(join(tmpdir(), "fitz-sandbox-"));
  return dir.then((path) => {
    tempRoots.push(path);
    return path;
  });
}

const baseOptions = {
  workspace: "/home/user/project",
  runtimeDirs: ["/data/fitz/pi"],
  tempDirs: ["/tmp"],
  homeDir: "/home/user",
  shell: "/bin/bash",
};

describe("buildSandboxPlan", () => {
  it("builds a contained bwrap argv with read-only root and writable zones", () => {
    const plan = buildSandboxPlan("rm -rf /mnt/c/Users", baseOptions, true);
    expect(plan.contained).toBe(true);
    expect(plan.argv[0]).toBe("bwrap");
    expect(plan.argv).toContain("--unshare-pid");
    // Everything starts read-only; the workspace, runtime and temp dirs are re-bound rw.
    const roIndex = plan.argv.indexOf("--ro-bind");
    expect(roIndex).toBeGreaterThan(-1);
    expect(plan.argv[roIndex + 1]).toBe("/");
    expect(plan.argv[roIndex + 2]).toBe("/");
    expect(plan.argv).toContain("--bind");
    const bindPairs: string[] = [];
    for (let i = 0; i < plan.argv.length - 1; i++) {
      if (plan.argv[i] === "--bind") bindPairs.push(`${plan.argv[i + 1]}->${plan.argv[i + 2]}`);
    }
    expect(bindPairs).toContain("/home/user/project->/home/user/project");
    expect(bindPairs).toContain("/data/fitz/pi->/data/fitz/pi");
    expect(bindPairs).toContain("/tmp->/tmp");
    expect(bindPairs.length).toBe(3);
    // Command is passed to the sandboxed shell (last three argv entries).
    expect(plan.argv.slice(-3)).toEqual(["/bin/bash", "-c", "rm -rf /mnt/c/Users"]);
  });

  it("shadows ssh key dirs with empty tmpfs mounts", () => {
    const plan = buildSandboxPlan("ls ~/.ssh", baseOptions, true);
    expect(plan.argv).toContain("--tmpfs");
    expect(plan.argv).toContain("/home/user/.ssh");
    expect(plan.argv).toContain("/etc/ssh");
  });

  it("never re-binds a root-like path read-write", () => {
    const plan = buildSandboxPlan("pwd", { ...baseOptions, workspace: "/", runtimeDirs: ["/", "C:\\"], tempDirs: [] }, true);
    expect(plan.contained).toBe(true);
    expect(plan.argv).not.toContain("--bind");
  });

  it("falls back to a direct spawn when bwrap is unavailable", () => {
    const plan = buildSandboxPlan("ls", baseOptions, false);
    expect(plan.contained).toBe(false);
    expect(plan.argv).toEqual(["/bin/bash", "-c", "ls"]);
  });
});

interface FakeSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  never?: boolean;
  spawnError?: Error;
  killCb?: () => void;
}

/** A minimal ChildProcess stand-in driven by the given spec, emitting 'error'/'close'. */
function fakeChild(spec: FakeSpec): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(child, "pid", { value: 4242, writable: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stdout });
  Object.defineProperty(child, "stderr", { value: stderr });
  (child as unknown as { kill: () => boolean }).kill = () => {
    spec.killCb?.();
    return true;
  };
  setImmediate(() => {
    if (spec.spawnError) {
      child.emit("error", spec.spawnError);
      return;
    }
    if (spec.stdout) stdout.write(spec.stdout);
    if (spec.stderr) stderr.write(spec.stderr);
    stdout.end();
    stderr.end();
    if (spec.never) return;
    setImmediate(() => child.emit("close", spec.exitCode ?? 0, null));
  });
  return child;
}

function fakeSpawn(spec: FakeSpec, capture?: (command: string, args: readonly string[], options: unknown) => void): SandboxSpawn {
  return ((command: string, args: readonly string[], options: unknown) => {
    capture?.(command, args, options);
    return fakeChild(spec);
  }) as unknown as SandboxSpawn;
}

describe("runSandboxed", () => {
  it("captures stdout/stderr and the exit code through the injected spawn", async () => {
    const spawn = fakeSpawn({ stdout: "hello\n", stderr: "warn\n", exitCode: 0 });
    const result = await runSandboxed({ command: "echo hello", ...baseOptions, available: true }, spawn);
    expect(result).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "warn\n", contained: true });
  });

  it("passes the workspace as cwd and sets FITZ_CONTAINED when contained", async () => {
    let captured: { command: string; args: readonly string[]; options: { cwd: string; env: Record<string, string> } } | undefined;
    const spawn = fakeSpawn({ stdout: "ok" }, (command, args, options) => {
      captured = { command, args, options: options as { cwd: string; env: Record<string, string> } };
    });
    await runSandboxed({ command: "pwd", ...baseOptions, available: true }, spawn);
    expect(captured).toBeDefined();
    expect(captured!.command).toBe("bwrap");
    expect(captured!.options.cwd).toBe("/home/user/project");
    expect(captured!.options.env.FITZ_CONTAINED).toBe("1");
  });

  it("does not set FITZ_CONTAINED when falling back to a direct spawn", async () => {
    let env: Record<string, string> | undefined;
    const spawn = fakeSpawn({ stdout: "ok" }, (_c, _a, options) => {
      env = (options as { env: Record<string, string> }).env;
    });
    const result = await runSandboxed({ command: "pwd", workspace: "C:\\Users\\x\\project", runtimeDirs: [], tempDirs: [], homeDir: "C:\\Users\\x", shell: "bash" }, spawn);
    expect(result.contained).toBe(false);
    expect(env!.FITZ_CONTAINED).toBeUndefined();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = fakeSpawn({});
    await expect(runSandboxed({ command: "sleep 10", ...baseOptions, signal: controller.signal }, spawn)).rejects.toThrow("aborted");
  });

  it("kills the child and rejects with aborted when the signal fires mid-run", async () => {
    const controller = new AbortController();
    const spawn = fakeSpawn({ never: true });
    const pending = runSandboxed({ command: "sleep 10", ...baseOptions, signal: controller.signal }, spawn);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("aborted");
  });

  it("kills the child and rejects with a timeout error when the command runs long", async () => {
    const spawn = fakeSpawn({ never: true });
    await expect(runSandboxed({ command: "sleep 10", ...baseOptions, timeout: 0.05 }, spawn)).rejects.toThrow("timeout:0.05");
  });

  it("rejects with the spawn error when the child fails to launch", async () => {
    const spawnError = new Error("spawn bwrap ENOENT");
    const spawn = fakeSpawn({ spawnError });
    await expect(runSandboxed({ command: "ls", ...baseOptions }, spawn)).rejects.toThrow("spawn bwrap ENOENT");
  });

  it("surfaces a non-zero exit code", async () => {
    const spawn = fakeSpawn({ stderr: "boom", exitCode: 2 });
    const result = await runSandboxed({ command: "false", ...baseOptions }, spawn);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });
});

describe.skipIf(process.platform === "win32")("runSandboxed with the real spawn", () => {
  it("runs a command through the host shell", async () => {
    const workspace = await makeTempWorkspace();
    const result = await runSandboxed({
      command: "printf sandboxed",
      workspace,
      runtimeDirs: [],
      tempDirs: [],
      homeDir: tmpdir(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sandboxed");
  });
});
