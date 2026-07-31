# Fitz Codex

Fitz Codex is a local-first agent application and inference control plane. The repository is in its infrastructure phase; see [DESIGN.md](./DESIGN.md) for the product and architecture specification.

Current work is tracked in [TODO.html](./TODO.html).

## Development

Prerequisites:

- Node.js 22.23.2 (or another compatible Node.js version >=22.19)
- pnpm 11.9.0

```bash
pnpm install
pnpm check
pnpm dev
```

The development host binds to `127.0.0.1` and uses a deterministic fake inference engine. It does not modify or launch the machine's existing NInfer services.
