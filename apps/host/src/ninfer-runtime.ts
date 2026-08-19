import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import {
  managedLinuxRuntimeLayout,
  mergeManagedLinuxRuntimeComponent,
  type ManagedLinuxRuntimeManifest,
  type ManagedLinuxRuntimeLayout,
} from "./managed-linux-runtime.js";
import { NINFER_MODEL_PROFILES } from "./ninfer-model-profiles.js";

const execFileAsync = promisify(execFile);

const KNOWN_MODELS = NINFER_MODEL_PROFILES.map(({ registrationId: id, fileName }) => ({ id, fileName }));

export interface NInferRuntimeLayout extends ManagedLinuxRuntimeLayout {
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

export interface NInferRuntimeManifestModel {
  id: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

export interface NInferModelRegistration {
  schemaVersion: 1;
  id: string;
  engine: "ninfer";
  format: "ninfer";
  payload: {
    backend: "runtime-filesystem";
    runtimeId: string;
    path: string;
  };
  bytes: number;
  sha256: string;
}

export function createNInferModelRegistration(model: NInferRuntimeManifestModel, layout: NInferRuntimeLayout): NInferModelRegistration {
  return {
    schemaVersion: 1,
    id: model.id,
    engine: "ninfer",
    format: "ninfer",
    payload: {
      backend: "runtime-filesystem",
      runtimeId: layout.id,
      path: `${layout.modelRoot}/${model.fileName}`,
    },
    bytes: model.bytes,
    sha256: model.sha256,
  };
}

/** Owns NInfer inside the shared inference distro. The distro's host-side VHDX
 * is application infrastructure; the canonical `.llm` registry is its guest
 * filesystem at `/opt/fitz/llm`. */
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
    const shared = managedLinuxRuntimeLayout(options.paths);
    const hostRoot = shared.hostRoot;
    assertInside(options.paths.runtimeRoot, hostRoot);
    this.layout = {
      ...shared,
      modelRoot: `${shared.modelRoot}/ninfer`,
      executable: `${shared.environmentRoot}/ninfer/bin/ninfer-serve`,
    };
  }

  async status(): Promise<NInferRuntimeStatus> {
    if (this.#working) return this.#working;
    if (this.#platform !== "win32") return this.#base("unavailable", "unsupported", 0, "The managed NInfer runtime is available on Windows with WSL 2.", []);
    const installed = await this.#distributionInstalled();
    const models = installed ? await this.#modelStatus() : await this.#sourceModelStatus();
    if (this.#failure) return this.#base("failed", "failed", 0, this.#failure, models);
    if (!installed) return this.#base("not-installed", "not-installed", 0, "Set up the canonical inference runtime.", models);
    const engineReady = await this.#guestTest("-x", this.layout.executable);
    const installedModels = models.filter((model) => model.sourcePresent || model.runtimePresent);
    const complete = engineReady && installedModels.length > 0 && installedModels.every((model) => model.runtimePresent);
    return this.#base(complete ? "ready" : "not-installed", complete ? "ready" : "migration-needed", complete ? 100 : 25, complete ? "Ready." : "The NInfer engine or its registered models are incomplete.", models);
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

  async #provision(_moveModels: boolean): Promise<void> {
    await mkdir(this.#paths.runtimeRoot, { recursive: true });
    if (!await this.#distributionInstalled()) {
      this.#setWorking("installing-wsl", 5, `Installing the shared Linux runtime into Fitz application storage…`);
      await this.#run("wsl.exe", ["--install", "Ubuntu-24.04", "--name", this.layout.distribution, "--location", this.layout.hostRoot, "--no-launch", "--web-download"], { timeout: 20 * 60_000 });
    }
    this.#setWorking("installing-dependencies", 15, "Installing the NInfer runtime libraries…");
    await this.#guestShell("apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ffmpeg libcurl4 && rm -rf /var/lib/apt/lists/*", 20 * 60_000);
    await this.#guestShell(`install -d -m 0755 ${shellQuote(this.layout.modelRoot)} ${shellQuote(dirname(this.layout.executable))} ${shellQuote(`${this.layout.guestRoot}/logs`)}`, 30_000);

    this.#setWorking("copying-cuda-runtime", 24, "Copying the small CUDA runtime dependency set…");
    await this.#copyCudaRuntime();

    if (!await this.#guestTest("-x", this.layout.executable)) {
      const builtExecutable = `${this.layout.engineRoot}/ninfer/build/apps/ninfer-serve`;
      if (!await this.#guestTest("-f", builtExecutable)) throw new Error(`NInfer executable was not found at ${this.layout.executable}`);
      this.#setWorking("installing-engine", 27, "Installing the NInfer executable inside the registry…");
      await this.#guestShell(`install -m 0755 ${shellQuote(builtExecutable)} ${shellQuote(this.layout.executable)}`, 120_000);
    }

    const installedModels: NInferRuntimeManifestModel[] = [];
    const candidates = [] as Array<{ id: string; fileName: string; bytes: number }>;
    for (const known of KNOWN_MODELS) {
      const runtimeBytes = await this.#guestSize(`${this.layout.modelRoot}/${known.fileName}`);
      if (runtimeBytes !== undefined) candidates.push({ ...known, bytes: runtimeBytes });
    }
    if (!candidates.length) throw new Error(`No NInfer model artifacts were found in ${this.layout.modelRoot}`);
    const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
    let completedBytes = 0;
    for (const candidate of candidates) {
      const destination = `${this.layout.modelRoot}/${candidate.fileName}`;
      const copiedBytes = await this.#guestSize(destination);
      if (copiedBytes !== candidate.bytes) throw new Error(`Verification failed for ${candidate.fileName}: expected ${candidate.bytes} bytes, found ${copiedBytes}`);
      this.#setWorking("verifying-models", 90, `Verifying ${candidate.fileName}…`);
      const runtimeHash = (await this.#guestShell(`sha256sum ${shellQuote(destination)} | cut -d ' ' -f 1`, 60 * 60_000)).stdout.trim();
      if (!runtimeHash) throw new Error(`Checksum verification failed for ${candidate.fileName}`);
      installedModels.push({ id: candidate.id, fileName: candidate.fileName, bytes: candidate.bytes, sha256: runtimeHash });
      completedBytes += candidate.bytes;
    }
    const manifestPath = join(this.#paths.llmRoot, "manifest.json");
    const existingManifest = await readRuntimeManifest(manifestPath);
    const manifest = mergeManagedLinuxRuntimeComponent(this.layout, "ninfer", {
      enginePath: this.layout.executable,
      modelRoot: this.layout.modelRoot,
      models: installedModels,
    }, existingManifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const registrationRoot = resolve(join(this.#paths.modelRoot, "ninfer"));
    assertInside(this.#paths.modelRoot, registrationRoot);
    await mkdir(registrationRoot, { recursive: true });
    await Promise.all(installedModels.map(async (model) => {
      const registrationPath = resolve(join(registrationRoot, `${model.id}.json`));
      assertInside(registrationRoot, registrationPath);
      await writeFile(registrationPath, `${JSON.stringify(createNInferModelRegistration(model, this.layout), null, 2)}\n`, "utf8");
    }));
    this.#setWorking("ready", 100, "Ready.");
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
      const runtimeBytes = await this.#guestSize(`${this.layout.modelRoot}/${known.fileName}`);
      values.push({ ...known, sourcePresent: false, runtimePresent: runtimeBytes !== undefined, ...(runtimeBytes !== undefined ? { runtimeBytes } : {}) });
    }
    return values;
  }

  async #sourceModelStatus(): Promise<NInferRuntimeModelStatus[]> {
    return KNOWN_MODELS.map((known) => ({ ...known, sourcePresent: false, runtimePresent: false }));
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

async function readRuntimeManifest(path: string): Promise<ManagedLinuxRuntimeManifest | undefined> {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as ManagedLinuxRuntimeManifest;
  if (!value || value.schemaVersion !== 2 || typeof value.components !== "object" || value.components === null) {
    throw new Error(`Invalid managed Linux runtime manifest: ${path}`);
  }
  return value;
}
