# Desktop shell

The Electron desktop builds with `pnpm --filter @fitz/desktop build`. Every installation owns the
same bundled loopback service at `http://127.0.0.1:8787`, opens directly into a fresh Local / Normal
chat, and exposes the complete Inference, Plugins, Models, and Hosting interface. There is no desktop
host/consumer mode and no startup network-selection or pairing screen.

The renderer has no Node integration and no direct network permission. A sandboxed CommonJS preload
exposes bounded local-service requests and desktop operations. Remote Fitz instances and cloud APIs
are added from Inference as ordinary OpenAI-compatible connections. Their credentials are stored
with Electron `safeStorage` and are never returned to the renderer. A failed remote connection can
affect only that inference route; it cannot prevent the desktop from opening.

The renderer uses a task-focused layout with a project/chat hierarchy, centered conversation,
floating composer, inspector, and browser-style history. Every desktop user gets the Hosting page
with Overview, Users, Usage, and Advanced tabs and can both host APIs and consume connected APIs.
