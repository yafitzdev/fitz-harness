import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { bwrapAvailable, buildSandboxPlan, runSandboxed, type SandboxSpawn } from "./sandbox.js";

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
    const plan = buildSandboxPlan("rm -rf /mnt/c/Users", baseOptions, true, "linux");
    expect(plan.contained).toBe(true);
    expect(plan.argv[0]).toBe("bwrap");
    expect(plan.argv).toContain("--unshare-pid");
    // Everything starts read-only; the workspace, runtime and temp dirs are re-bound rw.
    const roIndex = plan.argv.indexOf("--ro-bind");
    expect(roIndex).toBeGreaterThan(-1);
    expect(plan.argv[roIndex + 1]).toBe("/");
    expect(plan.argv[roIndex + 2]).toBe("/");
    expect(plan.argv).toContain("--bind-try");
    const bindPairs: string[] = [];
    for (let i = 0; i < plan.argv.length - 1; i++) {
      if (plan.argv[i] === "--bind-try") bindPairs.push(`${plan.argv[i + 1]}->${plan.argv[i + 2]}`);
    }
    expect(bindPairs).toContain("/home/user/project->/home/user/project");
    expect(bindPairs).toContain("/data/fitz/pi->/data/fitz/pi");
    expect(bindPairs).toContain("/tmp->/tmp");
    expect(bindPairs.length).toBe(3);
    // Command is passed to the sandboxed shell (last three argv entries).
    expect(plan.argv.slice(-3)).toEqual(["/bin/bash", "-c", "rm -rf /mnt/c/Users"]);
    expect(plan.argv.indexOf("--proc")).toBeGreaterThan(roIndex);
    expect(plan.argv.indexOf("--dev")).toBeGreaterThan(roIndex);
    expect(plan.argv).not.toContain("--unshare-mount");
  });

  it("shadows an existing SSH directory with an empty tmpfs mount", async () => {
    const homeDir = await makeTempWorkspace();
    await mkdir(join(homeDir, ".ssh"));
    const plan = buildSandboxPlan("ls ~/.ssh", { ...baseOptions, homeDir }, true);
    expect(plan.argv).toContain("--tmpfs");
    const guestHome = homeDir.replaceAll("\\", "/").replace(/^([a-z]):/i, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`);
    expect(plan.argv).toContain(`${guestHome}/.ssh`);
  });

  it("never re-binds a root-like path read-write", () => {
    const plan = buildSandboxPlan("pwd", { ...baseOptions, workspace: "/", runtimeDirs: ["/", "C:\\"], tempDirs: [] }, true, "linux");
    expect(plan.contained).toBe(true);
    expect(plan.argv).not.toContain("--bind-try");
  });

  it("refuses execution when bwrap is unavailable", () => {
    expect(() => buildSandboxPlan("ls", baseOptions, false, "linux")).toThrow("No command was executed");
  });

  it("maps Windows and managed-runtime paths into WSL without changing shell source", () => {
    const command = 'printf "%s" "a b"';
    const plan = buildSandboxPlan(command, { workspace: "C:\\work\\my project", homeDir: "C:\\Users\\test", runtimeDirs: ["\\\\wsl.localhost\\Fitz-Inference\\opt\\fitz\\llm"], tempDirs: ["C:\\Temp"] }, true, "win32");
    expect(plan.argv.slice(0, 5)).toEqual(["wsl.exe", "--distribution", "Fitz-Inference", "--exec", "bwrap"]);
    expect(plan.argv).toContain("/mnt/c/work/my project");
    expect(plan.argv).toContain("/opt/fitz/llm");
    expect(plan.argv).toContain("/mnt/c/Temp");
    expect(plan.argv).toContain("/init");
    expect(plan.argv).toContain("WSL_INTEROP");
    expect(plan.argv.slice(-3)).toEqual(["/bin/bash", "-c", command]);
  });

  it("does not make a whole Windows drive writable or use an unrelated WSL distribution", () => {
    const options = { workspace: "C:\\", homeDir: "C:\\Users\\test", runtimeDirs: [], tempDirs: [] };
    expect(buildSandboxPlan("pwd", options, true, "win32").argv).not.toContain("--bind-try");
    expect(() => buildSandboxPlan("pwd", { ...options, workspace: "\\\\wsl.localhost\\Other\\home" }, true, "win32")).toThrow("Fitz-Inference");
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
  // A fake child must never cause the production taskkill helper to target a
  // real process with a coincidentally matching PID.
  Object.defineProperty(child, "pid", { value: undefined, writable: true });
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
    expect(captured!.command).toBe(process.platform === "win32" ? "wsl.exe" : "bwrap");
    expect(captured!.options.cwd).toBe("/home/user/project");
    expect(captured!.options.env.FITZ_CONTAINED).toBe("1");
  });

  it("does not spawn anything when containment is unavailable", async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: "ok" }));
    await expect(runSandboxed({ command: "pwd", ...baseOptions, available: false }, spawn)).rejects.toThrow(/no command was executed/i);
    expect(spawn).not.toHaveBeenCalled();
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
    const pending = runSandboxed({ command: "sleep 10", ...baseOptions, available: true, signal: controller.signal }, spawn);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow("aborted");
  });

  it("kills the child and rejects with a timeout error when the command runs long", async () => {
    const spawn = fakeSpawn({ never: true });
    await expect(runSandboxed({ command: "sleep 10", ...baseOptions, available: true, timeout: 0.05 }, spawn)).rejects.toThrow("timeout:0.05");
  });

  it("rejects with the spawn error when the child fails to launch", async () => {
    const spawnError = new Error("spawn bwrap ENOENT");
    const spawn = fakeSpawn({ spawnError });
    await expect(runSandboxed({ command: "ls", ...baseOptions, available: true }, spawn)).rejects.toThrow("spawn bwrap ENOENT");
  });

  it("surfaces a non-zero exit code", async () => {
    const spawn = fakeSpawn({ stderr: "boom", exitCode: 2 });
    const result = await runSandboxed({ command: "false", ...baseOptions, available: true }, spawn);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });
});

describe.skipIf(!bwrapAvailable())("runSandboxed with the real spawn", () => {
  it("runs a command through the host shell", async () => {
    const workspace = await makeTempWorkspace();
    const result = await runSandboxed({
      command: "printf sandboxed",
      workspace,
      runtimeDirs: [],
      tempDirs: [],
      homeDir: tmpdir(),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("sandboxed");
    expect(result.contained).toBe(true);
  });

  it("allows workspace writes while denying sibling writes and host SSH reads", async () => {
    const root = await makeTempWorkspace();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const homeDir = join(root, "home");
    await mkdir(workspace);
    await mkdir(join(homeDir, ".ssh"), { recursive: true });
    await writeFile(outside, "unchanged");
    await writeFile(join(homeDir, ".ssh", "fixture"), "private fixture");
    const result = await runSandboxed({ workspace, runtimeDirs: [], tempDirs: [], homeDir, command: "printf allowed > inside.txt; if printf changed > ../outside.txt; then exit 21; fi; if cat ../home/.ssh/fixture; then exit 22; fi" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.contained).toBe(true);
    expect(await readFile(join(workspace, "inside.txt"), "utf8")).toBe("allowed");
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  it.skipIf(process.platform !== "win32")("blocks native Windows executables inside WSL", async () => {
    const workspace = await makeTempWorkspace();
    const result = await runSandboxed({ workspace, runtimeDirs: [], tempDirs: [], homeDir: workspace, command: "/mnt/c/Windows/System32/cmd.exe /c echo escaped" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("escaped");
  });

  it("cancels the real shell and its children before delayed writes can occur", async () => {
    const workspace = await makeTempWorkspace();
    const controller = new AbortController();
    const pending = runSandboxed({ workspace, runtimeDirs: [], tempDirs: [], homeDir: workspace, signal: controller.signal, command: "printf started > started.txt; sleep 2; printf leaked > late.txt" });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => expect(await readFile(join(workspace, "started.txt"), "utf8")).toBe("started"), { timeout: 5_000 });
      controller.abort();
      expect(await outcome).toEqual(expect.objectContaining({ message: "aborted" }));
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      await expect(readFile(join(workspace, "late.txt"), "utf8")).rejects.toThrow();
    } finally { controller.abort(); await outcome; }
  });
});
