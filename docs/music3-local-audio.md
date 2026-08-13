# MiniMax Music 3 local audio

MiniMax Music 3 is Fitz's local audio recipe. MiniMax H3 remains a video-only
route: its synchronized soundtrack stays inside the generated MP4 and is not
exposed as a standalone audio-generation capability.

## Runtime and models

The recipe uses ComfyUI core support for MiniMax Music 3 and requires these
three files in Fitz's external ComfyUI model registry:

- `diffusion_models/minimax_music3_dit_fp16.safetensors`
- `text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`
- `vae/minimax_music3_dav.safetensors`

Startup discovery registers `minimax-music3-audio` only when the ComfyUI
runtime and all three files exist. It then assigns the well-known `audio` route
to that recipe. A legacy `audio` route pointing at H3 is migrated automatically.

## Generation contract

- Prompt: genre, mood, tempo, vocals, instrumentation, arrangement, and
  production style.
- Lyrics: optional; section tags such as `[Verse]`, `[Chorus]`, `[Bridge]`, and
  `[Outro]` control song structure. Leave lyrics blank for instrumental music.
- Default maximum duration: 60 seconds.
- Maximum selectable duration: 300 seconds.
- Output: high-quality V0 MP3.

The workflow uses tiled VAE decoding to keep long generations inside a
predictable local VRAM envelope. Recipe resource admission budgets 22 GiB of
dedicated VRAM; this is peak working memory, not the 14 GiB model download size.
