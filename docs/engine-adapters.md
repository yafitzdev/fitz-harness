# Engine adapters

Fitz supports four engine modes through `FITZ_ENGINE_MODE`:

- `fake` is the deterministic development default.
- `ninfer` manages the locally installed NInfer server and the imported Fitz recipes.
- `openai-compatible` connects to an already-running OpenAI-compatible HTTP server.
- `llama-cpp` launches and owns a `llama-server` process.

## Generic OpenAI-compatible server

Set `FITZ_ENGINE_MODE=openai-compatible`, `FITZ_OPENAI_BASE_URL`, and `FITZ_MODEL_ID`. If the endpoint requires a key, put the key in an environment variable and set `FITZ_OPENAI_API_KEY_ENV` to that variable's name. Keys are resolved at startup and are never stored in recipes. Remote plaintext HTTP is rejected unless `FITZ_OPENAI_ALLOW_INSECURE_REMOTE=true` is explicitly set.

## llama.cpp

Set `FITZ_ENGINE_MODE=llama-cpp`, `FITZ_LLAMA_CPP_EXECUTABLE`, `FITZ_LLAMA_CPP_MODEL`, and optionally `FITZ_MODEL_ID`, `FITZ_MODEL_CONTEXT_TOKENS`, and `FITZ_LLAMA_CPP_GPU_LAYERS`. Fitz binds the managed server to its allocated interface and port, generates a per-process API key, polls readiness, streams through the common OpenAI-compatible transport, and terminates the process during eviction.
