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
    expect(source).toContain('"default": 0.40');
    // Pacing policy: diffusion runs in bounded bursts (8 s of GPU time) with
    // an idle after each burst — the base rest plus any overshoot beyond the
    // budget, so a step that overruns its burst repays the extra heat with
    // extra idle. The idle is capped at 8 s (past that the die has shed what
    // it will quickly). An emergency floor rests a genuinely hot die
    // (>= 85 C) at least 10 s, then lets it continue: the host's hard stop
    // moved to 92 C (firmware throttle territory), so the safeguard acts
    // first and the job survives to idle instead of dying mid-step.
    expect(source).toContain("_BURST_BUDGET_SECONDS = 8.0");
    expect(source).toContain("_BASE_IDLE_SECONDS = 3.0");
    expect(source).toContain("_MAX_REST_SECONDS = 8.0");
    expect(source).toContain("_SAFEGUARD_TEMP_C = 85");
    expect(source).toContain("_SAFEGUARD_REST_SECONDS = 10.0");
    expect(source).toContain("temperature >= _SAFEGUARD_TEMP_C");
    expect(source).toContain("min(_BASE_IDLE_SECONDS + (burst_work - _BURST_BUDGET_SECONDS), _MAX_REST_SECONDS)");
    // The core-loop patch: every sampler, not just the swapped FitzSafe nodes,
    // is paced while the extension is installed. There is no Safe mode toggle
    // anymore: pacing is engine-side and always on.
    expect(source).toContain("_install_global_pacing");
    expect(source).toContain("comfy.samplers.KSAMPLER.sample");
    expect(source).toContain("global pacing installed");
    // Per-step pacing diagnostics: each callback records what it measured
    // (work, temperature, duty, rest) and how long the rest actually slept,
    // so a "GPU stayed at 100%" report can be checked against ground truth
    // instead of GPU-utilimeter sampling.
    expect(source).toContain("fitz_pacing.log");
    expect(source).toContain("_log_pacing(");
    expect(source).toContain("callback init duty=");
    expect(source).toContain("work=%.3f");
    expect(source).toContain("slept=%.3f");
    expect(readFileSync(second, "utf8")).toBe(source);
  });
});
