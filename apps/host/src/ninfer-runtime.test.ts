import { describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { createNInferModelRegistration, NInferRuntimeManager } from "./ninfer-runtime.js";

describe("managed NInfer runtime", () => {
  it("uses the shared managed Linux distribution beside application data", async () => {
    const run = vi.fn(async () => ({ stdout: "Ubuntu\r\n", stderr: "" }));
    const paths = resolveRuntimePaths({ FITZ_LLM_ROOT: "D:\\registry", FITZ_RUNTIME_ROOT: "D:\\fitz-runtimes" });
    const runtime = new NInferRuntimeManager({ paths, platform: "win32", run });

    expect(runtime.layout).toMatchObject({
      id: "inference-linux",
      distribution: "Fitz-Inference",
      hostRoot: "D:\\fitz-runtimes\\inference-linux",
      environmentRoot: "/opt/fitz/llm/environments",
      modelRoot: "/opt/fitz/llm/models/ninfer",
      executable: "/opt/fitz/llm/environments/ninfer/bin/ninfer-serve",
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
      if (args.includes("--list")) return { stdout: "Ubuntu\0\r\0\n\0Fitz-Inference\0\r\0\n\0", stderr: "" };
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

  it("describes runtime-resident model payloads without duplicating them on Windows", () => {
    const paths = resolveRuntimePaths({ FITZ_LLM_ROOT: "D:\\registry" });
    const runtime = new NInferRuntimeManager({ paths, platform: "win32", run: vi.fn() });
    expect(createNInferModelRegistration({
      id: "qwen3.6-27b",
      fileName: "qwen3_6_27b_nvfp4.ninfer",
      bytes: 18_324_064_000,
      sha256: "abc123",
    }, runtime.layout)).toEqual({
      schemaVersion: 1,
      id: "qwen3.6-27b",
      engine: "ninfer",
      format: "ninfer",
      payload: {
        backend: "runtime-filesystem",
        runtimeId: "inference-linux",
        path: "/opt/fitz/llm/models/ninfer/qwen3_6_27b_nvfp4.ninfer",
      },
      bytes: 18_324_064_000,
      sha256: "abc123",
    });
  });
});
