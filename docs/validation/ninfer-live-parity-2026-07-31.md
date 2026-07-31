# NInfer live parity — 2026-07-31

The direct Fitz NInfer adapter was tested without changing the existing `ninfer-on-demand.service` or `ninfer.service` configuration.

## Preflight

- Existing proxy: active and idle.
- Existing managed backend: inactive.
- GPU memory before test: 3,099 MiB used, 29,089 MiB free.
- Profile: current 27B recipe at 100,000 context tokens.
- Artifact: `/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer`.
- Binary: `/opt/ninfer/build/apps/ninfer-serve`.
- Launch flags included MTP3, int8 KV cache, LM-head draft, and no thinking.

## Result

- Dynamically allocated loopback port: `35389`.
- Time from spawn through authenticated health readiness: 5,747 ms.
- Test prompt: `Reply with exactly: FITZ_LIVE_OK`.
- Response: `FITZ_LIVE_OK`.
- Adapter inspection after generation: healthy.
- Graceful stop: successful.

## Cleanup verification

- No direct adapter NInfer process remained.
- Port `35389` was released.
- Existing `ninfer.service` remained inactive.
- Existing proxy remained active and idle.
- GPU memory after test: 3,031 MiB used, 29,157 MiB free.

This validates direct launch, generated internal authentication, readiness polling, Chat Completions SSE translation, inspection, graceful stop, socket cleanup, and observed VRAM release for the 27B profile.

## Route-switch and TTL result

A second controlled run exercised the real Fitz route resolver, scheduler, and lifecycle manager:

1. `fast` resolved to the current 27B MTP3 recipe.
2. 27B loaded and returned `route-switch-27b` in 5,872 ms.
3. The scheduler drained and evicted 27B.
4. `default-agent` resolved to the current 35B A3B MTP4 recipe.
5. 35B loaded and returned `route-switch-35b` in 5,841 ms.
6. The configured three-second idle TTL drained and evicted 35B.

The observed state sequence contained two complete
`UNLOADED → PREPARING → LOADING → READY → BUSY → READY → DRAINING → EVICTING → UNLOADED`
cycles. Afterward, no direct NInfer process remained, port `19000` was released, GPU memory
returned to 2,993 MiB used / 29,195 MiB free, `ninfer.service` remained inactive, and the
existing on-demand proxy remained active and idle.
