import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

export interface ToolLeaseRequest {
  cwd: string;
  toolCallId: string;
  toolName: string;
  runId?: string;
}

export type ToolLeaseRelease = () => void;
export type ToolLeaseAcquirer = (request: ToolLeaseRequest, signal: AbortSignal) => Promise<ToolLeaseRelease>;

interface Waiter {
  resolve(release: ToolLeaseRelease): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort(): void;
}

interface WorkspaceLock {
  held: boolean;
  waiters: Waiter[];
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "fitz_session"]);
const NON_WORKSPACE_TOOLS = new Set(["generate_image", "generate_video", "generate_audio"]);

/** A fair, exclusive lease around workspace-mutating tools. Agent state
 * machines may run concurrently, but edits, shell commands, trash operations,
 * and extension tools cannot mutate the same workspace at the same time. */
export class WorkspaceMutationLeaseManager {
  readonly #locks = new Map<string, WorkspaceLock>();

  readonly acquire: ToolLeaseAcquirer = async (request, signal) => {
    if (!isWorkspaceMutation(request.toolName)) return noop;
    if (signal.aborted) throw abortError();
    const key = workspaceKey(request.cwd);
    const lock = this.#locks.get(key) ?? { held: false, waiters: [] };
    this.#locks.set(key, lock);
    if (!lock.held) {
      lock.held = true;
      return this.#release(key, lock);
    }
    return new Promise<ToolLeaseRelease>((resolveLease, reject) => {
      const waiter: Waiter = {
        resolve: resolveLease,
        reject,
        signal,
        abort: () => {
          const index = lock.waiters.indexOf(waiter);
          if (index >= 0) lock.waiters.splice(index, 1);
          reject(abortError());
          this.#deleteIfIdle(key, lock);
        },
      };
      lock.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  };

  #release(key: string, lock: WorkspaceLock): ToolLeaseRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (lock.waiters.length > 0) {
        const waiter = lock.waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) continue;
        waiter.resolve(this.#release(key, lock));
        return;
      }
      lock.held = false;
      this.#deleteIfIdle(key, lock);
    };
  }

  #deleteIfIdle(key: string, lock: WorkspaceLock): void {
    if (!lock.held && lock.waiters.length === 0) this.#locks.delete(key);
  }
}

export function isWorkspaceMutation(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName) && !NON_WORKSPACE_TOOLS.has(toolName);
}

function workspaceKey(cwd: string): string {
  const absolute = resolve(cwd);
  const canonical = (existsSync(absolute) ? realpathSync.native(absolute) : absolute).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function noop(): void {}
function abortError(): Error { const error = new Error("Workspace mutation lease was cancelled"); error.name = "AbortError"; return error; }
