# Engine adapters

Fitz supports four engine modes through `FITZ_ENGINE_MODE`:

- `fake` is the deterministic development default.
- `ninfer` manages the locally installed NInfer server and the imported Fitz recipes.
- `openai-compatible` connects to an already-running OpenAI-compatible HTTP server.
- `llama-cpp` launches and owns a `llama-server` process.

## Engine repository folder

The Playbooks workspace discovers immediate child folders beneath one configurable root. On Windows the default is `C:\Users\<user>\llm\engines`. Every child is an independent engine repository:

```text
C:\Users\<user>\llm\engines\
  engine-one\       # untouched Git checkout
  engine-two\       # untouched Git checkout
  private-fork\     # untouched Git checkout
```

Fitz treats this directory as read-only. It does not clone repositories, create folders, write manifests or sidecars, add a `.fitz` directory, or put generated build files in an engine checkout. Repository installation and Git updates therefore remain independent of Fitz.

Add or clone any engine into the root, refresh Playbooks, and its folder appears as **Needs setup**. Registration records only the folder path and OpenAI-compatible connection/launch settings in Fitz's SQLite database. No engine names, repository URLs, or launch commands are built into onboarding.

An engine can use either connection mode:

- **Managed**: Fitz launches and stops a configured command either on Windows or in the named managed Linux runtime. Arguments can contain `{host}`, `{port}`, `{model}`, and `{context}` placeholders. Windows recipes stay inside the host engine repository; Linux recipes stay inside the deployed `/opt/fitz/llm/engines/<engine-id>` tree. Recipes identify `runtimeId: "inference-linux"` and never select a WSL distribution directly.
- **External**: Fitz connects to an already-running OpenAI-compatible server URL.

Recipes belong to their registered engine. Model artifacts live separately beneath `C:\Users\<user>\.llm\models`. Fast, Default, Smart, and the internal Subagent execution route are assigned only from Connections. Subagent does not appear in the chat tier picker. Independent delegated calls are submitted together, while the assigned recipe's `maxConcurrentGenerations` controls actual execution: `1` serializes isolated workers and larger values admit that many concurrent generations. Cloud recipes and continuously batched local servers use the same contract.

## Generic OpenAI-compatible server

Set `FITZ_ENGINE_MODE=openai-compatible`, `FITZ_OPENAI_BASE_URL`, and `FITZ_MODEL_ID`. If the endpoint requires a key, put the key in an environment variable and set `FITZ_OPENAI_API_KEY_ENV` to that variable's name. Keys are resolved at startup and are never stored in recipes. Remote plaintext HTTP is rejected unless `FITZ_OPENAI_ALLOW_INSECURE_REMOTE=true` is explicitly set.

## llama.cpp

Set `FITZ_ENGINE_MODE=llama-cpp`, `FITZ_LLAMA_CPP_EXECUTABLE`, `FITZ_LLAMA_CPP_MODEL`, and optionally `FITZ_MODEL_ID`, `FITZ_MODEL_CONTEXT_TOKENS`, and `FITZ_LLAMA_CPP_GPU_LAYERS`. Fitz binds the managed server to its allocated interface and port, generates a per-process API key, polls readiness, streams through the common OpenAI-compatible transport, and terminates the process during eviction.

`llama-server` enables continuous batching by default, but concurrency still requires multiple server slots via `--parallel N`. A recipe must declare the same capacity in `capabilities.maxConcurrentGenerations`; Fitz deliberately treats its current auto-discovered llama.cpp recipes as sequential because they launch with `--parallel 1`. Increasing slots also increases KV-cache pressure, so it is a per-recipe performance choice rather than a global default.
