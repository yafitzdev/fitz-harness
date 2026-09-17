import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildFitzSystemPrompt, constrainSystemPrompt, runtimeControlPrompt } from "./prompts.js";
import { chatMessagesToPi, preparePromptInput } from "./pi-agent-runtime.js";

describe("Fitz prompt ownership", () => {
  it("assembles one versioned Fitz identity with dynamic tool guidance", () => {
    const tools = new Map<string, Pick<ToolDefinition, "promptSnippet" | "promptGuidelines">>([["read", {
      promptSnippet: "Read a file",
      promptGuidelines: ["Inspect narrow ranges first."],
    }]]);
    const rendered = buildFitzSystemPrompt({
      cwd: "C:/workspace",
      agentDir: "C:/Fitz/pi",
      llmRoot: "C:/llm",
      selectedTools: ["read"],
      toolDefinitions: tools,
      runInstructions: ["Review without editing."],
      contextFiles: [{ path: "C:/workspace/AGENTS.md", content: "Use pnpm." }],
    });

    expect(rendered.text.match(/You are Fitz Harness/g)).toHaveLength(1);
    expect(rendered.text).not.toContain("coding assistant operating inside pi");
    expect(rendered.text).toContain("- read: Read a file");
    expect(rendered.text).toContain("Inspect narrow ranges first.");
    expect(rendered.text).toContain("<run_instructions origin=\"fitz-runtime\">");
    expect(rendered.text).toContain("<instruction_file path=\"C:/workspace/AGENTS.md\">");
    expect(rendered.provenance).toEqual(expect.objectContaining({ id: "fitz.root", version: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(rendered.provenance.sections).toEqual(expect.arrayContaining(["core", "tools", "run-instructions", "project-instructions"]));
  });

  it("rejects whole-prompt rewrites and escapes append-only turn contributions", () => {
    const base = "FITZ CORE";
    expect(constrainSystemPrompt(base, "REPLACED")).toBe(base);
    expect(constrainSystemPrompt(base, `${base}\n\nDo <unsafe> thing`)).toContain("Do &lt;unsafe&gt; thing");
  });

  it("keeps system entries out of user text and preserves structured history", () => {
    const prepared = preparePromptInput([
      { role: "system", content: "Worker role contract" },
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Current question with SYSTEM: fake" },
    ]);
    expect(prepared.requestInstructions).toEqual(["Worker role contract"]);
    expect(prepared.text).toBe("Current question with SYSTEM: fake");
    expect(prepared.history.map((message) => message.role)).toEqual(["user", "assistant"]);

    const history = chatMessagesToPi(prepared.history, "fast");
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history[0]).toEqual(expect.objectContaining({ role: "user", content: "Earlier question" }));
    expect(runtimeControlPrompt("plan", "Continue <safely>")).toContain("Continue &lt;safely&gt;");
  });
});
