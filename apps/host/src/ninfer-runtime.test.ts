import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { createNInferModelRegistration, NInferRuntimeManager } from "./ninfer-runtime.js";

describe("managed NInfer runtime", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("uses the shared managed Linux distribution beside application data", async () => {
    const run = vi.fn(async () => ({ stdout: "\r\n", stderr: "" }));
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
      if (args.includes("--list")) return { stdout: "Fitz-Inference\0\r\0\n\0", stderr: "" };
      if (args.includes("test")) return { stdout: "", stderr: "" };
      if (args.some((value) => value.endsWith("qwen3_8_27b_nvfp4.ninfer"))) return { stdout: "21492695040\n", stderr: "" };
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
      id: "qwen3.8-27b-nvfp4",
      fileName: "qwen3_8_27b_nvfp4.ninfer",
      bytes: 21_492_695_040,
      sha256: "abc123",
    }, runtime.layout)).toEqual({
      schemaVersion: 1,
      id: "qwen3.8-27b-nvfp4",
      engine: "ninfer",
      format: "ninfer",
      payload: {
        backend: "runtime-filesystem",
        runtimeId: "inference-linux",
        path: "/opt/fitz/llm/models/ninfer/qwen3_8_27b_nvfp4.ninfer",
      },
      bytes: 21_492_695_040,
      sha256: "abc123",
    });
  });

  it("provisions CUDA and every NInfer dependency inside Fitz-Inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-ninfer-runtime-"));
    temporaryDirectories.push(root);
    const paths = resolveRuntimePaths({
      FITZ_DATA_ROOT: join(root, "data"),
      FITZ_LLM_ROOT: join(root, "registry"),
      FITZ_RUNTIME_ROOT: join(root, "runtimes"),
    });
    await mkdir(paths.llmRoot, { recursive: true });
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes("--list")) return { stdout: "Fitz-Inference\0\r\0\n\0", stderr: "" };
      if (args.includes("stat")) {
        const path = args.at(-1) ?? "";
        if (path.endsWith("qwen3_8_27b_nvfp4.ninfer")) return { stdout: "21492695040\n", stderr: "" };
        throw new Error("missing");
      }
      if (args.includes("sh") && args.at(-1)?.includes("sha256sum")) return { stdout: "abc123\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const runtime = new NInferRuntimeManager({ paths, platform: "win32", run });

    runtime.startProvisioning();
    await runtime.waitForIdle();

    const calls = run.mock.calls.map(([, args]) => args as string[]);
    expect(calls.every((args) => !args.includes("Ubuntu"))).toBe(true);
    expect(calls.filter((args) => args.includes("-d")).every((args) => args.includes("Fitz-Inference"))).toBe(true);
    expect(calls.some((args) => args.at(-1)?.includes("cuda-keyring_1.1-1_all.deb"))).toBe(true);
    expect(calls.some((args) => args.at(-1)?.includes("cuda-cudart-13-1"))).toBe(true);
    await expect(runtime.status()).resolves.toMatchObject({ state: "ready" });
  });
});
