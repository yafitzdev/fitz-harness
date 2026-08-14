# Windows packaging and startup

Build the complete NSIS installer with `pnpm desktop:dist:win`. It builds the host deployment,
downloads the pinned Windows x64 `cloudflared` release, verifies its SHA-256 checksum, includes its
license, and embeds both in Electron. The app uses a per-user assisted installer, Start menu and
desktop shortcuts, ASAR packaging, and the GitHub release provider for update metadata. Packaged
apps check for updates on startup, download an available update, and offer an explicit restart.
Production releases still need a Windows code-signing certificate configured in CI.

The packaged executable supports a smoke mode that loads its packaged main entry, writes a sentinel,
and exits without opening a window. The Windows packaging workflow runs the
monorepo checks and host smoke test, builds an unpacked app, exercises that mode, builds the NSIS
installer, and uploads the installer/update metadata.

The installed application contains Electron, Node, the Fitz host, Pi, and npm. When a loopback host
is not already healthy, the packaged desktop starts its bundled host invisibly. Mutable state is not
written into the installation directory: it belongs under `%LOCALAPPDATA%\Fitz Codex`. Engines and
models remain under `%USERPROFILE%\llm`. Tailscale remains an optional external Windows service;
Share Fitz recipients do not need it.

Build the portable x64 host zip, including Node, Pi, npm, and production dependencies, with
`pnpm host:pack:win`. Extract it and run `start-host.ps1`; it optionally loads a colocated
`.env.host`.

For a development checkout, after `pnpm build`, install a current-user logon task:

```powershell
./scripts/windows/install-host-startup.ps1
```

The task runs the compiled host through `run-host.ps1`, optionally loading `.env.host` without
placing secrets in task arguments. Remove it with `uninstall-host-startup.ps1`. These scripts only
change Task Scheduler when explicitly invoked; the installer does not silently register the host.
