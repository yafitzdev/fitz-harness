export interface ShutdownSignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code?: number): unknown;
  exitCode?: number;
}

export interface GracefulShutdownOptions {
  source?: ShutdownSignalSource;
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}

/** Connect OS termination signals to the application's coordinated close path.
 * A second signal uses the platform default because listeners are removed as
 * soon as draining starts; a bounded timeout prevents an unresponsive provider
 * from leaving the host alive forever. */
export function installGracefulShutdown(close: () => Promise<void>, options: GracefulShutdownOptions = {}): () => void {
  const source = options.source ?? process;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let closing = false;
  const remove = () => {
    source.removeListener("SIGINT", handleSignal);
    source.removeListener("SIGTERM", handleSignal);
  };
  const handleSignal = () => {
    if (closing) return;
    closing = true;
    remove();
    const timeout = setTimeout(() => source.exit(1), timeoutMs);
    timeout.unref?.();
    void close().then(
      () => { clearTimeout(timeout); source.exitCode = 0; },
      (error) => { clearTimeout(timeout); options.onError?.(error); source.exitCode = 1; source.exit(1); },
    );
  };
  source.once("SIGINT", handleSignal);
  source.once("SIGTERM", handleSignal);
  return remove;
}
