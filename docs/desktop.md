# Desktop shell

The Electron desktop builds with `pnpm --filter @fitz/desktop build` and connects to the bundled
loopback host at `http://127.0.0.1:8787` by default. Every launch opens a fresh Local / Normal new
chat. If the user chooses a remote host, the Connect page contains exactly two fields: public HTTPS
URL and API key. `FITZ_HOST_URL` or `--host-url=<origin>` remains available for deployment.

The renderer has no Node integration and no direct network permission. A sandboxed CommonJS preload
exposes bounded host requests and desktop operations. Remote origins must be clean HTTPS origins.
The main process verifies a supplied API key against `/api/v1/me` without following redirects, then
stores it per origin with Electron `safeStorage`. Durable credentials are never returned to the
renderer. A failed remote connection never starts a local host as a fallback.

The renderer uses a task-focused layout with a project/chat hierarchy, centered conversation,
floating composer, inspector, and browser-style history. Host administrators get one Hosting page
with Overview, Users, Usage, and Advanced tabs. Recipients do not see host administration.
