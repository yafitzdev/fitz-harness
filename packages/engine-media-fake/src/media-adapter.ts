import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { type FakeInstanceHandle } from "@fitz/engine-fake";
import type {
  LaunchSpec,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaModality,
  Recipe,
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";
import type {
  InstanceInspection,
  MediaEngineAdapter,
  MediaJobHandle,
  MediaJobPoll,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";

export interface FakeMediaEngineOptions {
  /** How much progress each poll advances a job (default 0.25). */
  progressPerPoll?: number;
  /** Any job whose prompt contains this string fails at poll time. */
  failWhenPromptIncludes?: string;
  /** When set, completed jobs return `{ url }` results pointing at
   *  `${resultUrl}/<modality>` instead of inline bytes — exercising the
   *  coordinator's host-side download path (design doc §5.11). The target
   *  should serve the canonical `deterministicMediaBytes` for the modality,
   *  as `fixtures/media/fake-media-server.mjs` does. */
  resultUrl?: string;
  /** When set, completed jobs return inline bytes padded to exactly this many
   *  bytes — exercising the coordinator's kind-aware artifact caps (design doc
   *  §5.11, PR 8). */
  resultByteLength?: number;
}

const MIME_TYPES: Record<MediaModality, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/wav",
};

/** Canonical deterministic bytes per modality: small, well-formed containers
 *  (1x1 PNG, minimal WAV, minimal MP4) so the whole pipeline — including any
 *  future parsing of artifact bytes — runs on realistic content. Immutable by
 *  convention; tests compare copies. */
const CANONICAL_BYTES: Record<MediaModality, Uint8Array> = {
  image: png1x1(),
  video: mp4Minimal(),
  audio: wavMinimal(),
};

export function deterministicMediaBytes(modality: MediaModality): Uint8Array {
  return CANONICAL_BYTES[modality];
}

export function mimeTypeFor(modality: MediaModality): string {
  return MIME_TYPES[modality];
}

/** The result a completed job yields for a modality. With `resultUrl` set the
 *  data is a provider-style download URL instead of inline bytes. */
export function mediaResultFor(modality: MediaModality, resultUrl?: string): MediaGenerationResult {
  const bytes = deterministicMediaBytes(modality);
  const mimeType = MIME_TYPES[modality];
  if (resultUrl) {
    return { data: { url: `${resultUrl.replace(/\/+$/, "")}/${modality}` }, mimeType, byteSize: bytes.byteLength };
  }
  return { data: bytes, mimeType, byteSize: bytes.byteLength };
}

/** Deterministic in-process MediaEngineAdapter: GPU-free submit/poll/cancel
 *  with failure injection and an optional URL-result mode. Mirrors the
 *  observation style of `packages/engine-fake` (starts/submitted/cancelled/
 *  stops/preparations) so host integration tests can assert engine contact. */
export class FakeMediaEngineAdapter implements MediaEngineAdapter<FakeInstanceHandle> {
  readonly id = "media-fake";
  readonly modalities: MediaModality[] = ["image", "video", "audio"];
  readonly defaultPollIntervalMs = 1;
  readonly starts: FakeInstanceHandle[] = [];
  readonly preparations: string[] = [];
  readonly submitted: MediaGenerationRequest[] = [];
  readonly cancelled: Array<{ instanceId: string; jobId: string }> = [];
  readonly stops: Array<{ instanceId: string; mode: StopMode }> = [];
  readonly #progressPerPoll: number;
  readonly #failWhenPromptIncludes: string | undefined;
  readonly #resultUrl: string | undefined;
  readonly #resultByteLength: number | undefined;
  readonly #jobs = new Map<string, { request: MediaGenerationRequest; progress: number }>();

  /** The deterministic fake performs no host GPU work, so host thermal policy
   *  must not invoke real NVIDIA controls during integration tests. */
  executionLocation(): "remote" { return "remote"; }

  constructor(options: FakeMediaEngineOptions = {}) {
    this.#progressPerPoll = options.progressPerPoll ?? 0.25;
    this.#failWhenPromptIncludes = options.failWhenPromptIncludes;
    this.#resultUrl = options.resultUrl;
    this.#resultByteLength = options.resultByteLength;
  }

  async prepare(recipe: Recipe, _signal: AbortSignal): Promise<void> {
    this.preparations.push(recipe.id);
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    return recipe.adapter === this.id
      ? { valid: true, issues: [] }
      : {
          valid: false,
          issues: [{ level: "error", code: "adapter_mismatch", message: `Recipe adapter must be ${this.id}` }],
        };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> {
    return { vramMiB: 0, ramMiB: 16 };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    return {
      executable: "fitz-fake-media-engine",
      args: ["--model", recipe.modelId, "--port", String(allocation.port)],
      env: {},
      internalHost: allocation.host,
      internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<FakeInstanceHandle> {
    if (signal.aborted) throw abortError();
    const handle: FakeInstanceHandle = {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`,
      startedAt: new Date(),
      stopped: false,
    };
    this.starts.push(handle);
    return handle;
  }

  async waitUntilReady(instance: FakeInstanceHandle, _signal: AbortSignal): Promise<ReadyInfo> {
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  async submit(
    _instance: FakeInstanceHandle,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): Promise<MediaJobHandle> {
    if (signal.aborted) throw abortError();
    this.submitted.push(structuredClone(request));
    const jobId = `provider-${this.submitted.length}`;
    this.#jobs.set(jobId, { request, progress: 0 });
    return { id: jobId, modality: request.modality };
  }

  async poll(_instance: FakeInstanceHandle, job: MediaJobHandle, signal: AbortSignal): Promise<MediaJobPoll> {
    if (signal.aborted) throw abortError();
    const record = this.#jobs.get(job.id);
    if (!record) return { status: "cancelled" };
    if (this.#failWhenPromptIncludes && record.request.params.prompt.includes(this.#failWhenPromptIncludes)) {
      this.#jobs.delete(job.id);
      return { status: "failed", error: "Fake media engine configured request failure" };
    }
    record.progress = Math.min(1, record.progress + this.#progressPerPoll);
    if (record.progress >= 1) {
      this.#jobs.delete(job.id);
      const result = mediaResultFor(record.request.modality, this.#resultUrl);
      if (this.#resultByteLength !== undefined && result.data instanceof Uint8Array) {
        const padded = new Uint8Array(this.#resultByteLength);
        padded.set(result.data);
        return { status: "completed", progress: 1, result: { data: padded, mimeType: result.mimeType, byteSize: padded.byteLength } };
      }
      return { status: "completed", progress: 1, result };
    }
    return { status: "progressing", progress: record.progress };
  }

  async cancel(instance: FakeInstanceHandle, job: MediaJobHandle): Promise<void> {
    this.cancelled.push({ instanceId: instance.id, jobId: job.id });
    this.#jobs.delete(job.id);
  }

  async stop(instance: FakeInstanceHandle, mode: StopMode): Promise<StopReport> {
    instance.stopped = true;
    this.stops.push({ instanceId: instance.id, mode });
    return { stopped: true };
  }

  async inspect(instance: FakeInstanceHandle): Promise<InstanceInspection> {
    return {
      healthy: !instance.stopped,
      modelId: instance.modelId,
      ...(instance.stopped ? { detail: "stopped" } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic container builders
// ---------------------------------------------------------------------------

/** A real 1x1 8-bit RGBA PNG (transparent black), built the same way in the
 *  fixture server (`fixtures/media/fake-media-server.mjs`) so a URL-fetched
 *  artifact can be asserted equal to the canonical inline bytes. */
function png1x1(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]); // 1x1, 8-bit, RGBA, deflate, adaptive, none
  const idat = new Uint8Array(deflateSync(Buffer.from([0, 0, 0, 0, 0]))); // filter 0 + RGBA(0,0,0,0)
  return concat(signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array()));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const crc = crc32(concat(textBytes(type), data));
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(textBytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal valid WAV: 44-byte header + 8 samples of 8-bit mono 8 kHz audio. */
function wavMinimal(): Uint8Array {
  const samples = new Uint8Array([128, 128, 129, 127, 126, 130, 128, 128]);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(textBytes("RIFF"), 0);
  view.setUint32(4, 36 + samples.length, true);
  header.set(textBytes("WAVE"), 8);
  header.set(textBytes("fmt "), 12);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  header.set(textBytes("data"), 36);
  view.setUint32(40, samples.length, true); // data chunk size
  return concat(header, samples);
}

/** A minimal well-formed MP4: ftyp + moov (one 1x1 video track) + mdat holding
 *  a single fake sample. Box sizes are computed programmatically so the
 *  container is internally consistent; no decoder runs on it in tests. */
function mp4Minimal(): Uint8Array {
  const sample = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0]);
  const ftyp = box("ftyp", concat(textBytes("isom"), u32(0), textBytes("isom"), textBytes("mp42")));
  const placeholder = box("moov", mvhd(), trak(0));
  const chunkOffset = ftyp.length + placeholder.length + 8; // start of mdat payload
  const moov = box("moov", mvhd(), trak(chunkOffset));
  return concat(ftyp, moov, box("mdat", sample));
}

function mvhd(): Uint8Array {
  return fullBox(
    "mvhd",
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1000), // timescale
    u32(1), // duration
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume
    u16(0), // reserved
    u32(0), u32(0), // reserved
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000), // identity matrix
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
    u32(2), // next_track_id
  );
}

function trak(chunkOffset: number): Uint8Array {
  return box("trak", tkhd(), mdia(chunkOffset));
}

function tkhd(): Uint8Array {
  return fullBox(
    "tkhd",
    0x000003, // enabled + in movie
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1), // track_id
    u32(0), // reserved
    u32(1), // duration
    u32(0), u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0x0100), // volume
    u16(0), // reserved
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000), // identity matrix
    u32(0x00010000), // width 1.0
    u32(0x00010000), // height 1.0
  );
}

function mdia(chunkOffset: number): Uint8Array {
  return box("mdia", mdhd(), hdlr(), minf(chunkOffset));
}

function mdhd(): Uint8Array {
  return fullBox("mdhd", 0, u32(0), u32(0), u32(1000), u32(1), u16(0x55c4), u16(0));
}

function hdlr(): Uint8Array {
  return fullBox("hdlr", 0, u32(0), textBytes("vide"), u32(0), u32(0), u32(0), concat(textBytes("VideoHandler"), u8(0)));
}

function minf(chunkOffset: number): Uint8Array {
  return box("minf", vmhd(), dinf(), stbl(chunkOffset));
}

function vmhd(): Uint8Array {
  return fullBox("vmhd", 1, u16(0), u16(0), u16(0), u16(0));
}

function dinf(): Uint8Array {
  return box("dinf", fullBox("dref", 0, u32(1), box("url ", u32(1))));
}

function stbl(chunkOffset: number): Uint8Array {
  return box("stbl", stsd(), stts(), stsc(), stsz(6), stco(chunkOffset));
}

function stsd(): Uint8Array {
  return fullBox("stsd", 0, u32(1), avc1());
}

function avc1(): Uint8Array {
  return box(
    "avc1",
    u32(0), u16(0), // reserved (6 bytes)
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0), u32(0), u32(0), // pre_defined (12 bytes)
    u16(1), // width
    u16(1), // height
    u32(0x00480000), // horizresolution
    u32(0x00480000), // vertresolution
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressor name
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC(),
  );
}

function avcC(): Uint8Array {
  return fullBox(
    "avcC",
    0,
    u8(1), // configurationVersion
    u8(0x42), // AVCProfileIndication (Baseline)
    u8(0), // profile_compatibility
    u8(0x1e), // AVCLevelIndication
    u8(0xff), // lengthSizeMinusOne = 3
    u8(0xe1), // numOfSequenceParameterSets = 1
    u16(4), // SPS length
    new Uint8Array([0x67, 0x42, 0x00, 0x1e]), // fake SPS
    u8(1), // numOfPictureParameterSets
    u16(1), // PPS length
    new Uint8Array([0x68]), // fake PPS
  );
}

function stts(): Uint8Array {
  return fullBox("stts", 0, u32(0));
}

function stsc(): Uint8Array {
  return fullBox("stsc", 0, u32(0));
}

function stsz(sampleSize: number): Uint8Array {
  return fullBox("stsz", 0, u32(sampleSize), u32(1));
}

function stco(chunkOffset: number): Uint8Array {
  return fullBox("stco", 0, u32(1), u32(chunkOffset));
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  out.set(textBytes(type), 4);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}

function fullBox(type: string, versionFlags: number, ...children: Uint8Array[]): Uint8Array {
  return box(type, concat(u32(versionFlags), ...children));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
