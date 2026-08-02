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

- **Managed**: Fitz launches and stops a configured command on Windows or WSL. Arguments can contain `{host}`, `{port}`, `{model}`, and `{context}` placeholders. The working directory must remain inside the engine repository.
- **External**: Fitz connects to an already-running OpenAI-compatible server URL.

Recipes belong to their registered engine. Model artifacts live separately beneath `C:\Users\<user>\llm\models`. Fast, Default, and Smart are assigned only from Connections; switching a connection route lets the lifecycle manager stop the previous managed engine and load the selected recipe on demand.

## Generic OpenAI-compatible server

Set `FITZ_ENGINE_MODE=openai-compatible`, `FITZ_OPENAI_BASE_URL`, and `FITZ_MODEL_ID`. If the endpoint requires a key, put the key in an environment variable and set `FITZ_OPENAI_API_KEY_ENV` to that variable's name. Keys are resolved at startup and are never stored in recipes. Remote plaintext HTTP is rejected unless `FITZ_OPENAI_ALLOW_INSECURE_REMOTE=true` is explicitly set.

## llama.cpp

Set `FITZ_ENGINE_MODE=llama-cpp`, `FITZ_LLAMA_CPP_EXECUTABLE`, `FITZ_LLAMA_CPP_MODEL`, and optionally `FITZ_MODEL_ID`, `FITZ_MODEL_CONTEXT_TOKENS`, and `FITZ_LLAMA_CPP_GPU_LAYERS`. Fitz binds the managed server to its allocated interface and port, generates a per-process API key, polls readiness, streams through the common OpenAI-compatible transport, and terminates the process during eviction.
