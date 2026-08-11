import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSION_SOURCE = String.raw`import os
import subprocess
import time
import torch
import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview


_PACING_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fitz_pacing.log")


def _log_pacing(message):
    try:
        with open(_PACING_LOG, "a", encoding="utf-8") as _f:
            _f.write("%s %s\n" % (time.strftime("%H:%M:%S"), message))
    except OSError:
        pass


_log_pacing("fitz_safe_sampler loaded cuda=%s gpu=%s"
            % (torch.cuda.is_available(),
               torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"))


# Pacing policy: diffusion runs in bounded bursts (default 8 s of GPU time)
# with an idle after each burst. The idle is the base rest plus any overshoot
# beyond the budget, so a step that overruns its burst repays the extra heat
# with extra idle: short steps batch into one burst with little idle, long
# steps self-scale. The idle is capped: beyond ~8 s the die has shed what it
# will quickly, so longer rests only cost wall time. An emergency floor: a
# die at or above the safeguard temperature rests at least the safeguard
# rest whatever the budget says, then starts a fresh burst. The safeguard
# sits at 85 C with a 10 s rest: a genuinely hot die is given a long idle
# and then allowed to continue. The host's hard stop is a 92 C backstop in
# firmware-throttle territory, so it never races this floor and only fires
# if this extension is missing or broken.
_BURST_BUDGET_SECONDS = 8.0
_BASE_IDLE_SECONDS = 3.0
_MAX_REST_SECONDS = 8.0
_SAFEGUARD_TEMP_C = 85
_SAFEGUARD_REST_SECONDS = 10.0

class _PacedCallback:
    def __init__(self, callback, duty_cycle):
        self.callback = callback
        self.duty_cycle = max(0.10, min(0.95, float(duty_cycle)))
        self.resumed_at = time.monotonic()
        self.burst_work = 0.0
        _log_pacing("callback init duty=%s" % self.duty_cycle)

    def __call__(self, *args, **kwargs):
        step = args[0] if args else -1
        self.callback(*args, **kwargs)
        # CUDA work is asynchronous. Without this synchronization the old
        # implementation measured only CPU enqueue time, slept too briefly,
        # and could leave the GPU at a continuous 100% workload.
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        now = time.monotonic()
        work_seconds = max(0.0, now - self.resumed_at)
        temperature = _gpu_temperature_c()
        self.burst_work += work_seconds
        burst_work = self.burst_work
        rest_seconds = 0.0
        if burst_work >= _BURST_BUDGET_SECONDS:
            rest_seconds = min(_BASE_IDLE_SECONDS + (burst_work - _BURST_BUDGET_SECONDS), _MAX_REST_SECONDS)
            self.burst_work = 0.0
        # Emergency floor: a genuinely hot die rests at least the safeguard
        # rest, whatever the burst budget says, then starts a fresh burst.
        if temperature is not None and temperature >= _SAFEGUARD_TEMP_C:
            rest_seconds = max(rest_seconds, _SAFEGUARD_REST_SECONDS)
            self.burst_work = 0.0
        _log_pacing("step=%s work=%.3f temp=%s burst=%.3f rest=%.3f"
                    % (step, work_seconds, temperature, burst_work, rest_seconds))
        if rest_seconds >= 0.01:
            _sleep_started = time.monotonic()
            time.sleep(rest_seconds)
            _log_pacing("step=%s slept=%.3f" % (step, time.monotonic() - _sleep_started))
        self.resumed_at = time.monotonic()


def _gpu_temperature_c():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2.0, check=True)
        return int(result.stdout.strip().splitlines()[0])
    except (OSError, IndexError, ValueError,
            subprocess.SubprocessError):
        return None


_GLOBAL_DUTY_CYCLE = 0.40
_PACING_INSTALLED = False


def _install_global_pacing():
    """Runtime patch: pace every sampler, not just the swapped FitzSafe nodes.

    Every k-diffusion sampling path (KSampler, KSamplerAdvanced,
    SamplerCustomAdvanced, any guider) funnels through
    comfy.samplers.KSAMPLER.sample, which adapts the per-step callback.
    Wrapping the callback there means burst pacing applies to stock nodes too:
    pacing is engine-side and always on while this extension is installed, so
    the GPU can never sit at 100% and compound to the host's 92 C stop.
    Idempotent: each callback is wrapped at most once.
    """
    global _PACING_INSTALLED
    if _PACING_INSTALLED:
        return
    try:
        import comfy.samplers
        _original_ksampler_sample = comfy.samplers.KSAMPLER.sample

        def _paced_ksampler_sample(self, model_wrap, sigmas, extra_args, callback,
                                   noise, latent_image=None, denoise_mask=None,
                                   disable_pbar=False):
            if callback is not None and not isinstance(callback, _PacedCallback):
                callback = _PacedCallback(callback, _GLOBAL_DUTY_CYCLE)
            return _original_ksampler_sample(
                self, model_wrap, sigmas, extra_args, callback, noise,
                latent_image=latent_image, denoise_mask=denoise_mask,
                disable_pbar=disable_pbar)

        comfy.samplers.KSAMPLER.sample = _paced_ksampler_sample
        _PACING_INSTALLED = True
        _log_pacing("global pacing installed (duty=%s)" % _GLOBAL_DUTY_CYCLE)
    except Exception as _exc:
        _log_pacing("global pacing install FAILED: %s" % _exc)


def _common_ksampler(model, seed, steps, cfg, sampler_name, scheduler, positive,
                     negative, latent, safe_duty_cycle, denoise=1.0,
                     disable_noise=False, start_step=None, last_step=None,
                     force_full_denoise=False):
    latent_image = latent["samples"]
    latent_image = comfy.sample.fix_empty_latent_channels(
        model, latent_image, latent.get("downscale_ratio_spacial", None),
        latent.get("downscale_ratio_temporal", None))
    if disable_noise:
        noise = torch.zeros(latent_image.size(), dtype=latent_image.dtype,
                            layout=latent_image.layout, device="cpu")
    else:
        batch_inds = latent.get("batch_index", None)
        noise = comfy.sample.prepare_noise(latent_image, seed, batch_inds)
    noise_mask = latent.get("noise_mask", None)
    callback = _PacedCallback(latent_preview.prepare_callback(model, steps), safe_duty_cycle)
    samples = comfy.sample.sample(
        model, noise, steps, cfg, sampler_name, scheduler, positive, negative,
        latent_image, denoise=denoise, disable_noise=disable_noise,
        start_step=start_step, last_step=last_step,
        force_full_denoise=force_full_denoise, noise_mask=noise_mask,
        callback=callback, disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
        seed=seed)
    out = latent.copy()
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples
    return (out,)


class FitzSafeKSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
            "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1}),
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS,),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
            "positive": ("CONDITIONING",), "negative": ("CONDITIONING",),
            "latent_image": ("LATENT",),
            "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            "safe_duty_cycle": ("FLOAT", {"default": 0.40, "min": 0.10, "max": 0.95, "step": 0.05}),
        }}
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "Fitz/sampling"

    def sample(self, model, seed, steps, cfg, sampler_name, scheduler, positive,
               negative, latent_image, denoise, safe_duty_cycle):
        return _common_ksampler(model, seed, steps, cfg, sampler_name, scheduler,
                                positive, negative, latent_image, safe_duty_cycle,
                                denoise=denoise)


class FitzSafeKSamplerAdvanced:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "add_noise": (["enable", "disable"],),
            "noise_seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
            "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1}),
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS,),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
            "positive": ("CONDITIONING",), "negative": ("CONDITIONING",),
            "latent_image": ("LATENT",),
            "start_at_step": ("INT", {"default": 0, "min": 0, "max": 10000}),
            "end_at_step": ("INT", {"default": 10000, "min": 0, "max": 10000}),
            "return_with_leftover_noise": (["disable", "enable"],),
            "safe_duty_cycle": ("FLOAT", {"default": 0.40, "min": 0.10, "max": 0.95, "step": 0.05}),
        }}
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "Fitz/sampling"

    def sample(self, model, add_noise, noise_seed, steps, cfg, sampler_name,
               scheduler, positive, negative, latent_image, start_at_step,
               end_at_step, return_with_leftover_noise, safe_duty_cycle):
        return _common_ksampler(
            model, noise_seed, steps, cfg, sampler_name, scheduler, positive,
            negative, latent_image, safe_duty_cycle,
            disable_noise=add_noise == "disable", start_step=start_at_step,
            last_step=end_at_step,
            force_full_denoise=return_with_leftover_noise != "enable")


class FitzSafeSamplerCustomAdvanced:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "noise": ("NOISE",), "guider": ("GUIDER",), "sampler": ("SAMPLER",),
            "sigmas": ("SIGMAS",), "latent_image": ("LATENT",),
            "safe_duty_cycle": ("FLOAT", {"default": 0.40, "min": 0.10, "max": 0.95, "step": 0.05}),
        }}
    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("output", "denoised_output")
    FUNCTION = "sample"
    CATEGORY = "Fitz/sampling"

    def sample(self, noise, guider, sampler, sigmas, latent_image, safe_duty_cycle):
        latent = latent_image
        samples_in = comfy.sample.fix_empty_latent_channels(
            guider.model_patcher, latent["samples"],
            latent.get("downscale_ratio_spacial", None),
            latent.get("downscale_ratio_temporal", None))
        latent = latent.copy()
        latent["samples"] = samples_in
        x0_output = {}
        callback = _PacedCallback(
            latent_preview.prepare_callback(guider.model_patcher, sigmas.shape[-1] - 1, x0_output),
            safe_duty_cycle)
        samples = guider.sample(
            noise.generate_noise(latent), samples_in, sampler, sigmas,
            denoise_mask=latent.get("noise_mask", None), callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=noise.seed)
        samples = samples.to(comfy.model_management.intermediate_device())
        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        out["samples"] = samples
        if "x0" not in x0_output:
            return (out, out)
        x0 = x0_output["x0"]
        if samples.is_nested and not x0.is_nested:
            latent_shapes = [value.shape for value in samples.unbind()]
            x0 = comfy.nested_tensor.NestedTensor(comfy.utils.unpack_latents(x0, latent_shapes))
        out_denoised = latent.copy()
        out_denoised["samples"] = guider.model_patcher.model.process_latent_out(x0.cpu())
        return (out, out_denoised)


NODE_CLASS_MAPPINGS = {
    "FitzSafeKSampler": FitzSafeKSampler,
    "FitzSafeKSamplerAdvanced": FitzSafeKSamplerAdvanced,
    "FitzSafeSamplerCustomAdvanced": FitzSafeSamplerCustomAdvanced,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FitzSafeKSampler": "Fitz Safe KSampler",
    "FitzSafeKSamplerAdvanced": "Fitz Safe KSampler (Advanced)",
    "FitzSafeSamplerCustomAdvanced": "Fitz Safe Sampler Custom Advanced",
}

_install_global_pacing()
`;

/** Installs Fitz's cooperative sampler beside application data, never inside
 * the upstream ComfyUI checkout. ComfyUI discovers it through --base-directory. */
export function ensureComfyUISafeModeExtension(baseDirectory: string): string {
  const extensionDirectory = join(baseDirectory, "custom_nodes", "fitz_safe_sampler");
  const extensionPath = join(extensionDirectory, "__init__.py");
  mkdirSync(extensionDirectory, { recursive: true });
  let existing: string | undefined;
  try { existing = readFileSync(extensionPath, "utf8"); } catch { /* first install */ }
  if (existing !== EXTENSION_SOURCE) writeFileSync(extensionPath, EXTENSION_SOURCE, "utf8");
  return extensionPath;
}
