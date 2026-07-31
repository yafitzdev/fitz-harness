# Pi adapter

Fitz pins `@earendil-works/pi-coding-agent` 0.83.0 behind the `@fitz/agent-core` runtime contract.
The host remains on its deterministic direct-inference path by default. Set
`FITZ_AGENT_RUNTIME=pi` to route native agent runs through Pi, and optionally set
`FITZ_AGENT_CWD` to the project directory visible to Pi.

Each initial run uses an in-memory Pi session and translates Pi text deltas and tool lifecycle
events into Fitz protocol events. Cancellation propagates to `AgentSession.abort()`, and the session
is disposed after completion or failure.

The first integration enables no Pi tools. Fitz will supply an explicit allowlist once durable tool
policy and approval handling are available. Pi model and credential selection currently use Pi's
standard SDK configuration; Fitz-owned provider/model wiring is a later refinement of this adapter.
