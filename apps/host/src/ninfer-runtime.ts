import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { FitzRuntimePaths } from "./runtime-paths.js";

const execFileAsync = promisify(execFile);

export const NINFER_RUNTIME_ID = "ninfer-linux";
export const NINFER_RUNTIME_DISTRIBUTION = "Fitz-NInfer";
export const NINFER_RUNTIME_GUEST_ROOT = "/opt/fitz/llm";

const KNOWN_MODELS = [
  { id: "qwen3.6-35b-a3b", fileName: "qwen3_6_35b_a3b.ninfer" },
  { id: "qwen3.6-27b", fileName: "qwen3_6_27b_nvfp4.ninfer" },
] as const;

export interface NInferRuntimeLayout {
  id: string;
  distribution: string;
  hostRoot: string;
  guestRoot: string;
  modelRoot: string;
  executable: string;
}

export interface NInferRuntimeModelStatus {
  id: string;
  fileName: string;
  sourcePresent: boolean;
  runtimePresent: boolean;
  sourceBytes?: number;
  runtimeBytes?: number;
}

export interface NInferRuntimeStatus {
  id: string;
  available: boolean;
  state: "unavailable" | "not-installed" | "working" | "ready" | "failed";
  stage: string;
  progress: number;
  detail: string;
  distribution: string;
  hostRoot: string;
  guestRoot: string;
  models: NInferRuntimeModelStatus[];
  operation?: "provision" | "migrate";
}

interface CommandResult { stdout: string; stderr: string }
type CommandRunner = (file: string, args: string[], options?: { timeout?: number }) => Promise<CommandResult>;

export interface NInferRuntimeManagerOptions {
  paths: FitzRuntimePaths;
  platform?: NodeJS.Platform;
  sourceDistribution?: string;
  run?: CommandRunner;
}

interface RuntimeManifest {
  schemaVersion: 1;
  id: string;
  distribution: string;
  guestRoot: string;
  provisionedAt: string;
  models: Array<{ id: string; fileName: string; bytes: number; sha256: string }>;
}

/** Owns the Linux-only NInfer runtime while keeping its physical VHDX inside
 * the normal Fitz `.llm` registry. All operations are idempotent and only one
 * mutation is admitted at a time. */
export class NInferRuntimeManager {
  readonly layout: NInferRuntimeLayout;
  readonly #paths: FitzRuntimePaths;
  readonly #platform: NodeJS.Platform;
  readonly #sourceDistribution: string;
  readonly #run: CommandRunner;
  #operation: Promise<void> | undefined;
  #working: NInferRuntimeStatus | undefined;
  #failure: string | undefined;

  constructor(options: NInferRuntimeManagerOptions) {
    this.#paths = options.paths;
    this.#platform = options.platform ?? process.platform;
    this.#sourceDistribution = options.sourceDistribution ?? "Ubuntu";
    this.#run = options.run ?? defaultCommandRunner;
    const hostRoot = resolve(join(options.paths.runtimeRoot, NINFER_RUNTIME_ID));
    assertInside(options.paths.llmRoot, hostRoot);
    this.layout = {
      id: NINFER_RUNTIME_ID,
      distribution: NINFER_RUNTIME_DISTRIBUTION,
      hostRoot,
      guestRoot: NINFER_RUNTIME_GUEST_ROOT,
      modelRoot: `${NINFER_RUNTIME_GUEST_ROOT}/models/ninfer`,
      executable: `${NINFER_RUNTIME_GUEST_ROOT}/engines/ninfer/ninfer-serve`,
    };
  }

  async status(): Promise<NInferRuntimeStatus> {
    if (this.#working) return this.#working;
    if (this.#platform !== "win32") return this.#base("unavailable", "unsupported", 0, "The managed NInfer runtime is available on Windows with WSL 2.", []);
    const installed = await this.#distributionInstalled();
    const models = installed ? await this.#modelStatus() : await this.#sourceModelStatus();
    if (this.#failure) return this.#base("failed", "failed", 0, this.#failure, models);
    if (!installed) return this.#base("not-installed", "not-installed", 0, "Set up the Linux runtime and move installed NInfer models into it.", models);
    const engineReady = await this.#guestTest("-x", this.layout.executable);
    const installedModels = models.filter((model) => model.sourcePresent || model.runtimePresent);
    const complete = engineReady && installedModels.length > 0 && installedModels.every((model) => model.runtimePresent);
    return this.#base(complete ? "ready" : "not-installed", complete ? "ready" : "migration-needed", complete ? 100 : 25, complete ? "NInfer is running from managed Linux storage." : "The runtime exists, but its engine or models still need migration.", models);
  }

  startProvisioning(moveModels = true): NInferRuntimeStatus {
    if (this.#platform !== "win32") throw new Error("Managed NInfer provisioning requires Windows with WSL 2");
    if (this.#operation) throw new Error("An NInfer runtime operation is already in progress");
    this.#failure = undefined;
    this.#working = this.#base("working", "starting", 1, "Preparing the managed Linux runtime…", [], "provision");
    this.#operation = this.#provision(moveModels)
      .catch((error) => { this.#failure = errorMessage(error); })
      .finally(() => { this.#operation = undefined; this.#working = undefined; });
    return this.#working;
  }

  async waitForIdle(): Promise<void> { await this.#operation; }

  async #provision(moveModels: boolean): Promise<void> {
    await mkdir(this.#paths.runtimeRoot, { recursive: true });
    if (!await this.#distributionInstalled()) {
      this.#setWorking("installing-wsl", 5, "Installing Ubuntu into .llm/runtimes/ninfer-linux…");
      await this.#run("wsl.exe", ["--install", "Ubuntu-24.04", "--name", this.layout.distribution, "--location", this.layout.hostRoot, "--no-launch", "--web-download"], { timeout: 20 * 60_000 });
    }
    this.#setWorking("installing-dependencies", 15, "Installing the NInfer runtime libraries…");
    await this.#guestShell("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ffmpeg libcurl4 && rm -rf /var/lib/apt/lists/*", 20 * 60_000);
    await this.#guestShell(`install -d -m 0755 ${shellQuote(this.layout.modelRoot)} ${shellQuote(dirname(this.layout.executable))} ${shellQuote(`${this.layout.guestRoot}/logs`)}`, 30_000);

    this.#setWorking("copying-cuda-runtime", 24, "Copying the small CUDA runtime dependency set…");
    await this.#copyCudaRuntime();

    const sourceEngine = resolve(join(this.#paths.engineRoot, "ninfer", "build", "apps", "ninfer-serve"));
    if (!existsSync(sourceEngine)) throw new Error(`NInfer executable was not found at ${sourceEngine}`);
    this.#setWorking("copying-engine", 27, "Installing the NInfer executable into the managed runtime…");
    await this.#guestShell(`install -m 0755 ${shellQuote(guestPath(sourceEngine))} ${shellQuote(this.layout.executable)}`, 120_000);

    const installedModels: RuntimeManifest["models"] = [];
    const candidates = [] as Array<{ id: string; fileName: string; source?: string; bytes: number }>;
    for (const known of KNOWN_MODELS) {
      const source = resolve(join(this.#paths.modelRoot, "ninfer", known.fileName));
      if (existsSync(source)) {
        candidates.push({ ...known, source, bytes: (await stat(source)).size });
        continue;
      }
      const runtimeBytes = await this.#guestSize(`${this.layout.modelRoot}/${known.fileName}`);
      if (runtimeBytes !== undefined) candidates.push({ ...known, bytes: runtimeBytes });
    }
    if (!candidates.length) throw new Error(`No NInfer model artifacts were found in ${join(this.#paths.modelRoot, "ninfer")}`);
    const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
    let completedBytes = 0;
    for (const candidate of candidates) {
      const destination = `${this.layout.modelRoot}/${candidate.fileName}`;
      const existingBytes = await this.#guestSize(destination);
      if (existingBytes !== candidate.bytes && candidate.source) {
        this.#setWorking("moving-models", 30 + Math.floor(60 * completedBytes / totalBytes), `Moving ${candidate.fileName} to Linux storage…`);
        await this.#guestShell(`rm -f ${shellQuote(`${destination}.partial`)} && dd if=${shellQuote(guestPath(candidate.source))} of=${shellQuote(`${destination}.partial`)} bs=64M conv=fsync status=none && mv ${shellQuote(`${destination}.partial`)} ${shellQuote(destination)}`, 60 * 60_000);
      }
      const copiedBytes = await this.#guestSize(destination);
      if (copiedBytes !== candidate.bytes) throw new Error(`Verification failed for ${candidate.fileName}: expected ${candidate.bytes} bytes, found ${copiedBytes}`);
      this.#setWorking("verifying-models", 90, `Verifying ${candidate.fileName}…`);
      const runtimeHash = (await this.#guestShell(`sha256sum ${shellQuote(destination)} | cut -d ' ' -f 1`, 60 * 60_000)).stdout.trim();
      if (!runtimeHash) throw new Error(`Checksum verification failed for ${candidate.fileName}`);
      if (candidate.source) {
        const sourceHash = await sha256File(candidate.source);
        if (runtimeHash !== sourceHash) throw new Error(`Checksum verification failed for ${candidate.fileName}`);
      }
      installedModels.push({ id: candidate.id, fileName: candidate.fileName, bytes: candidate.bytes, sha256: runtimeHash });
      completedBytes += candidate.bytes;
      if (moveModels && candidate.source) await rm(candidate.source);
    }
    const manifest: RuntimeManifest = { schemaVersion: 1, id: this.layout.id, distribution: this.layout.distribution, guestRoot: this.layout.guestRoot, provisionedAt: new Date().toISOString(), models: installedModels };
    await writeFile(join(this.layout.hostRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    this.#setWorking("ready", 100, "NInfer is ready on managed Linux storage.");
  }

  async #copyCudaRuntime(): Promise<void> {
    const archive = resolve(join(this.#paths.runtimeRoot, ".ninfer-cuda-runtime.tar"));
    assertInside(this.#paths.runtimeRoot, archive);
    try {
      await this.#run("wsl.exe", ["-d", this.#sourceDistribution, "-u", "root", "--", "sh", "-c", `set -eu; tar -chf ${shellQuote(guestPath(archive))} /usr/local/cuda-13.1/targets/x86_64-linux/lib/libcudart.so.13 /usr/local/cuda/targets/x86_64-linux/lib/libOpenCL.so.1`], { timeout: 120_000 });
      await this.#guestShell(`tar -xf ${shellQuote(guestPath(archive))} -C /`, 120_000);
    } finally {
      await rm(archive, { force: true });
    }
  }

  async #modelStatus(): Promise<NInferRuntimeModelStatus[]> {
    const values: NInferRuntimeModelStatus[] = [];
    for (const known of KNOWN_MODELS) {
      const source = resolve(join(this.#paths.modelRoot, "ninfer", known.fileName));
      const sourceBytes = existsSync(source) ? (await stat(source)).size : undefined;
      const runtimeBytes = await this.#guestSize(`${this.layout.modelRoot}/${known.fileName}`);
      values.push({ ...known, sourcePresent: sourceBytes !== undefined, runtimePresent: runtimeBytes !== undefined, ...(sourceBytes !== undefined ? { sourceBytes } : {}), ...(runtimeBytes !== undefined ? { runtimeBytes } : {}) });
    }
    return values;
  }

  async #sourceModelStatus(): Promise<NInferRuntimeModelStatus[]> {
    const values: NInferRuntimeModelStatus[] = [];
    for (const known of KNOWN_MODELS) {
      const source = resolve(join(this.#paths.modelRoot, "ninfer", known.fileName));
      const sourceBytes = existsSync(source) ? (await stat(source)).size : undefined;
      values.push({ ...known, sourcePresent: sourceBytes !== undefined, runtimePresent: false, ...(sourceBytes !== undefined ? { sourceBytes } : {}) });
    }
    return values;
  }

  async #distributionInstalled(): Promise<boolean> {
    try {
      const result = await this.#run("wsl.exe", ["--list", "--quiet"], { timeout: 15_000 });
      return result.stdout.replaceAll("\0", "").split(/\r?\n/).map((value) => value.trim()).includes(this.layout.distribution);
    } catch { return false; }
  }

  async #guestTest(flag: "-x" | "-f", path: string): Promise<boolean> {
    try { await this.#run("wsl.exe", ["-d", this.layout.distribution, "-u", "root", "--", "test", flag, path], { timeout: 15_000 }); return true; }
    catch { return false; }
  }

  async #guestSize(path: string): Promise<number | undefined> {
    try {
      const result = await this.#run("wsl.exe", ["-d", this.layout.distribution, "-u", "root", "--", "stat", "-c", "%s", path], { timeout: 15_000 });
      const value = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(value) ? value : undefined;
    } catch { return undefined; }
  }

  #guestShell(command: string, timeout: number): Promise<CommandResult> {
    return this.#run("wsl.exe", ["-d", this.layout.distribution, "-u", "root", "--", "sh", "-c", command], { timeout });
  }

  #setWorking(stage: string, progress: number, detail: string): void {
    this.#working = this.#base("working", stage, progress, detail, this.#working?.models ?? [], this.#working?.operation ?? "provision");
  }

  #base(state: NInferRuntimeStatus["state"], stage: string, progress: number, detail: string, models: NInferRuntimeModelStatus[], operation?: NInferRuntimeStatus["operation"]): NInferRuntimeStatus {
    return { id: this.layout.id, available: this.#platform === "win32", state, stage, progress, detail, distribution: this.layout.distribution, hostRoot: this.layout.hostRoot, guestRoot: this.layout.guestRoot, models, ...(operation ? { operation } : {}) };
  }
}

async function defaultCommandRunner(file: string, args: string[], options: { timeout?: number } = {}): Promise<CommandResult> {
  const result = await execFileAsync(file, args, { windowsHide: true, timeout: options.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function assertInside(parent: string, target: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel.startsWith("..") || resolve(parent) === resolve(target)) throw new Error(`Path escapes managed runtime root: ${target}`);
}

function guestPath(hostPath: string): string {
  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (!windowsPath) return hostPath.replaceAll("\\", "/");
  return `/mnt/${windowsPath[1]!.toLowerCase()}/${windowsPath[2]!.replaceAll("\\", "/")}`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
