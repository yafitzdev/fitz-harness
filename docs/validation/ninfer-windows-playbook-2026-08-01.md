# NiNfer Windows playbook validation — 2026-08-01

The production NiNfer configuration is defined as one `ninfer` playbook with two recipes:

| Recipe | Route | Artifact | Speculation |
| --- | --- | --- | --- |
| `qwen36-35b-a3b-mtp4-100k` | `default`, `smart` | `qwen3_6_35b_a3b.ninfer` | MTP4 |
| `qwen36-27b-mtp3-100k` | `fast` | `qwen3_6_27b_nvfp4.ninfer` | MTP3 |

The Windows host launched both recipes through the Ubuntu WSL bridge. Fitz passed executable and model arguments separately from the fixed stdin wrapper, captured the Linux process ID, generated per-process authentication, and terminated the guest process during eviction.

## Live result

- 27B loaded and returned `route-switch-27b` in 7,403 ms.
- 35B loaded and returned `route-switch-35b` in 7,102 ms.
- Both recipes completed the full load, busy, drain, eviction, and unload lifecycle.
- Final state was `UNLOADED`; no direct NiNfer process remained.
- A clean host database exposed one playbook, two recipes, and exactly the `fast`, `default`, and `smart` routes.

Use `pnpm dev:ninfer` to start this configuration with its separate `data/fitz-ninfer.db` store.
