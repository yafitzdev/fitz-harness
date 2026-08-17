# Pi agent

Fitz pins `@earendil-works/pi-coding-agent` 0.83.0 behind the `@fitz/agent-core` runtime contract.
Desktop agent runs use Pi by default. Set `FITZ_AGENT_RUNTIME=direct` only when a raw completion
path is needed for diagnostics. Pi receives the selected Fitz route as an OpenAI-compatible model,
so model lifecycle and routing remain owned by Fitz while Pi owns the coding-agent loop.

## One place: `packages/agent-pi`

All Fitz-owned Pi code lives in `packages/agent-pi`. Its main components are:

- `PiAgentRuntime` (`pi-agent-runtime.ts`) — the `@fitz/agent-core` runtime adapter. It builds the
  SDK session (restricted tool allowlist, Fitz system instructions, extension loading, tool approval
  gating, the `fitz_session` lookup tool), translates Pi events into the Fitz run protocol, forwards
  steering messages, and propagates cancellation and failures.
- `PiDelegationPolicy` (`pi-delegation-policy.ts`) — internal per-run delegation state for required
  local/Fast-worker fan-out, Smart concurrent-peer admission, delegated tool budgets, retry
  enforcement, and pre-fan-out output suppression. The runtime's approval paths share this one
  policy instance.
- `PiPackageService` (`pi-packages.ts`) — the registry-backed extension manager. Fitz owns the
  extension layout: `{agentDir}/extensions/registry.json` plus one directory per enabled package.
  Upstream Pi's `npm/` + `settings.json` layout and auto-discovery are disabled (`noExtensions`), so
  the registry is the single source of truth for what a session loads.
- `PI_SDK_VERSION` — the pinned SDK version, for diagnostics.

`apps/host` is only a thin wiring layer: it constructs `PiAgentRuntime` with the resolved runtime
paths, the store-backed tool approval gate, and the store-backed session reader. `apps/host` has no
Pi logic of its own.

Worker capacity comes from the runtime allocation policy and the loaded engine's reported capacity.
It is never persisted in a recipe. Workers are not named or assigned persistent roles. For each
`subagent` call, the main agent selects a role identifier;
the host resolves it from the global versioned SQLite role registry and creates the child with that
definition's system instructions, access mode, tool-call budget, output limit, and output contract.
The exact role definition is snapshotted in the durable child request. Pi enforces that snapshot's
tool budget, and delegated children are not given the delegation tool.

## Sessions and the store

Pi sessions themselves are in-memory by design (`SessionManager.inMemory`): the canonical record of
every conversation is the host SQLite store (`transcript_entries`), not Pi's on-disk session store.
`Fitz` therefore is the single source of truth for conversation history.

Each run uses an in-memory Pi session rooted at the selected project's folder and enables Pi's read,
bash, edit, write, grep, find, and ls tools (plus registry extension tools). Tool definitions and
streamed tool calls pass through the Fitz OpenAI gateway to the selected engine. Pi tool lifecycle
events return through the native run protocol. Cancellation propagates to `AgentSession.abort()`,
and the session is disposed after completion or failure.

The current session's history is injected automatically by the context manager. For earlier
conversations, the agent gets the read-only `fitz_session` tool, backed directly by the host's
shared `SessionQueryService`. The service owns canonical transcript/forensics reads, pagination,
artifact-content opt-in, and owner filtering; the tool only formats the returned snapshot for the
agent and turns service failures into a readable message instead of a crashed tool call. The tool
is registered only when the service is supplied, and it is exempt from Ask first / Read only gating
because it never mutates state.

## Data locations

All mutable Fitz data derives from one data root (`FITZ_DATA_ROOT`, default
`%LOCALAPPDATA%\Fitz Codex` on Windows): the database lives at `{root}/database/fitz.db`, Pi packages
at `{root}/pi`, logs at `{root}/logs`, and cache at `{root}/cache`. Narrow overrides
(`FITZ_PI_AGENT_DIR`, `FITZ_LOGS_DIR`, `FITZ_CACHE_DIR`) remain available for packaging and tests.

Development uses a repo-contained root: `pnpm dev` sets `FITZ_DATA_ROOT=<repo>/data`, keeping the
packaged app's per-user data untouched. The legacy `data/fitz-ninfer.db` store was migrated into the
unified layout once; that migration tooling has since been removed.

The Plugins workspace searches the public npm `pi-package` catalog and lets administrators install,
update, enable, disable, or remove extensions and skills. Extension tools join the normal tool
allowlist and remain subject to Fitz Full access, Ask first, and Read only enforcement.

`FITZ_AGENT_CWD` can force a fixed working folder, and `FITZ_AGENT_BASE_URL` can override the local
gateway URL. Normal desktop use needs neither override.
