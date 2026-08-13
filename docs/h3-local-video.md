# MiniMax H3 local video

Fitz runs MiniMax H3 through the official native ComfyUI nodes. ComfyUI is an
independent upstream engine checkout; its models, Python runtime, configuration,
and generated output do not pollute that repository.

## Managed layout

| Purpose | Location |
| --- | --- |
| Upstream ComfyUI checkout | `/opt/fitz/llm/engines/ComfyUI` |
| Isolated Python environment | `/opt/fitz/llm/environments/comfyui` |
| H3 model files | `/opt/fitz/llm/models/comfyui` |
| ComfyUI LoRAs | `/opt/fitz/llm/models/comfyui/loras` |
| ComfyUI model-path config | `/opt/fitz/llm/config/comfyui-extra-model-paths.yaml` |
| Generated intermediates | `/opt/fitz/llm/logs/comfyui-output` |

The first local install uses Comfy-Org's official FL2VA subset (about 42.5 GB):

- `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- `vae/minimax_h3_video_vae_fp16.safetensors`
- `vae/minimax_h3_audio_vae_fp32.safetensors`

This subset covers text-to-video with native audio and the same model's optional
first/last-frame conditioning. Reference-to-video uses a separate diffusion
model and is intentionally not part of the first install.

## Fitz integration

At host startup, `reconcileLocalComfyUIConfiguration` checks for the complete
runtime and all four files. When present it registers `h3-video` additively as
a video-only routing capability. The generated MP4 retains H3's synchronized
stereo soundtrack, but H3 is never assignable to the standalone `audio` route.
It assigns the well-known `video` route only when that route has no valid existing
assignment. ComfyUI is registered alongside the active chat engine; it is not a
mutually exclusive host mode.

The pinned API graph is derived from Comfy-Org's official H3 T2V workflow:

- 1344×768 default canvas, 24 fps
- official `17k + 5` frame-count grid
- `res_multistep`, 20 steps, `simple` scheduler
- video and audio VAE decode into one MP4 artifact
- two-second default for the inexpensive recipe test

In chat, Pi uses `generate_video`. The tool submits an asynchronous media job;
the GPU job continues after the agent turn and the finished MP4 is stored as a
Fitz artifact for playback in the Inspector.

## Baseline before optimization

The first verified run intentionally uses upstream nodes without community
patches. SageAttention, EasyCache, encoder INT4 variants, and additional H3
reference workflows are follow-ups after the official baseline is reproducible.

## Verified baseline

On 2026-08-09 the installed runtime detected the RTX 5090 through PyTorch
2.11.0 + CUDA 13.0 and completed a real Fitz-adapter generation in 34 seconds.
The artifact is a 768×432, 24 fps H.264 MP4 with an AAC audio stream. Run the
same end-to-end host diagnostic with:

```powershell
pnpm smoke:h3
```

The smoke command intentionally enters through Fitz's route, scheduler,
lifecycle, Comfy adapter, media coordinator, and artifact repository. The GPU
must have at least the recipe's 24 GiB estimate available after Fitz's reserve;
otherwise the resource governor refuses the run instead of overcommitting VRAM.
