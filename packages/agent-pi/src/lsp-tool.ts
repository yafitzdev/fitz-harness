import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLspResult, type LspService } from "@fitz/lsp";

export const LSP_TOOL_NAME = "lsp" as const;

/**
 * The single model-facing LSP tool. The model supplies only a semantic operation and a cursor;
 * provider selection, process launch, workspace containment, and protocol details remain host-owned.
 */
export function createLspTool(service: LspService, context: { cwd: string }): ToolDefinition {
  const parameters = Type.Object({
    operation: Type.Union([
      Type.Literal("goToDefinition"),
      Type.Literal("findReferences"),
      Type.Literal("goToImplementation"),
      Type.Literal("hover"),
    ], { description: "The read-only language-server query to run." }),
    file_path: Type.String({ description: "Source file path, relative to the current workspace or absolute." }),
    line: Type.Integer({ minimum: 1, description: "One-based source line at the cursor." }),
    character: Type.Integer({ minimum: 1, description: "One-based UTF-16 character at the cursor." }),
  });
  return {
    name: LSP_TOOL_NAME,
    label: "LSP",
    description: "Query a configured read-only language server for precise code navigation. Use goToDefinition, findReferences, goToImplementation, or hover. line and character are one-based UTF-16 cursor coordinates; findReferences includes the declaration.",
    promptSnippet: "Query a language server for definitions, references, implementations, or hover information",
    promptGuidelines: [
      "Use LSP when textual search is ambiguous or precise symbol navigation is needed.",
      "Use the current workspace-relative file path and a cursor position on the symbol.",
      "LSP is strictly read-only; it cannot edit files, apply edits, or execute commands.",
    ],
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await service.query({
        operation: params.operation,
        filePath: params.file_path,
        position: { line: params.line - 1, character: params.character - 1 },
        workspaceRoot: context.cwd,
      }, signal);
      return lspToolResult(formatLspResult(result, context.cwd), { operation: params.operation, filePath: params.file_path, result });
    },
  } satisfies ToolDefinition<typeof parameters>;
}

function lspToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}
