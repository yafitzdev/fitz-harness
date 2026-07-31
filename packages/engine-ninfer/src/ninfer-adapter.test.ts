import { describe, expect, it } from "vitest";
import { NInferEngineAdapter, buildCurrentNInferRecipe } from "./ninfer-adapter.js";
import { validateNInferConfiguration } from "./config.js";

describe("NInferEngineAdapter launch contract", () => {
  it("renders the current 27B MTP3 recipe as executable plus argv", async () => {
    const recipe = buildCurrentNInferRecipe(
      "qwen-27b",
      "qwen3.6-27b",
      "/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer",
      3,
    );
    const adapter = new NInferEngineAdapter({ validatePaths: false });

    expect(await adapter.validateRecipe(recipe)).toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 19_001 });

    expect(spec.executable).toBe("/opt/ninfer/build/apps/ninfer-serve");
    expect(spec.args).toContain("/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer");
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--host",
        "127.0.0.1",
        "--port",
        "19001",
        "--max-context",
        "100000",
        "--spec",
        "mtp",
        "--draft-tokens",
        "3",
        "--lm-head-draft",
        "--no-thinking",
      ]),
    );
    expect(spec.args).not.toContain("--api-key");
  });

  it("rejects extra arguments that override Fitz-owned process controls", () => {
    const recipe = buildCurrentNInferRecipe("bad", "bad", "/model.ninfer", 4);
    recipe.configuration = { ...recipe.configuration, extraArgs: ["--api-key=leak"] };
    expect(validateNInferConfiguration(recipe)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reserved_argument" })]),
    );
  });
});
