export interface DesktopQuitEvent { preventDefault(): void }
export interface DesktopQuitApplication {
  quit(): void;
}

export interface ModelUnloadOnQuitOptions {
  app: DesktopQuitApplication;
  shouldUnload: () => boolean;
  unload: () => Promise<void>;
  onError?: (error: unknown) => void;
}

/** Electron's before-quit event is synchronous, so hold the first quit while
 * the local host releases its model. The second quit passes through after the
 * request settles. Failure is best-effort: an unreachable host must never trap
 * the user inside the desktop application. */
export function createModelUnloadOnQuitHandler(options: ModelUnloadOnQuitOptions): (event: DesktopQuitEvent) => void {
  let completed = false;
  let unloading = false;
  return (event) => {
    if (completed || !options.shouldUnload()) return;
    event.preventDefault();
    if (unloading) return;
    unloading = true;
    void options.unload()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        completed = true;
        options.app.quit();
      });
  };
}
