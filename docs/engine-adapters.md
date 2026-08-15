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
- up to three local calls in the host lane, capped further by the active recipe's `maxConcurrentGenerations`;
- no parked secondary engines or configurable preload set;
- local media may temporarily displace Default and must restore it afterward;
- changing the chat choice does not start or test an engine.

Consequently, vLLM launches with `--max-num-seqs 1`, and llama.cpp recipes use one server slot. NInfer recipes may opt into small continuous batches. The Qwen 3.8 27B C3 recipe has a 256,000-token shared context pool: two 64K local workers leave 128,000 tokens for its implicit main agent against one shared model and KV pool.

An agent-capable recipe owns only capacity: a shared context pool and a homogeneous worker count/context. Every such recipe has one implicit main agent, whose context is the model limit capped by the context left after worker allocation. Recipe configuration never stores a main-agent prompt, worker roles, or worker instructions. At dispatch time the main agent selects a role identifier; the host resolves it deterministically from the global versioned role registry and snapshots that definition into the child run.

## Cloud connections

OpenAI-compatible connections belong to the authenticated consumer who created them. Their recipes are visible only to that owner and can be assigned to two roles:

- **Smart**: an optional cloud model selected for a main-agent turn and for its single optional concurrent Smart peer.
- **Fast workers**: an optional cloud model selected for a main-agent turn and used by its Fast children.

Smart and Fast execute in the bounded cloud lane and may overlap. Cloud delegation is effort-dependent and separate from output tokens. Light launches no cloud children. At Normal, Fast can launch two Fast children and Smart can launch three Fast children. At High, Fast can launch three Fast children and Smart can launch three Fast children plus one optional Smart peer. That peer is reserved for a separate Smart-tier task that the main Smart agent wants to run concurrently with its own substantive work; the runtime requires the parent to start an allowed tool task before admitting it. It is never used as a Fast researcher or automatically spent on project familiarization. A local Default turn receives the same delegation tool whenever its recipe declares local worker capacity, independently of effort; those children stay on Default and use the recipe's worker context.

Credentials are stored by the desktop using Electron safe storage and are registered on the host under owner-and-connection-scoped environment variable names. One user cannot bind another user's discovered recipe.

## Built-in adapters

- **NInfer**: managed local text engine optimized for its supported model set.
- **llama.cpp**: managed local GGUF text/VLM server.
- **vLLM**: managed local Linux text server materialized from strict registration JSON.
- **OpenAI-compatible**: remote text endpoints used for consumer-owned Smart/Fast roles.
- **ComfyUI and media providers**: local or remote media engines using the shared job pipeline.
- **Fake**: deterministic development and test adapter.

The exact residency and displacement algorithm is documented in [model-residency.md](./model-residency.md).
