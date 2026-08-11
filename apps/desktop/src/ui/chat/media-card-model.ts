type Json = Record<string, any>;

export interface MediaCardJob extends Json {
  id: string;
  sourceJobId?: string;
  routeId?: string;
  modality: "image" | "audio" | "video";
  status: string;
}

export interface MediaCardPresentation {
  label: string;
  title: string;
  detail: string;
  operation: "generation" | "edit";
}

export function mediaCardPresentation(job: MediaCardJob, failure?: string, artifactName?: string): MediaCardPresentation {
  const label = `${job.modality[0]!.toUpperCase()}${job.modality.slice(1)}`;
  const operation = job.params?.operation === "edit" ? "edit" : "generation";
  const completed = job.status === "completed";
  const title = completed ? `${label} ready`
    : job.status === "failed" || job.status === "interrupted" ? `${label} ${operation} failed`
      : job.status === "cancelled" ? `${label} ${operation} cancelled`
        : `${label} ${operation} in progress`;
  return {
    label,
    title,
    operation,
    detail: failure ?? artifactName ?? (completed ? "Generated artifact" : "Fitz is following this job in the background."),
  };
}

export function mediaExecutionSettings(job: MediaCardJob): Array<[string, string]> {
  const params = job.params && typeof job.params === "object" ? job.params as Record<string, unknown> : {};
  const execution = job.execution && typeof job.execution === "object" ? job.execution as Record<string, unknown> : {};
  const settings: Array<[string, string]> = [];
  if (typeof execution.recipeDisplayName === "string") settings.push(["Model", execution.recipeDisplayName]);
  if (typeof execution.modelId === "string") settings.push(["Checkpoint", execution.modelId]);
  if (typeof execution.recipeId === "string") settings.push(["Recipe", execution.recipeId]);
  if (typeof execution.adapter === "string") settings.push(["Engine", execution.adapter === "comfyui" ? "ComfyUI" : execution.adapter]);
  if (Object.keys(execution).length === 0) settings.push(["Execution details", "Not recorded for this earlier job"]);
  if (typeof job.routeId === "string") settings.push(["Route", job.routeId]);
  settings.push(["Operation", params.operation === "edit" ? "Edit" : "Generate"]);
  const labels: Record<string, string> = {
    size: "Resolution", seed: "Seed", sampler: "Sampler", steps: "Steps", guidance: "Guidance",
    negativePrompt: "Negative prompt", durationSeconds: "Duration (seconds)", fps: "Frame rate (fps)",
  };
  for (const [key, value] of Object.entries(params)) {
    if (["prompt", "operation", "refs"].includes(key) || value === undefined) continue;
    const label = labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
    settings.push([label, value === "" ? "None" : typeof value === "string" ? value : JSON.stringify(value)]);
  }
  return settings;
}

export function mediaPromptChain(job: MediaCardJob, parent: (job: MediaCardJob) => MediaCardJob | undefined): Array<{ jobId: string; label: string; prompt: string }> {
  const lineage: Array<{ jobId: string; operation: string; prompt: string }> = [];
  const seen = new Set<string>();
  let current: MediaCardJob | undefined = job;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const params = current.params && typeof current.params === "object" ? current.params as Record<string, unknown> : {};
    lineage.unshift({
      jobId: current.id,
      operation: params.operation === "edit" ? "edit" : "generate",
      prompt: typeof params.prompt === "string" ? params.prompt : "Not recorded",
    });
    current = parent(current);
  }
  let editNumber = 0;
  return lineage.map((item, index) => {
    if (item.operation !== "edit" && index === 0) return { jobId: item.jobId, label: "Original", prompt: item.prompt };
    editNumber += 1;
    return { jobId: item.jobId, label: lineage.length === 1 ? "Edit" : `Edit ${editNumber}`, prompt: item.prompt };
  });
}
