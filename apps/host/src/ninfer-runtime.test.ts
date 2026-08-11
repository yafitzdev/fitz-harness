import { describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { NInferRuntimeManager } from "./ninfer-runtime.js";

describe("managed NInfer runtime", () => {
  it("keeps the dedicated WSL distribution inside the .llm registry", async () => {
    const run = vi.fn(async () => ({ stdout: "Ubuntu\r\n", stderr: "" }));
    const paths = resolveRuntimePaths({ FITZ_LLM_ROOT: "D:\\registry" });
    const runtime = new NInferRuntimeManager({ paths, platform: "win32", run });

    expect(runtime.layout).toMatchObject({
      id: "ninfer-linux",
      distribution: "Fitz-NInfer",
      hostRoot: "D:\\registry\\runtimes\\ninfer-linux",
      modelRoot: "/opt/fitz/llm/models/ninfer",
      executable: "/opt/fitz/llm/engines/ninfer/ninfer-serve",
    });
    await expect(runtime.status()).resolves.toMatchObject({
      available: true,
      state: "not-installed",
      stage: "not-installed",
    });
    expect(run).toHaveBeenCalledWith("wsl.exe", ["--list", "--quiet"], { timeout: 15_000 });
  });

  it("recognizes an installed engine and model as ready", async () => {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("--list")) return { stdout: "Ubuntu\0\r\0\n\0Fitz-NInfer\0\r\0\n\0", stderr: "" };
      if (args.includes("test")) return { stdout: "", stderr: "" };
      if (args.some((value) => value.endsWith("qwen3_6_27b_nvfp4.ninfer"))) return { stdout: "18324064000\n", stderr: "" };
      throw new Error("missing");
    });
    const paths = resolveRuntimePaths({ FITZ_LLM_ROOT: "D:\\registry" });
    const runtime = new NInferRuntimeManager({ paths, platform: "win32", run });
    await expect(runtime.status()).resolves.toMatchObject({ state: "ready", stage: "ready", progress: 100 });
  });

  it("does not pretend the runtime is available on native non-Windows hosts", async () => {
    const paths = resolveRuntimePaths({ FITZ_LLM_ROOT: "/tmp/registry" });
    const runtime = new NInferRuntimeManager({ paths, platform: "linux" });
    await expect(runtime.status()).resolves.toMatchObject({ available: false, state: "unavailable" });
    expect(() => runtime.startProvisioning()).toThrow(/requires Windows/);
  });
});
