import { describe, expect, it, vi } from "vitest";
import { createLspTool } from "./lsp-tool.js";

describe("createLspTool", () => {
  it("converts the model's one-based cursor and returns bounded human-readable results", async () => {
    const query = vi.fn(async (request: unknown) => ({
      kind: "locations" as const,
      locations: [{ uri: "file:///workspace/src/index.ts", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } }],
      resolvedWorkspaceUri: "file:///workspace",
    }));
    const tool = createLspTool({ query, registerProvider: vi.fn(), dispose: vi.fn() }, { cwd: "C:/workspace" });
    const result = await tool.execute("call-1", { operation: "goToDefinition", file_path: "src/index.ts", line: 4, character: 8 }, new AbortController().signal);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ position: { line: 3, character: 7 }, workspaceRoot: "C:/workspace" }), expect.any(AbortSignal));
    expect(result.content[0]).toEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("src/index.ts:3:5") }));
  });
});
