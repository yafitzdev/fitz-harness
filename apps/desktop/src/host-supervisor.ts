import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";

interface HostHealth {
  status: string;
  protocolVersion: string;
  hostContractVersion: string;
}

export interface HostSupervisorOptions {
  origin: URL;
  packaged: boolean;
  resourcesPath: string;
  fetch?: typeof globalThis.fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

export class HostStartupError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "HostStartupError";
  }
}

/** Owns the local host startup contract. A reachable but incompatible process
 * is never treated as healthy and is never killed because it may be user-owned. */
export class HostSupervisor {
  readonly #options: HostSupervisorOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: HostSupervisorOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async ensureReady(): Promise<void> {
    const initial = await this.#probe();
    if (initial) {
      this.#assertCompatible(initial);
      return;
    }
    if (!this.#options.packaged) {
      throw new HostStartupError("The Fitz host is not running", `Start the host at ${this.#options.origin.origin} and retry.`);
    }
    if (!isLoopback(this.#options.origin.hostname)) {
      throw new HostStartupError("The remote Fitz host is unavailable", `Check your connection to ${this.#options.origin.origin} and retry. Fitz will never start a local host as a fallback for a remote connection.`);
    }
    this.#spawnBundledHost();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const health = await this.#probe();
      if (health) {
        this.#assertCompatible(health);
        return;
      }
      await this.#wait(250);
    }
    throw new HostStartupError("The Fitz host did not become ready", `The bundled host at ${this.#options.origin.origin} did not answer within 15 seconds.`);
  }

  async #probe(): Promise<HostHealth | undefined> {
    try {
      const response = await this.#fetch(new URL("/health", this.#options.origin), { signal: AbortSignal.timeout(800) });
      if (!response.ok) return undefined;
      const value = await response.json() as Partial<HostHealth>;
      if (typeof value.status !== "string" || typeof value.protocolVersion !== "string" || typeof value.hostContractVersion !== "string") {
        throw new HostStartupError("An incompatible Fitz host is already running", "Its health response does not expose the required exact contract version.");
      }
      return value as HostHealth;
    } catch (error) {
      if (error instanceof HostStartupError) throw error;
      return undefined;
    }
  }

  #assertCompatible(health: HostHealth): void {
    if (health.protocolVersion === PROTOCOL_VERSION && health.hostContractVersion === HOST_CONTRACT_VERSION) return;
    throw new HostStartupError(
      "A different Fitz host version is already running",
      `Expected protocol ${PROTOCOL_VERSION} / host contract ${HOST_CONTRACT_VERSION}; found ${health.protocolVersion} / ${health.hostContractVersion}. Stop the old host and retry.`,
    );
  }

  #spawnBundledHost(): void {
    const hostRoot = join(this.#options.resourcesPath, "host");
    const executable = join(hostRoot, "runtime", "node.exe");
    const server = join(hostRoot, "dist", "server.js");
    if (!existsSync(executable) || !existsSync(server)) {
      throw new HostStartupError("The bundled Fitz host is missing", `Expected ${executable} and ${server}. Reinstall Fitz.`);
    }
    const child = spawn(executable, [server], {
      cwd: hostRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, FITZ_HOST: "127.0.0.1", FITZ_PORT: String(this.#options.origin.port || 8787) },
    });
    child.unref();
  }
}

function isLoopback(value: string): boolean { const host = value.replace(/^\[|\]$/g, "").toLowerCase(); return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
