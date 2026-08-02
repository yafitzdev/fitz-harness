# Pi adapter

Fitz pins `@earendil-works/pi-coding-agent` 0.83.0 behind the `@fitz/agent-core` runtime contract.
Desktop agent runs use Pi by default. Set `FITZ_AGENT_RUNTIME=direct` only when a raw completion
path is needed for diagnostics. Pi receives the selected Fitz route as an OpenAI-compatible model,
so model lifecycle and routing remain owned by Fitz while Pi owns the coding-agent loop.

Each run uses an in-memory Pi session rooted at the selected project's folder and enables Pi's
read, bash, edit, write, grep, find, and ls tools. Tool definitions and streamed tool calls pass
through the Fitz OpenAI gateway to the selected engine. Pi tool lifecycle events return through the
native run protocol. Cancellation propagates to `AgentSession.abort()`, and the session is disposed
after completion or failure.

Pi configuration and user-installed packages persist beneath `%LOCALAPPDATA%\Fitz Codex\pi` on
Windows. The Plugins workspace searches the public npm `pi-package` catalog and lets administrators
install, update, enable, disable, or remove extensions and skills. Extension tools join the normal
tool allowlist and remain subject to Fitz Full access, Ask first, and Read only enforcement.

`FITZ_AGENT_CWD` can force a fixed working folder, and `FITZ_AGENT_BASE_URL` can override the local
gateway URL. Normal desktop use needs neither override.
