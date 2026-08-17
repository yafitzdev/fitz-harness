# Read-only language-server support

Fitz exposes one engine-neutral `lsp` tool for precise code navigation. The model can request only
these semantic operations:

- `goToDefinition`
- `findReferences` (always includes the declaration)
- `goToImplementation`
- `hover`

The host selects a provider from the source-file extension. The model cannot choose a command,
start an arbitrary process, send raw JSON-RPC, apply edits, or execute server commands.

## Configuration

Language servers are administrator configuration, not chat input. Add a provider to the `lsp`
section of `fitz.config.json`:

```json
{
  "lsp": {
    "providers": [
      {
        "id": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensionToLanguage": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact"
        }
      }
    ]
  }
}
```

Fitz launches the configured executable without a shell, with the project workspace as its working
directory. The executable must already be installed and available on the host `PATH` (or the
`command` field may be an absolute path). There are no built-in language-server downloads.

The source file is resolved through the real filesystem, must remain inside the active workspace,
and is bounded to 5 MiB by default. LSP positions use zero-based UTF-16 internally; the model-facing
tool accepts one-based line and character values. Each workspace keeps one serialized language-server
process per provider, and Fitz tears those processes down with the host.

The protocol surface is intentionally read-only. Fitz answers only the lifecycle/configuration
requests needed by common servers and rejects `workspace/applyEdit`, dynamic commands, and unknown
server-to-client requests. A language server is still a trusted local executable; this capability
does not claim to sandbox a third-party process.
