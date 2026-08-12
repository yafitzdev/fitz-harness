# Engine adapters and registry

Fitz can host different inference engines without giving each engine its own product-level routing policy. Engines provide launch and transport mechanics; the host applies one common local residency contract.

## Canonical inference registry

All local engines, environments, registrations, and model payloads live in the managed `Fitz-Inference` WSL distribution beneath `/opt/fitz/llm`:

```text
/opt/fitz/llm/
  engines/         # independent engine repositories or builds
  environments/    # engine-specific Python/runtime environments
  models/          # small registration JSON plus model payload trees
  config/          # shared engine configuration and extensions
  logs/            # engine logs and generated runtime output
  README.md        # machine-level onboarding and placement rules
```

Windows accesses the same tree at `\\wsl.localhost\Fitz-Inference\opt\fitz\llm`. There is no second Windows model or engine registry.

Engine repositories under `engines/` are treated as read-only by Fitz. Installation and upstream Git updates remain independent of the app. Generated environments, model payloads, configuration, and mutable runtime output do not live inside an engine checkout.

## Engine registration

The Playbooks workspace discovers immediate children beneath `engines/`. A generic managed engine registration records its launch command, arguments, working directory, health endpoint, and runtime id in SQLite. Launch arguments can use `{host}`, `{port}`, `{model}`, and `{context}` placeholders.

Specialized reconcilers may materialize recipes from registration JSON—for example vLLM registrations under `models/vllm/` and GGUF registrations beneath `models/gguf/`. A registration describes a runnable recipe; it does not assign a route. Missing payloads dematerialize the recipe instead of leaving an unusable route behind.

## Common local policy

The host administrator assigns one local text recipe to **Default**. That recipe may use NInfer, llama.cpp, vLLM, or another conforming adapter. Fitz warms it at startup, keeps it resident, and force-stops it when the hosting desktop closes.

Local scheduling is deliberately engine-agnostic:

- one model-bearing local engine active at a time;
- one local generation at a time;
- no parked secondary engines or configurable preload set;
- local media may temporarily displace Default and must restore it afterward;
- changing the chat choice does not start or test an engine.

Consequently, vLLM launches with `--max-num-seqs 1`, and llama.cpp recipes use one server slot. Engine-level continuous batching is not needed for the supported multi-user pattern: independent Pi state machines overlap, while their brief local inference phases wait in an owner-fair queue.

## Cloud connections

OpenAI-compatible connections belong to the authenticated consumer who created them. Their recipes are visible only to that owner and can be assigned to two roles:

- **Smart**: an optional cloud model explicitly selected for the whole main-agent turn.
- **Fast workers**: an optional cloud model used by delegated workers and researchers.

Smart and Fast execute in the bounded cloud lane and may overlap. Fast is offered in the chat picker and to delegated workers only when the owner has configured it.

Credentials are stored by the desktop using Electron safe storage and are registered on the host under owner-and-connection-scoped environment variable names. One user cannot bind another user's discovered recipe.

## Built-in adapters

- **NInfer**: managed local text engine optimized for its supported model set.
- **llama.cpp**: managed local GGUF text/VLM server.
- **vLLM**: managed local Linux text server materialized from strict registration JSON.
- **OpenAI-compatible**: remote text endpoints used for consumer-owned Smart/Fast roles.
- **ComfyUI and media providers**: local or remote media engines using the shared job pipeline.
- **Fake**: deterministic development and test adapter.

The exact residency and displacement algorithm is documented in [model-residency.md](./model-residency.md).
