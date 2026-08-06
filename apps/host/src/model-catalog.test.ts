import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCatalogService, pickGgufFile } from "./model-catalog.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function temporaryModelRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fitz-models-"));
  temporaryDirectories.push(dir);
  return dir;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function streamResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

/** Records every request URL + headers so tests can assert Range/resume behavior. */
function recordFetch(requests: Array<{ url: string; headers: Record<string, string> }>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key, String(value)]));
    requests.push({ url, headers });
    if (url.includes("/resolve/")) return streamResponse(["hello ", "world"], 200, { "content-length": "11" });
    if (url.includes("/api/models?")) return jsonResponse({ count: 1, items: [{ id: "Qwen/Qwen2.5-7B-Instruct-GGUF", downloads: 10, likes: 2, pipeline_tag: "text-generation" }] });
    if (url.includes("/api/models/")) return jsonResponse({ siblings: [{ rfilename: "model-q4_k_m.gguf", size: 1024 }, { rfilename: "model-f16.gguf", size: 2048 }] });
    return jsonResponse({}, 404);
  };
}

async function waitForStatus(service: ModelCatalogService, id: string, timeoutMs = 5_000): Promise<Awaited<ReturnType<ModelCatalogService["progress"]>>> {
  const deadline = Date.now() + timeoutMs;
  let record = service.progress(id);
  while (record.status === "active" && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    record = service.progress(id);
  }
  return record;
}

describe("ModelCatalogService", () => {
  it("maps the Hugging Face catalog search", async () => {
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async () => jsonResponse({ count: 1, items: [{ id: "Qwen/Qwen2.5-7B-Instruct-GGUF", downloads: 1234, likes: 56, pipeline_tag: "text-generation", createdAt: "2024-12-01T00:00:00Z", lastModified: "2025-01-01T00:00:00Z" }] }),
    });
    const result = await service.search("qwen", 0, 10);
    expect(result).toEqual({ total: 1, models: [expect.objectContaining({ id: "Qwen/Qwen2.5-7B-Instruct-GGUF", downloads: 1234, likes: 56, pipelineTag: "text-generation", createdAt: "2024-12-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" })] });
  });

  it("accepts the plain-array form of the catalog response", async () => {
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async () => jsonResponse([{ id: "org/model", downloads: 5, likes: 0 }]),
    });
    const result = await service.search("", 0, 10);
    expect(result.total).toBe(1);
    expect(result.models[0]?.id).toBe("org/model");
  });

  it("filters the catalog by pipeline tag", async () => {
    const requested: string[] = [];
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return jsonResponse({ count: 0, items: [] }); },
    });
    await service.search("", 0, 10, "feature-extraction");
    await service.search("", 0, 10);
    expect(requested[0]).toContain("pipeline_tag=feature-extraction");
    expect(requested[1]).toContain("pipeline_tag=text-generation");
  });

  it("maps the shared sort keys to Hugging Face sort params", async () => {
    const requested: string[] = [];
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return jsonResponse({ count: 0, items: [] }); },
    });
    await service.search("", 0, 10, "text-generation", "downloads", "desc");
    await service.search("", 0, 10, "text-generation", "updated", "desc");
    await service.search("", 0, 10, "text-generation", "name", "asc");
    await service.search("", 0, 10, "text-generation", "likes", "desc");
    expect(requested[0]).toContain("sort=downloads");
    expect(requested[0]).toContain("direction=-1");
    expect(requested[1]).toContain("sort=lastModified");
    expect(requested[1]).toContain("direction=-1");
    expect(requested[2]).toContain("sort=name");
    expect(requested[2]).toContain("direction=1");
    expect(requested[3]).toContain("sort=likes");
    expect(requested[3]).toContain("direction=-1");
  });

  it("skips models below the minimum likes and downloads thresholds", async () => {
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async () => jsonResponse([
        { id: "org/small", downloads: 50, likes: 2 },
        { id: "org/popular", downloads: 50_000, likes: 900 },
        { id: "org/liked", downloads: 2_000, likes: 1_500 },
      ]),
    });
    const result = await service.search("", 0, 10, "text-generation", "downloads", "desc", 100, 1000);
    expect(result.models.map((entry) => entry.id)).toEqual(["org/popular", "org/liked"]);
    expect(result.total).toBe(2);
  });

  it("pages the filtered window without overlap and an exact total", async () => {
    const requested: string[] = [];
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: `org/model-${i}`, downloads: 1000, likes: 10 })));
      },
    });
    const first = await service.search("", 0, 30);
    expect(first.models.map((entry) => entry.id)).toEqual(Array.from({ length: 30 }, (_, i) => `org/model-${i}`));
    expect(first.total).toBe(100);
    const next = await service.search("", 30, 30);
    expect(next.models.map((entry) => entry.id)).toEqual(Array.from({ length: 30 }, (_, i) => `org/model-${30 + i}`));
    expect(next.total).toBe(100);
    // HF ignores `offset`, so the whole window is fetched once and reused for both pages.
    expect(requested).toHaveLength(1);
  });

  it("keeps only models released within the last weeks", async () => {
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async () => jsonResponse([
        { id: "org/fresh", downloads: 1000, likes: 10, createdAt: new Date(now - week).toISOString() },
        { id: "org/borderline", downloads: 1000, likes: 10, createdAt: new Date(now - 3 * week).toISOString() },
        { id: "org/ancient", downloads: 1000, likes: 10, createdAt: new Date(now - 52 * week).toISOString() },
        { id: "org/dateless", downloads: 1000, likes: 10 },
      ]),
    });
    const result = await service.search("", 0, 10, "text-generation", "downloads", "desc", 0, 0, 4);
    expect(result.models.map((entry) => entry.id)).toEqual(["org/fresh", "org/borderline"]);
    expect(result.total).toBe(2);
  });

  it("reuses the cached window across threshold changes", async () => {
    const requested: string[] = [];
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return jsonResponse([
          { id: "org/small", downloads: 50, likes: 2 },
          { id: "org/popular", downloads: 50_000, likes: 900 },
        ]);
      },
    });
    const unfiltered = await service.search("", 0, 10);
    expect(unfiltered.total).toBe(2);
    const filtered = await service.search("", 0, 10, "text-generation", "downloads", "desc", 100, 1000);
    expect(filtered.total).toBe(1);
    expect(filtered.models.map((entry) => entry.id)).toEqual(["org/popular"]);
    expect(requested).toHaveLength(1);
  });

  it("re-fetches the window when the query or sort changes", async () => {
    const requested: string[] = [];
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return jsonResponse([]); },
    });
    await service.search("qwen");
    await service.search("qwen"); // same query/sort → cached
    await service.search("gemma");
    await service.search("", 0, 10, "text-generation", "likes", "desc");
    expect(requested).toHaveLength(3);
  });

  it("lists the GGUF files of a model repository", async () => {
    const service = new ModelCatalogService({
      modelRoot: await temporaryModelRoot(),
      fetch: async () => jsonResponse({ siblings: [{ rfilename: "README.md" }, { rfilename: "model-q4_k_m.gguf", size: 1024 }, { rfilename: "model-f16.gguf", size: 2048 }] }),
    });
    const files = await service.files("Qwen/Qwen2.5-7B-Instruct-GGUF");
    expect(files).toEqual([{ path: "model-q4_k_m.gguf", size: 1024 }, { path: "model-f16.gguf", size: 2048 }]);
  });

  it("prefers Q4_K_M, then Q4_0, then the largest GGUF file", () => {
    expect(pickGgufFile([{ path: "a.gguf", size: 1 }, { path: "b-q4_k_m.gguf", size: 2 }])?.path).toBe("b-q4_k_m.gguf");
    expect(pickGgufFile([{ path: "a.gguf", size: 1 }, { path: "b-q4_0.gguf", size: 2 }])?.path).toBe("b-q4_0.gguf");
    expect(pickGgufFile([{ path: "a.gguf", size: 1 }, { path: "b.gguf", size: 3 }])?.path).toBe("b.gguf");
    expect(pickGgufFile([{ path: "README.md" }])).toBeUndefined();
  });

  it("downloads a model into the model root and reports progress", async () => {
    const modelRoot = await temporaryModelRoot();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const service = new ModelCatalogService({ modelRoot, fetch: recordFetch(requests) });

    const started = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    expect(started.status).toBe("active");
    expect(started.fileName).toBe("model-q4_k_m.gguf");
    expect(requests.some((request) => request.url.includes("/resolve/main/model-q4_k_m.gguf"))).toBe(true);

    const record = await waitForStatus(service, started.id);
    expect(record.status).toBe("done");
    expect(record.total).toBe(11);
    expect(record.received).toBe(11);
    expect(await readFile(join(modelRoot, "Qwen", "Qwen2.5-7B-Instruct-GGUF", "model-q4_k_m.gguf"), "utf8")).toBe("hello world");
    expect(await service.downloaded()).toEqual([
      expect.objectContaining({ repoId: "Qwen/Qwen2.5-7B-Instruct-GGUF", fileName: "model-q4_k_m.gguf", size: 11 }),
    ]);
  });

  it("resumes an interrupted download from the partial file", async () => {
    const modelRoot = await temporaryModelRoot();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const service = new ModelCatalogService({
      modelRoot,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([key, value]) => [key, String(value)]));
        requests.push({ url, headers });
        if (url.includes("/resolve/")) {
          const range = headers.range;
          if (range === "bytes=6-") return streamResponse(["world"], 206, { "content-length": "5" });
          return streamResponse(["hello ", "world"], 200, { "content-length": "11" });
        }
        if (url.includes("/api/models/")) return jsonResponse({ siblings: [{ rfilename: "model-q4_k_m.gguf", size: 1024 }] });
        return jsonResponse({}, 404);
      },
    });
    const repoDir = join(modelRoot, "Qwen", "Qwen2.5-7B-Instruct-GGUF");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "model-q4_k_m.gguf.part"), "hello ", "utf8");

    const started = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    const record = await waitForStatus(service, started.id);
    expect(record.status).toBe("done");
    expect(record.received).toBe(11);
    expect(record.total).toBe(11);
    expect(await readFile(join(repoDir, "model-q4_k_m.gguf"), "utf8")).toBe("hello world");
    expect(requests.some((request) => request.headers.range === "bytes=6-")).toBe(true);
  });

  it("cancels an active download and keeps the partial file for later", async () => {
    const modelRoot = await temporaryModelRoot();
    let openController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const service = new ModelCatalogService({
      modelRoot,
      fetch: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/resolve/")) {
          return new Response(new ReadableStream<Uint8Array>({ start(controller) { openController = controller; controller.enqueue(new TextEncoder().encode("partial")); } }), { status: 200 });
        }
        if (url.includes("/api/models/")) return jsonResponse({ siblings: [{ rfilename: "model-q4_k_m.gguf", size: 1024 }] });
        return jsonResponse({}, 404);
      },
    });

    const started = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    await service.cancel(started.id);
    expect(service.progress(started.id).status).toBe("cancelled");
    expect(service.list()).toEqual([]);
    openController?.close();
    expect(await service.downloaded()).toEqual([]);
  });

  it("rejects an already-downloaded model and reuses an active download", async () => {
    const modelRoot = await temporaryModelRoot();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const service = new ModelCatalogService({ modelRoot, fetch: recordFetch(requests) });

    const first = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    const second = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    expect(second.id).toBe(first.id);
    await waitForStatus(service, first.id);

    await expect(service.start("Qwen/Qwen2.5-7B-Instruct-GGUF")).rejects.toThrow("already downloaded");
  });

  it("deletes a downloaded model and prunes empty parent folders", async () => {
    const modelRoot = await temporaryModelRoot();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const service = new ModelCatalogService({ modelRoot, fetch: recordFetch(requests) });
    const started = await service.start("Qwen/Qwen2.5-7B-Instruct-GGUF");
    await waitForStatus(service, started.id);

    await service.removeDownloaded("Qwen/Qwen2.5-7B-Instruct-GGUF", "model-q4_k_m.gguf");
    expect(await service.downloaded()).toEqual([]);
    await expect(readFile(join(modelRoot, "Qwen", "Qwen2.5-7B-Instruct-GGUF", "model-q4_k_m.gguf"))).rejects.toThrow();
    // The now-empty repo and org folders are removed too, but the model root stays.
    expect(await readdir(modelRoot)).toEqual([]);
  });

  it("rejects repository and file names that escape the model root", async () => {
    const service = new ModelCatalogService({ modelRoot: await temporaryModelRoot() });
    await expect(service.files("../escape")).rejects.toThrow("owner/name");
    await expect(service.start("Qwen/../../escape")).rejects.toThrow("owner/name");
    await expect(service.start("Qwen/Qwen2.5-7B-Instruct-GGUF", "../model.gguf")).rejects.toThrow(".gguf");
    await expect(service.removeDownloaded("Qwen/..", "model.gguf")).rejects.toThrow("owner/name");
  });
});
