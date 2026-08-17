import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LspError, LspRegistry, StdioLspProvider } from "./index.js";

describe("LSP registry", () => {
  it("selects a configured stdio provider and normalizes navigation and hover", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fitz-lsp-"));
    const source = join(workspace, "src.ts");
    await writeFile(source, "const answer = 42;\nanswer;\n", "utf8");
    const sourceUri = pathToFileURL(source).href;
    const script = fixtureServer(sourceUri);
    const provider = new StdioLspProvider({
      id: "typescript-fixture",
      command: process.execPath,
      args: ["-e", script],
      extensionToLanguage: { ".ts": "typescript" },
      requestTimeoutMs: 5_000,
    });
    const registry = new LspRegistry();
    registry.registerProvider(provider);
    try {
      await expect(registry.query({ operation: "goToDefinition", filePath: "src.ts", position: { line: 1, character: 0 }, workspaceRoot: workspace })).resolves.toMatchObject({
        kind: "locations",
        locations: [{ uri: sourceUri, range: { start: { line: 0, character: 6 } } }],
      });
      await expect(registry.query({ operation: "findReferences", filePath: "src.ts", position: { line: 1, character: 0 }, workspaceRoot: workspace })).resolves.toMatchObject({ kind: "locations", locations: [{ uri: sourceUri }] });
      await expect(registry.query({ operation: "hover", filePath: "src.ts", position: { line: 0, character: 6 }, workspaceRoot: workspace })).resolves.toMatchObject({ kind: "hover", hover: { contents: "number" } });
    } finally {
      await registry.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects files that escape the configured workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fitz-lsp-"));
    const outside = await mkdtemp(join(tmpdir(), "fitz-lsp-outside-"));
    await writeFile(join(outside, "outside.ts"), "export const outside = true;", "utf8");
    const registry = new LspRegistry();
    registry.registerProvider(new StdioLspProvider({
      id: "stub",
      command: process.execPath,
      args: ["-e", fixtureServer(pathToFileURL(join(outside, "outside.ts")).href)],
      extensionToLanguage: { ".ts": "typescript" },
    }));
    try {
      await expect(registry.query({ operation: "hover", filePath: join(outside, "outside.ts"), position: { line: 0, character: 0 }, workspaceRoot: workspace })).rejects.toMatchObject({ code: "LSP_SOURCE_INVALID" });
    } finally {
      await registry.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects extension conflicts atomically", () => {
    const registry = new LspRegistry();
    const provider = { id: "one", extensionToLanguage: { ".ts": "typescript" }, query: async () => ({ kind: "locations" as const, locations: [], resolvedWorkspaceUri: "file:///workspace" }) };
    registry.registerProvider(provider);
    expect(() => registry.registerProvider({ ...provider, id: "two" })).toThrow(LspError);
  });
});

function fixtureServer(sourceUri: string): string {
  return [
    "let buffer = Buffer.alloc(0);",
    "const uri = " + JSON.stringify(sourceUri) + ";",
    "function send(value) { const body = Buffer.from(JSON.stringify(value)); process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body])); }",
    "function handle(message) {",
    "  if (message.method === 'initialize') return send({jsonrpc:'2.0',id:message.id,result:{capabilities:{definitionProvider:true,referencesProvider:true,implementationProvider:true,hoverProvider:true,textDocumentSync:{openClose:true},positionEncoding:'utf-16'}}});",
    "  if (message.method === 'shutdown') return send({jsonrpc:'2.0',id:message.id,result:null});",
    "  if (message.method === 'textDocument/definition') return send({jsonrpc:'2.0',id:message.id,result:[{targetUri:uri,targetRange:{start:{line:0,character:6},end:{line:0,character:12}},targetSelectionRange:{start:{line:0,character:6},end:{line:0,character:12}}}]});",
    "  if (message.method === 'textDocument/references') return send({jsonrpc:'2.0',id:message.id,result:[{uri,range:{start:{line:0,character:6},end:{line:0,character:12}}}]});",
    "  if (message.method === 'textDocument/implementation') return send({jsonrpc:'2.0',id:message.id,result:[]});",
    "  if (message.method === 'textDocument/hover') return send({jsonrpc:'2.0',id:message.id,result:{contents:{kind:'markdown',value:'number'},range:{start:{line:0,character:6},end:{line:0,character:12}}}});",
    "}",
    "process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); while (true) { const end = buffer.indexOf(Buffer.from('\\r\\n\\r\\n')); if (end < 0) break; const header = buffer.slice(0,end).toString(); const match = /Content-Length: (\\d+)/i.exec(header); if (!match) process.exit(2); const length = Number(match[1]); if (buffer.length < end + 4 + length) break; const body = buffer.slice(end+4,end+4+length).toString(); buffer = buffer.slice(end+4+length); handle(JSON.parse(body)); } });",
  ].join("\n");
}
