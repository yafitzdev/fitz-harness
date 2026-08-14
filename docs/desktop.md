# Desktop shell

The initial desktop application uses Electron 43.2.0. Build it with
`pnpm --filter @fitz/desktop build` and launch it with `pnpm --filter @fitz/desktop start` while the
host is running. It connects to `http://127.0.0.1:8787` by default. First-run onboarding lets the
user host on this PC or persist a remote HTTPS origin; override it with `FITZ_HOST_URL` or
`--host-url=<origin>`. In required-auth mode, provide the device credential to the main process as
`FITZ_DEVICE_TOKEN`.

The renderer has no Node integration and no direct network permission. A sandboxed, bundled
CommonJS preload exposes two narrow operations: host API requests limited to Fitz public API paths,
and HTTP(S)-only external-link opening. Authentication is attached in the main process and is not
exposed to renderer JavaScript. The window blocks arbitrary navigation and new windows, and the
static document has a restrictive content security policy.

The renderer uses a task-focused desktop layout with a project/thread hierarchy, centered
conversation, floating composer, and toggleable environment/artifact panel. Project and task
creation use accessible dialogs; connection retry, file attachment, keyboard submission,
native-run cancellation, loading/error states, and responsive sidebar controls are wired as
first-class interactions.

Remote credentials are keyed by host origin and protected with Electron `safeStorage`. Remote hosts
must use HTTPS. Pairing occurs in the main process and the one-time returned bearer token is removed
from the response before anything reaches the renderer.
