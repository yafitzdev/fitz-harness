# Windows packaging, startup, and updates

Build the NSIS installer with `pnpm desktop:dist:win`. It force-builds and smoke-tests the Fitz host,
embeds its hoisted production deployment in one ASAR archive, creates a per-user assisted installer
with Start menu and desktop shortcuts, and produces the installer metadata required by
`electron-updater`. The final packaged-desktop smoke starts the embedded host through the real
supervisor. Production releases still need a Windows code-signing certificate configured in CI.

## Publishing an update

The desktop updater reads the latest published GitHub Release for `yafitzdev/fitz-codex`; it does
not read the repository branch or source files. A release consists of the NSIS installer,
`latest.yml`, and its blockmap, all published by the tagged Windows workflow.

Push a semantic-version tag after the change is ready:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow takes the version from that tag, packages the host into the desktop installer, and
publishes a non-draft GitHub Release. A previously installed Fitz instance checks GitHub at startup
and also exposes **Check now** in Administration. It downloads updates in the background and shows
**Restart and install** when the package is ready.

The updater replaces application files only. Chats, settings, extensions, logs, artifacts, engines,
and models remain in the per-user data/model directories outside the install location.

Until a Windows signing certificate is configured, the update mechanism works but Windows may show
SmartScreen warnings for the installer. Signing should be added before broad distribution.

The installed application uses Electron's Node runtime for both the desktop and embedded host. The
host, Pi, npm, and their production dependencies live in `resources\host.asar`, keeping installation
to a small number of large files instead of tens of thousands of package-manager files. Mutable state
is stored outside the installation; engines and models remain under `%USERPROFILE%\llm`. Cloudflare
is not bundled. Hosting uses the owner PC's installed Tailscale daemon, while remote Fitz users need
neither Tailscale nor a tailnet account.

Host startup never blocks the application window and never displays a fatal startup dialog. When a
local or remote host is unavailable, the renderer opens in its offline/connection state. A local host
continues starting in the background, automatically reconnects the renderer when ready, and can be
retried from the connection status. Startup output is retained in `host-startup.log` under Electron's
per-user application data directory.

The packaged host includes `start-host.ps1`. The Hosting Advanced tab controls its current-user
Windows logon registration through the canonical `hosting.startAtLogin` setting. No separate Host
startup page or installer-time silent registration exists.

Build the portable x64 host zip with `pnpm host:pack:win`. Unlike the desktop archive, the portable
zip includes its own `runtime\node.exe`. Extract it and run `start-host.ps1`; it optionally loads a
colocated `.env.host`.
