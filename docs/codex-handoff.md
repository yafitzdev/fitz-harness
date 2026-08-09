# Handoff to Codex — fitz-codex media generation (PRs 1–8 complete)

> Written 2026-08-08 from a Grok Build session. Read this file first, then continue from
> [Where to pick up](#where-to-pick-up). The design doc `docs/media-generation.md` is the
> normative spec; this file is the operational snapshot.

## Project in one paragraph

`fitz-codex` is a local-first, Codex-style agent app plus an inference control plane
(Windows host machine, TypeScript/pnpm monorepo). The desktop (Electron) talks to a bundled
Fastify host; the host owns the SQLite store, engine adapters (NInfer, llama.cpp,
OpenAI-compatible, fake), the Pi coding-agent runtime, and — since PRs 1–8 — a **media
generation pipeline** (routes → media jobs → artifacts) with cloud provider templates
(fal/Replicate) and a local ComfyUI engine adapter for MiniMax H3. All 8 media PRs are
committed locally on `main`; nothing has been pushed to `origin` yet, and none of it is
deployed to the user's installed app (the bundled host binary is stale).

## Where things stand right now

- `main` at `073ae1a` ("PR 8: large-media artifact handling…"), **ahead of `origin/main` by 19 commits**, working tree clean.
- The 11 most recent commits are the media work: `7309e6d` (design doc) → `5d6aab5` (PR 1) → `b6191ba` (PR 2a) → `9addc28` (PR 2b) → `28fc23f` (PR 2c) → `bdf56f0` (PR 3) → `18a90e8` (PR 4) → `1ca531a` (PR 5) → `16dd739` (PR 6) → `eacdca9` (PR 7) → `073ae1a` (PR 8).
- Test suite green at last check: **73 files, 714 passed, 1 skipped** (`pnpm check` = `tsc -b` + `vitest run`).
- Side branch `agent/ninfer-parity-and-operations` (`2719f3c`) exists and is published to origin — it holds older NInfer parity validation work, **not** part of the media roadmap. Leave it alone unless asked.
- The design doc's PR Plan (§"PR Plan", ~line 760 of `docs/media-generation.md`) is **fully implemented**: PRs 1, 2a, 2b, 2c, 3, 4, 5, 6, 7, 8 are all done.
- `docs/implementation-status.md` is **stale** — it predates the media work and should be updated (pending item).

## Architecture map (media pipeline)

Layers, bottom-up, with the files that matter:

| Layer | Where | Key files |
|---|---|---|
| Protocol/domain types | `packages/protocol` | media job types, `MediaQuota`, `principalForUser` |
| Media engine adapter interface | `packages/inference-core` | `MediaEngineAdapter`, `runMedia`, `LifecycleManager.runMedia`, media scheduler queue |
| Durable job service | `apps/host` | `apps/host/src/media-jobs.ts` (`MediaJobCoordinator`, `DEFAULT_ARTIFACT_LIMITS`) |
| HTTP surface | `apps/host` | `apps/host/src/create-app.ts` (~1830 lines; media routes, gateway, job endpoints, artifact content endpoint with Range support) |
| Engines | `packages/engine-media-fake`, `packages/engine-comfyui`, `packages/media-providers` | fake adapter + fixture server; ComfyUI adapter (managed/external modes); fal/Replicate/openai-media templates |
| Recipes/routes seeding | `apps/host` | `apps/host/src/comfyui-playbook.ts` (`createComfyUIPlaybook`) |
| Desktop UI | `apps/desktop` | Connections & Playbooks media sections (PR 5), `apps/desktop/src/resource-preview.ts` (MIME-aware preview caps) |
| Storage | `packages/storage` | `migrations.ts` (media tables at **v9**), `sqlite-store.ts` |
| Preview caps | `packages/media` | `registry.ts` → `maxPreviewBytes` (text 2 MiB / image 25 MiB / audio 200 MiB / video 250 MiB / binary 10 MiB) |

Key behaviors baked in (from the design doc §5):

- **Routes** are the user-facing surface: well-known media routes `image` / `video` / `audio` exist but are disabled with empty `recipeId` until an admin connects a provider or saves a media recipe. Assignment-state survives restarts (`ensureMediaRoutes`); ninfer boot-reconcile exempts media routes; de-assignment never deletes a well-known route, just clears `recipeId` + disables.
- **Media jobs** are durable: submit/poll/cancel endpoints, progress events in `media_job_events`, artifact write-back, quota hook, restart recovery. SSE `/events` replay exists; v1 desktop polls HTTP.
- **Artifact caps**: image 25 MiB / audio 200 MiB / video 1 GiB by default, overridable via the `mediaArtifactLimits` store setting; oversized results fail with machine code `errorCode: "artifact_too_large"`. Human-readable failure messages live on the last failed event (read via `mediaJobFailureMessage`), **not** in `job.errorCode`.
- **Content endpoint** serves artifacts with single-range byte requests (`accept-ranges: bytes`, 206/416, suffix ranges, open-ended ranges, clamping).
- **Agent media tools** (PR 6) are Ask-first gated with media quotas; `FITZ_MEDIA_ENABLED=false` hides them and the Connections media section.

## Conventions that will bite you (learned the hard way)

- **pnpm workspaces with `injectWorkspacePackages: true`**: after adding a `workspace:*` dependency to any package, you must run `pnpm install --prefer-offline` or the symlink won't appear. `apps/desktop` gained `@fitz/media` in PR 8 — this already happened.
- **`tsc -b` project references** (root `tsconfig.json`): when a package's `package.json` gains a workspace dep, its `tsconfig.json` `references` array must also list the new project or the build breaks.
- **`tsconfig.base.json` is strict in ways that matter**: NodeNext (use `.js` extensions in relative imports), `exactOptionalPropertyTypes` (spread `...(... ? { x } : {})` instead of `x: undefined`), `verbatimModuleSyntax` (`import type`), `noUncheckedIndexedAccess` (indexing returns `T | undefined`). There is **no** `noUnusedLocals`, so unused vars won't fail the build — don't rely on the compiler to catch them.
- **vitest runs from the root** (`vitest.config.ts`): aliases map `@fitz/*` → `src/index.ts`; includes `apps/{desktop,host}/src/**/*.test.ts` and `packages/*/src/**/*.test.ts`. Tests import via `@fitz/*` aliases; that's normal here.
- **`create-app.ts` style**: one endpoint per line (compact Fastify handlers), giant file (~1830 lines). Match it; reviewers expect consistency.
- **Never write `*/` inside a JSDoc block comment** — e.g. describe `Content-Range` as `bytes * /<total>` (space between `*` and `/`). `*/` terminates the comment early and produces bizarre TS syntax errors (a real bug in PR 8; it was fixed).
- **Migrations are versioned in `packages/storage/src/migrations.ts`** — v8 is the `sessions_v8` rebuild, v9 is `media_jobs` + `media_job_events`. If you add a migration, append v10+; never edit applied migrations.
- **Engine modes** are selected by `FITZ_ENGINE_MODE` (default `ninfer`; also `comfyui`, `fake`, `openai-compatible`, `llama-cpp`) in `apps/host/src/server.ts`. `comfyui` mode **requires** `FITZ_COMFYUI_DIR` unless `FITZ_COMFYUI_BASE_URL` is set; optional `FITZ_COMFYUI_EXECUTABLE`, `FITZ_COMFYUI_ENTRYPOINT` (default `main.py`), `FITZ_COMFYUI_EXPECTED_VRAM_MIB`.
- **Desktop spawns the bundled host** (`apps/desktop/src/main.ts` `ensureBundledLocalHost`): `release/host/runtime/node.exe release/host/dist/server.js` with **only** `FITZ_HOST` + `FITZ_PORT` env, after a `/health` check. So the desktop's host is always ninfer mode — to test comfyui you must run the host yourself first so the `/health` check reuses it.

## Machine/runtime state (the user's actual Windows box)

- Host DB: `C:\Users\yanfi\AppData\Local\Fitz Codex\database\fitz.db` (via `resolveRuntimePaths`). **Currently at schema v7** — the host that last wrote it predates media. No `media_jobs` / `media_job_events` / `engines` tables; only ninfer Qwen recipes/routes.
- Bundled host binary: `release/host/dist/server.js` built **2026-08-06 01:05** — stale, pre-media. Source `apps/host/src/server.ts` was modified 2026-08-08 23:01. **The installed app does not have the media code yet.**
- Settings in the DB include `engineRoot = "C:\\Users\\yanfi\\.llm\\engines"` and `security.authPepper`.
- Engine roots are **read-only engine repositories** (see `docs/engine-adapters.md`); the settings UI and catalog target GGUF models only.
- Dev runs use a repo-contained data root (`FITZ_DATA_ROOT` → `data/` in the repo) via `scripts/dev.mjs`, which builds first, guards port 8787, and supports **only** `--fake` and ninfer modes (no `--comfyui` flag — run the host directly for that).

## H3 status — important, by design

- **H3 is NOT downloaded and NOT registered, and that is correct per the spec.**
- KD-13 (design doc §"Open Questions"): H3 weight placement is **manual**. Nothing in the repo downloads H3. To use H3 you must: install ComfyUI (or point at an existing one), drop H3 weights into ComfyUI's model dirs, and install the Hailuo custom node pack that provides `HailuoVideoGenerate` / `HailuoImageGenerate` (the node types the pinned `h3-video` / `h3-image` workflows call).
- `createComfyUIPlaybook` seeds: `h3-video` (assigned to the `video` route, enabled, workflows call `HailuoVideoGenerate`/`SaveVideo`) and `h3-image` (experimental, unassigned, `HailuoImageGenerate`). H3 natively does video + audio; **images are community ComfyUI abuse, gated `experimental: true`**. 2K video is cloud-only.
- VRAM: default `expectedVramMiB` 24576 (24 GiB) — fits the user's 32 GB card with the 2048 MiB governor reserve.

## Where to pick up — next steps to test

Order matters; the code is done, the deployment is not.

1. **Rebuild + repack the host** (from PowerShell, in the repo root):
   `pnpm host:pack:win` (runs `scripts/windows/package-host.ps1`). Then kill any stale detached host (the desktop's `/health` check will then reuse the fresh one).
2. **Path A — end-to-end media test without H3 (fastest):** after repacking, connect a cloud provider (**fal or Replicate**) in the desktop's Connections UI. This exercises the full pipeline — routes → media jobs → artifact caps → Range-served content/previews — with zero H3 setup.
3. **Path B — real H3:** after repacking, provision ComfyUI + H3 weights as described above, then start the host yourself with
   `FITZ_ENGINE_MODE=comfyui FITZ_COMFYUI_BASE_URL=http://127.0.0.1:8188` (external mode)
   *before* launching the desktop. Verify in the desktop: Connections video route "MiniMax H3 · Video & Audio" enabled (`h3-image` experimental/unassigned); test via Playbooks' media-test or an agent video request.
4. **Housekeeping:** update `docs/implementation-status.md` to cover PRs 1–8; push `main` to `origin` when the user says so (it's 19 ahead — ask first).

## Decisions you must NOT revisit without the user

- Cloud providers: user said **"i dont care"** — no preference; fal/Replicate templates are the v1 set.
- H3 images: **out of scope** for real use (experimental-gated ComfyUI abuse only).
- VRAM: user has **32 GB**; governor reserve 2048 MiB.
- Single-assignment routes (a route points at exactly one recipe).
- OQ-1 resolved: `ModelCatalogService` stays GGUF-only; catalog pipeline tags (`text-to-video`, `image-generation`) are a **follow-up**, not this work.
- OQ-4 resolved: SQLite stores artifact metadata and opaque object references only. Payloads live in the content-addressed artifact directory beneath Fitz's data root and pre-v12 BLOBs migrate automatically at host startup.

## Suggested first prompt for Codex

> Read `docs/codex-handoff.md` and `docs/media-generation.md`. I'm picking up fitz-codex
> after PRs 1–8 (all committed on `main`, ahead of origin by 19, working tree clean).
> First task: rebuild and repack the host (`pnpm host:pack:win`), then walk me through
> Path A (connect fal or Replicate in Connections and run one media job end-to-end) and
> verify the job → artifact → preview flow in the desktop. Don't push to origin.

## Quick command reference

```bash
pnpm check            # typecheck (tsc -b) + full test suite
pnpm dev              # ninfer mode dev host (port 8787, repo data/)
pnpm dev:fake         # fake engine dev host
pnpm host:pack:win    # rebuild + package bundled host (PowerShell)
pnpm desktop:pack:win # host pack + desktop NSIS installer
pnpm smoke            # build + smoke-test host
```
