import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSION_SOURCE = String.raw`import time
import torch
import comfy.model_management
import comfy.nested_tensor
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview


class _PacedCallback:
    def __init__(self, callback, duty_cycle):
        self.callback = callback
        self.duty_cycle = max(0.25, min(0.95, float(duty_cycle)))
        self.resumed_at = time.monotonic()

    def __call__(self, *args, **kwargs):
        self.callback(*args, **kwargs)
        now = time.monotonic()
        work_seconds = max(0.0, now - self.resumed_at)
        rest_seconds = min(5.0, work_seconds * ((1.0 / self.duty_cycle) - 1.0))
        if rest_seconds >= 0.01:
            time.sleep(rest_seconds)
        self.resumed_at = time.monotonic()


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
            "safe_duty_cycle": ("FLOAT", {"default": 0.70, "min": 0.25, "max": 0.95, "step": 0.05}),
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
            "safe_duty_cycle": ("FLOAT", {"default": 0.70, "min": 0.25, "max": 0.95, "step": 0.05}),
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
            "safe_duty_cycle": ("FLOAT", {"default": 0.70, "min": 0.25, "max": 0.95, "step": 0.05}),
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
