import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface LockContents {
  pid: number;
  token: string;
  startedAt: string;
}

/** Prevent two Fitz host processes that share one data root from independently
 * driving the same local GPU. The queue itself is in-process; this ownership
 * lock makes that one-process assumption explicit and fail-closed. */
export class HostInstanceLock {
  readonly #path: string;
  readonly #token: string;
  #released = false;
  readonly #onExit = () => this.#releaseSync();

  private constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
    process.once("exit", this.#onExit);
  }

  static acquire(path: string): HostInstanceLock {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      const candidate = `${path}.${process.pid}.${token}.tmp`;
      try {
        const contents: LockContents = { pid: process.pid, token, startedAt: new Date().toISOString() };
        writeFileSync(candidate, JSON.stringify(contents), { encoding: "utf8", flag: "wx", mode: 0o600 });
        // Publishing a hard link is atomic and the target already contains a
        // complete owner record. A competing host therefore never mistakes a
        // partially written live lock for stale state.
        linkSync(candidate, path);
        unlinkSync(candidate);
        return new HostInstanceLock(path, token);
      } catch (error) {
        try { unlinkSync(candidate); }
        catch (cleanupError) { if (!isMissing(cleanupError)) throw cleanupError; }
        if (!isAlreadyExists(error)) throw error;
        const owner = readLock(path);
        if (owner && processIsAlive(owner.pid)) {
          throw new Error(`Another Fitz host is already running (PID ${owner.pid}). Local GPU concurrency is limited to one host process.`);
        }
        try { unlinkSync(path); }
        catch (unlinkError) { if (!isMissing(unlinkError)) throw unlinkError; }
      }
    }
    throw new Error("Could not acquire the Fitz host GPU ownership lock");
  }

  release(): void {
    this.#releaseSync();
  }

  #releaseSync(): void {
    if (this.#released) return;
    this.#released = true;
    process.removeListener("exit", this.#onExit);
    const owner = readLock(this.#path);
    if (owner?.token !== this.#token) return;
    try { unlinkSync(this.#path); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}

function readLock(path: string): LockContents | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    return typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.startedAt === "string"
      ? parsed as LockContents
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return isPermissionDenied(error); }
}

function isAlreadyExists(error: unknown): boolean { return errorCode(error) === "EEXIST"; }
function isMissing(error: unknown): boolean { return errorCode(error) === "ENOENT"; }
function isPermissionDenied(error: unknown): boolean { return errorCode(error) === "EPERM"; }
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
