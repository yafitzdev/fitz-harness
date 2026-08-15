# Windows packaging and startup

Build the NSIS installer with `pnpm desktop:dist:win`. It builds and embeds the Fitz host, uses a
per-user assisted installer, creates Start menu and desktop shortcuts, packages the desktop in ASAR,
and publishes GitHub-compatible update metadata. Production releases still need a Windows
code-signing certificate configured in CI.

The installed application contains Electron, Node, the Fitz host, Pi, and npm. Mutable state belongs
under `%LOCALAPPDATA%\Fitz Codex`; engines and models remain under `%USERPROFILE%\llm`. Cloudflare is
not bundled. Hosting uses the owner PC's installed Tailscale daemon, while remote Fitz users need
neither Tailscale nor a tailnet account.

The packaged host includes `start-host.ps1`. The Hosting Advanced tab controls its current-user
Windows logon registration through the canonical `hosting.startAtLogin` setting. No separate Host
startup page or installer-time silent registration exists.

Build the portable x64 host zip with `pnpm host:pack:win`. Extract it and run `start-host.ps1`; it
optionally loads a colocated `.env.host`.
