/**
 * Media-generation tools for the agent (§5.9): `generate_image`, `generate_video`,
 * `generate_audio`. Registered through the runtime's `customTools` hook alongside the
 * safety tools; the host composes this factory with a direct reference to the media
 * job coordinator, the store, and the security service.
 *
 * Non-blocking by construction (KD-12): each tool submits a job in-process and returns
 * `{ mediaJobId, status }` immediately — blocking would deadlock, because the agent's
 * own chat is a queue job ahead of the media job. Completion surfaces via the job SSE
 * stream, the activity timeline, and the artifact repository.
 *
 * The run's owner is resolved from the run context (`runId` → `agent_runs.owner_user_id`)
 * so route grants and media quotas apply to the human, not the host. Submits without a
 * resolvable owner (anonymous run, deleted user, auth disabled) skip the principal and
 * take the admin-diagnostic path, exactly like the media-test probe.
 */

import { toolResult, type ToolDefinition } from "@fitz/agent-pi";
import type { MediaGenerationParams, MediaModality, MediaJobRecord } from "@fitz/protocol";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import { Type } from "typebox";
import type { MediaJobCoordinator } from "./media-jobs.js";

export interface MediaToolsOptions {
  mediaJobs: MediaJobCoordinator;
  store: SqliteStore;
  /** Undefined in explicit local/dev auth-disabled mode. Those ownerless runs
   * use the same administrator-diagnostic path as the management media test. */
  security?: SecurityService;
}

/** UUID-shaped reference: a Fitz artifact id (resolved by the coordinator to its bytes). */
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const generateImageParameters = Type.Object({
  prompt: Type.String({ description: "The image to generate, described in concrete visual detail" }),
  size: Type.Optional(Type.String({ description: 'Output size, e.g. "1024x1024", "768x768", "1280x720"' })),
  seed: Type.Optional(Type.Number({ description: "Deterministic seed for reproducible output" })),
  negative_prompt: Type.Optional(Type.String({ description: "What the image must NOT contain" })),
  refs: Type.Optional(Type.Array(Type.String({ description: "Reference image URLs or Fitz artifact ids for image editing" }))),
  route_id: Type.Optional(Type.String({ description: "A specific granted media route id; defaults to the well-known image route" })),
});

const generateVideoParameters = Type.Object({
  prompt: Type.String({ description: "The video to generate, described as motion over time" }),
  duration_seconds: Type.Optional(Type.Number({ description: "Target duration in seconds, if the route supports it" })),
  resolution: Type.Optional(Type.String({ description: "Output resolution. Omit it to use the selected route's native default; requests above that route's declared maximum are reduced to its maximum." })),
  fps: Type.Optional(Type.Number({ description: "Frames per second, if the route supports it" })),
  refs: Type.Optional(Type.Array(Type.String({ description: "Reference image URLs or Fitz artifact ids for image-to-video" }))),
  route_id: Type.Optional(Type.String({ description: "A specific granted media route id; defaults to the well-known video route" })),
});

const generateAudioParameters = Type.Object({
  prompt: Type.String({ description: "The audio to generate, described as sound over time" }),
  duration_seconds: Type.Optional(Type.Number({ description: "Target duration in seconds, if the route supports it" })),
  route_id: Type.Optional(Type.String({ description: "A specific granted media route id; defaults to the well-known audio route" })),
});

/**
 * Composes the three media tools for one agent run. `runId` resolves the run's owner
 * and session so quota/grants apply to the human and artifacts land in the run's
 * session. In explicit auth-disabled local mode there is no user principal; the
 * submit uses the same unbilled administrator-diagnostic path as `media-test`.
 */
export function createMediaTools(options: MediaToolsOptions): (context: { cwd: string; runId?: string }) => ToolDefinition[] {
  return (context) => [
    {
      name: "generate_image",
      label: "Generate image",
      description:
        "Generate an image with the configured image route. The image completes asynchronously: this tool returns immediately with a media job id, and the finished artifact appears in the session's artifact list. Use route_id only when the user explicitly asks for a specific granted media route.",
      promptSnippet: "Generate an image",
      promptGuidelines: [
        "Describe the image in concrete visual detail (subject, style, composition) rather than intent.",
        "The job is queued asynchronously; do not claim the image exists until the artifact appears in the session.",
      ],
      parameters: generateImageParameters,
      execute: async (_toolCallId, params) => {
        try {
          const job = await submitMedia(options, context, "image", {
            prompt: params.prompt,
            ...(params.size !== undefined ? { size: params.size } : {}),
            ...(params.seed !== undefined ? { seed: params.seed } : {}),
            ...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
            ...(params.refs !== undefined ? { refs: mapRefs(params.refs) } : {}),
          }, params.route_id);
          return mediaJobResult(job, "image");
        } catch (error) {
          return mediaErrorResult("image", error);
        }
      },
    } satisfies ToolDefinition<typeof generateImageParameters>,
    {
      name: "generate_video",
      label: "Generate video",
      description:
        "Generate a video with the configured video route. The video completes asynchronously: this tool returns immediately with a media job id, and the finished artifact appears in the session's artifact list. Use route_id only when the user explicitly asks for a specific granted media route.",
      promptSnippet: "Generate a video",
      promptGuidelines: [
        "Describe motion over time (camera, subject movement, scene changes) rather than a static scene.",
        "Prefer the route's default resolution. Only request resolution when the user explicitly asks for one.",
        "The job is queued asynchronously; do not claim the video exists until the artifact appears in the session.",
      ],
      parameters: generateVideoParameters,
      execute: async (_toolCallId, params) => {
        try {
          const job = await submitMedia(options, context, "video", {
            prompt: params.prompt,
            ...(params.duration_seconds !== undefined ? { durationSeconds: params.duration_seconds } : {}),
            ...(params.resolution !== undefined ? { size: params.resolution } : {}),
            ...(params.fps !== undefined ? { fps: params.fps } : {}),
            ...(params.refs !== undefined ? { refs: mapRefs(params.refs) } : {}),
          }, params.route_id);
          return mediaJobResult(job, "video");
        } catch (error) {
          return mediaErrorResult("video", error);
        }
      },
    } satisfies ToolDefinition<typeof generateVideoParameters>,
    {
      name: "generate_audio",
      label: "Generate audio",
      description:
        "Generate audio with the configured audio route. The audio completes asynchronously: this tool returns immediately with a media job id, and the finished artifact appears in the session's artifact list. Registered now, but errors until an audio route exists (no route is assigned by default).",
      promptSnippet: "Generate audio",
      promptGuidelines: [
        "Describe the sound over time (content, mood, duration) rather than intent.",
        "The job is queued asynchronously; do not claim the audio exists until the artifact appears in the session.",
      ],
      parameters: generateAudioParameters,
      execute: async (_toolCallId, params) => {
        try {
          const job = await submitMedia(options, context, "audio", {
            prompt: params.prompt,
            ...(params.duration_seconds !== undefined ? { durationSeconds: params.duration_seconds } : {}),
          }, params.route_id);
          return mediaJobResult(job, "audio");
        } catch (error) {
          return mediaErrorResult("audio", error);
        }
      },
    } satisfies ToolDefinition<typeof generateAudioParameters>,
  ];
}

/** Submit in-process with the run owner's principal; never blocks on completion (§5.9, KD-12). */
async function submitMedia(
  { mediaJobs, store, security }: MediaToolsOptions,
  context: { cwd: string; runId?: string },
  modality: MediaModality,
  params: MediaGenerationParams,
  routeId: string | undefined,
): Promise<MediaJobRecord> {
  const run = context.runId ? store.getAgentRun(context.runId) : undefined;
  const principal = resolvePrincipal(security, run?.ownerUserId);
  return mediaJobs.submit({
    routeId: routeId ?? modality,
    modality,
    params,
    ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
  }, principal);
}

/** Device-less principal for the in-process submit (§5.9): grants and quotas apply to the human. */
function resolvePrincipal(security: SecurityService | undefined, ownerUserId: string | undefined): AuthenticatedPrincipal | undefined {
  if (!security || !ownerUserId) return undefined;
  try {
    return security.principalForUser(ownerUserId);
  } catch {
    // The run's owner no longer exists as a user — there is nobody to bill or grant, so
    // submit without a principal (the admin-diagnostic path, like the media-test probe).
    return undefined;
  }
}

function mediaJobResult(job: MediaJobRecord, modality: MediaModality): ReturnType<typeof toolResult> {
  return toolResult(
    `Submitted ${modality} generation job ${job.id} (status: ${job.status}). The job completes asynchronously; the finished ${modality} will appear in the session's artifact list.`,
    { mediaJobId: job.id, status: job.status },
  );
}

function mediaErrorResult(modality: MediaModality, error: unknown): ReturnType<typeof toolResult> {
  const message = error instanceof Error ? error.message : String(error);
  // The agent reads the text and relays it; known failures (missing route, route denied,
  // quota exceeded) surface as clear, actionable messages rather than raw exceptions.
  return toolResult(`Could not generate ${modality}: ${message}`);
}

/** Tool `refs` arrive as strings (Fitz artifact ids or URLs); the protocol wants `{artifactId} | {url}`. */
function mapRefs(refs: readonly string[]): Array<{ artifactId: string } | { url: string }> {
  return refs.map((ref) => (ARTIFACT_ID_PATTERN.test(ref) ? { artifactId: ref } : { url: ref }));
}
