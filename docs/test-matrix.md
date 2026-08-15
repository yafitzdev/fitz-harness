# Test matrix

The bulk infrastructure pass has automated coverage at four levels:

| Area | Coverage |
| --- | --- |
| Unit | Protocol parsing, state transitions, context budgeting, MIME classification, redaction, reconnect backoff, resource policy, and security policies |
| Failure | Queue and active cancellation, engine generation failure and replacement, resource refusal, malformed configuration, process startup/readiness, and stream errors |
| Integration | SQLite migrations and restart recovery, NInfer simulated process, llama.cpp simulated process, generic OpenAI-compatible HTTP/SSE, Pi runtime translation, and host API injection |
| End-to-end | Compiled host listening on a real TCP socket with health, model discovery, and completion requests; packaged Windows host and Electron executable smoke modes |
| Security | Hashed API keys, rotation/revocation/disabled-user behavior, public-gateway allowlists and admission bounds, route grants, quotas, administrator boundaries, cross-user resource isolation, artifact headers, and secret redaction |
| Recovery | Queued/running inference and native agent runs become durable `interrupted` records after restart; failed engine instances are replaced before subsequent work |

`pnpm check` runs typechecking and the complete Vitest suite. `pnpm smoke` compiles the workspace and exercises the host over HTTP. `pnpm audit --prod` checks production dependencies. The main-branch CI workflow runs all three on every push; the Windows workflow additionally builds and smokes packaged artifacts.
