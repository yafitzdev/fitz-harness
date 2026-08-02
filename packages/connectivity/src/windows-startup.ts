import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "FitzCodexHost";

export interface WindowsStartupStatus {
  available: boolean;
  configured: boolean;
  launcherPath: string;
  message?: string;
}

export type RegistryRunner = (args: readonly string[]) => Promise<{ stdout: string }>;

export class WindowsStartupManager {
  constructor(
    private readonly launcherPath: string,
    private readonly runner: RegistryRunner = async (args) => execute("reg.exe", [...args], { timeout: 10_000, windowsHide: true }),
    private readonly platform = process.platform,
    private readonly exists = existsSync,
  ) {}

  async status(): Promise<WindowsStartupStatus> {
    const available = this.platform === "win32" && isAbsolute(this.launcherPath) && this.exists(this.launcherPath);
    if (this.platform !== "win32") return { available: false, configured: false, launcherPath: this.launcherPath, message: "Windows startup is only available on Windows" };
    try {
      const { stdout } = await this.runner(["query", RUN_KEY, "/v", VALUE_NAME]);
      return { available, configured: stdout.includes(VALUE_NAME), launcherPath: this.launcherPath, ...(!available ? { message: "The packaged host launcher is not available" } : {}) };
    } catch {
      return { available, configured: false, launcherPath: this.launcherPath, ...(!available ? { message: "The packaged host launcher is not available" } : {}) };
    }
  }

  async install(): Promise<WindowsStartupStatus> {
    this.assertAvailable();
    const command = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${this.launcherPath}"`;
    await this.runner(["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", command, "/f"]);
    return this.status();
  }

  async remove(): Promise<WindowsStartupStatus> {
    if (this.platform !== "win32") throw new Error("Windows startup is only available on Windows");
    try { await this.runner(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]); }
    catch { /* Removing an absent entry is already the desired state. */ }
    return this.status();
  }

  private assertAvailable(): void {
    if (this.platform !== "win32") throw new Error("Windows startup is only available on Windows");
    if (!isAbsolute(this.launcherPath) || !this.exists(this.launcherPath)) throw new Error("The packaged host launcher is not available");
  }
}
