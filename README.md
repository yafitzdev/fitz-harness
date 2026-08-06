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

The development host binds to `127.0.0.1`. `pnpm dev` (also available as `pnpm dev:ninfer`) starts
the real NiNfer configuration and exposes the configured recipes through the Fast, Default, and
Smart connection routes. On Windows, Fitz launches and stops the engine inside the configured Ubuntu
WSL distribution while the desktop continues to connect to `127.0.0.1:8787`.

Development keeps all mutable state in the repository under `data/` (`FITZ_DATA_ROOT`): sessions in
`data/database/fitz.db`, Pi packages in `data/pi/`, logs in `data/logs/`, cache in `data/cache/`.
If you have an existing `data/fitz-ninfer.db`, run `pnpm migrate:dev-data` once to move it into the
unified store (it verifies the copy and keeps the original as `.pre-unify`). The dev scripts build
workspace packages before starting and refuse to start if another host already occupies the port;
set `FITZ_PORT` to override the default `8787`.

Production installs bundle Electron, the host, Node, Pi, and npm. Mutable database, Pi package, log,
and cache state lives beneath `%LOCALAPPDATA%\Fitz Codex`; clean engine repositories and model files
live beneath `%USERPROFILE%\llm`. Tailscale remains an independently installed Windows service.

Use `pnpm dev:fake` only when deterministic fake inference is explicitly needed for UI development.
