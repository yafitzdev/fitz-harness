import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureComfyUISafeModeExtension } from "./comfyui-safe-mode.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("ComfyUI Safe mode extension", () => {
  it("installs idempotently beneath Fitz application data", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-comfy-safe-"));
    roots.push(root);
    const first = ensureComfyUISafeModeExtension(root);
    const source = readFileSync(first, "utf8");
    const second = ensureComfyUISafeModeExtension(root);
    expect(second).toBe(first);
    expect(existsSync(join(root, "custom_nodes", "fitz_safe_sampler", "__init__.py"))).toBe(true);
    expect(source).toContain("FitzSafeSamplerCustomAdvanced");
    expect(source).toContain("torch.cuda.synchronize()");
    expect(source).toContain("--query-gpu=temperature.gpu");
    expect(source).toContain('"default": 0.50');
    expect(source).toContain("temperature >= 75");
    expect(source).toContain("temperature >= 72");
    // The duty rest must be honored for heavy steps and the cooldown must bring
    // the GPU back below its resume threshold before the next step starts hot.
    expect(source).toContain("min(300.0");
    expect(source).toContain("temperature > 65");
    expect(source).toContain("deadline = time.monotonic() + 600.0");
    expect(readFileSync(second, "utf8")).toBe(source);
  });
});
