import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  logPath?: string;
  fetch?: typeof globalThis.fetch;
  wait?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface BundledHostProcess {
  failure(): string | undefined;
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
    if (!isLoopback(this.#options.origin.hostname)) {
      throw new HostStartupError("The remote Fitz host is unavailable", `Check your connection to ${this.#options.origin.origin} and retry. Fitz will never start a local host as a fallback for a remote connection.`);
    }
    const hostProcess = this.#options.packaged ? this.#spawnBundledHost() : undefined;
    const timeoutMs = Math.max(0, this.#options.startupTimeoutMs ?? 30_000);
    const pollIntervalMs = Math.max(1, this.#options.pollIntervalMs ?? 250);
    const attempts = Math.max(0, Math.ceil(timeoutMs / pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const failure = hostProcess?.failure();
      if (failure) {
        throw new HostStartupError("The bundled Fitz host stopped during startup", this.#startupFailureDetail(failure));
      }
      await this.#wait(pollIntervalMs);
      const health = await this.#probe();
      if (health) {
        this.#assertCompatible(health);
        return;
      }
    }
    const description = this.#options.packaged ? "The bundled host" : "The development host";
    throw new HostStartupError("The Fitz host did not become ready", this.#startupFailureDetail(`${description} at ${this.#options.origin.origin} did not answer within ${timeoutMs} ms.`));
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

  #spawnBundledHost(): BundledHostProcess {
    const legacyHostRoot = join(this.#options.resourcesPath, "host");
    const legacyExecutable = join(legacyHostRoot, "runtime", "node.exe");
    const legacyServer = join(legacyHostRoot, "dist", "server.js");
    const embeddedServer = join(this.#options.resourcesPath, "host.asar", "dist", "server.js");
    const embedded = existsSync(embeddedServer);
    const executable = embedded ? process.execPath : legacyExecutable;
    const server = embedded ? embeddedServer : legacyServer;
    if (!existsSync(executable) || !existsSync(server)) {
      throw new HostStartupError("The bundled Fitz host is missing", `Expected ${executable} and ${server}. Reinstall Fitz.`);
    }
    const logDescriptor = this.#openStartupLog();
    const child = (() => {
      try {
        return spawn(executable, [server], {
          cwd: embedded ? this.#options.resourcesPath : legacyHostRoot,
          detached: true,
          windowsHide: true,
          stdio: logDescriptor === undefined ? "ignore" : ["ignore", logDescriptor, logDescriptor],
          env: {
            ...process.env,
            ...(embedded ? {
              ELECTRON_RUN_AS_NODE: "1",
              FITZ_STARTUP_LAUNCHER: join(this.#options.resourcesPath, "start-host.ps1"),
            } : {}),
            FITZ_HOST: "127.0.0.1",
            FITZ_PORT: String(this.#options.origin.port || 8787),
          },
        });
      } finally {
        if (logDescriptor !== undefined) closeSync(logDescriptor);
      }
    })();
    let failure: string | undefined;
    child.once("error", (error) => { failure = error.message; });
    child.once("exit", (code, signal) => { failure = code === null ? `The host process exited because of ${signal ?? "an unknown signal"}.` : `The host process exited with code ${code}.`; });
    child.unref();
    return { failure: () => failure };
  }

  #openStartupLog(): number | undefined {
    if (!this.#options.logPath) return undefined;
    try {
      mkdirSync(dirname(this.#options.logPath), { recursive: true });
      return openSync(this.#options.logPath, "w");
    } catch {
      return undefined;
    }
  }

  #startupFailureDetail(reason: string): string {
    if (!this.#options.logPath) return reason;
    try {
      const output = readFileSync(this.#options.logPath, "utf8").trim();
      if (!output) return `${reason}\n\nStartup log: ${this.#options.logPath}`;
      return `${reason}\n\nLast host output:\n${output.slice(-4_000)}\n\nStartup log: ${this.#options.logPath}`;
    } catch {
      return reason;
    }
  }
}

function isLoopback(value: string): boolean { const host = value.replace(/^\[|\]$/g, "").toLowerCase(); return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
