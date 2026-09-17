import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResultSpillStore } from "./tool-result-spill-store.js";

describe("ToolResultSpillStore", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("writes complete redacted content inside the session workspace", async () => {
    root = await mkdtemp(join(tmpdir(), "fitz-spill-"));
    const store = new ToolResultSpillStore(() => root);
    const result = await store.write({ sessionId: "session", runId: "run/1", toolCallId: "call:1", toolName: "bash", content: [{ type: "text", text: "complete output" }] });
    expect(result.path).toContain(join(".fitz", "tool-results", "run-1", "bash-call-1.txt"));
    expect(await readFile(result.path, "utf8")).toBe("complete output");
  });
});
