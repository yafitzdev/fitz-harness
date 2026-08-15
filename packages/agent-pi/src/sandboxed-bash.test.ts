import { describe, expect, it, vi } from "vitest";
import { createSandboxedBashTool, type SandboxedBashExecutor, type SandboxedBashResult } from "./sandboxed-bash.js";

function okResult(overrides: Partial<SandboxedBashResult> = {}): SandboxedBashResult {
  return { exitCode: 0, stdout: "", stderr: "", contained: true, ...overrides };
}

describe("createSandboxedBashTool", () => {
  it("registers as the 'bash' tool with a command parameter", () => {
    const tool = createSandboxedBashTool(async () => okResult());
    expect(tool.name).toBe("bash");
    expect(tool.label).toBe("bash");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toMatchObject({
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "number" } },
      required: ["command"],
    });
  });

  it("returns stdout text on success", async () => {
    const executor = vi.fn(async () => okResult({ stdout: "hello world\n" })) as unknown as SandboxedBashExecutor;
    const tool = createSandboxedBashTool(executor);
    const result = await tool.execute("call-1", { command: "echo hello world" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello world\n" });
    expect(result.details).toMatchObject({ contained: true, exitCode: 0 });
    expect(executor).toHaveBeenCalledWith({ command: "echo hello world", timeout: 15 });
  });

  it("merges stderr after stdout", async () => {
    const tool = createSandboxedBashTool(async () => okResult({ stdout: "out", stderr: "err" }));
    const result = await tool.execute("call-1", { command: "make" });
    expect((result.content[0] as { text: string }).text).toBe("out\nerr");
  });

  it("returns '(no output)' when the command produced nothing", async () => {
    const tool = createSandboxedBashTool(async () => okResult());
    const result = await tool.execute("call-1", { command: "true" });
    expect((result.content[0] as { text: string }).text).toBe("(no output)");
  });

  it("throws with the output and exit code on a non-zero exit", async () => {
    const tool = createSandboxedBashTool(async () => okResult({ exitCode: 1, stdout: "failing output" }));
    await expect(tool.execute("call-1", { command: "exit 1" })).rejects.toThrow(
      "failing output\n\nCommand exited with code 1",
    );
  });

  it("formats an abort as 'Command aborted'", async () => {
    const tool = createSandboxedBashTool(async () => {
      throw new Error("aborted");
    });
    await expect(tool.execute("call-1", { command: "sleep 10" })).rejects.toThrow("Command aborted");
  });

  it("formats a timeout as 'Command timed out after N seconds'", async () => {
    const tool = createSandboxedBashTool(async () => {
      throw new Error("timeout:30");
    });
    await expect(tool.execute("call-1", { command: "sleep 10", timeout: 30 })).rejects.toThrow(
      "Command timed out after 30 seconds",
    );
  });

  it("rethrows other executor errors", async () => {
    const tool = createSandboxedBashTool(async () => {
      throw new Error("spawn bwrap ENOENT");
    });
    await expect(tool.execute("call-1", { command: "ls" })).rejects.toThrow("spawn bwrap ENOENT");
  });

  it("forwards the timeout and abort signal to the executor", async () => {
    const executor = vi.fn(async () => okResult({ stdout: "done" })) as unknown as SandboxedBashExecutor;
    const tool = createSandboxedBashTool(executor);
    const controller = new AbortController();
    await tool.execute("call-1", { command: "git status", timeout: 7 }, controller.signal);
    expect(executor).toHaveBeenCalledWith({ command: "git status", timeout: 7, signal: controller.signal });
  });

  it("truncates long output to the last lines with a footer", async () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`);
    const tool = createSandboxedBashTool(async () => okResult({ stdout: lines.join("\n") }));
    const result = await tool.execute("call-1", { command: "yes" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("line 2500");
    expect(text).toContain("[Showing lines 501-2500 of 2500]");
    expect(text).not.toContain("line 1\n");
  });
});
