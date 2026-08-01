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

The development host binds to `127.0.0.1`. `pnpm dev` (also available as `pnpm dev:ninfer`) starts the real NiNfer configuration with `data/fitz-ninfer.db` and exposes one `ninfer` playbook with two validated recipes: 35B A3B (`default-agent`) and 27B (`fast`). On Windows, Fitz launches and stops the engine inside the configured Ubuntu WSL distribution while the desktop continues to connect to `127.0.0.1:8787`.

Use `pnpm dev:fake` only when deterministic fake inference is explicitly needed for UI development.
