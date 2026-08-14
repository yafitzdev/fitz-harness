import type { ShareFitzStatus } from "../../preload.js";

export interface ShareFitzElements { form: HTMLFormElement; publicUrl: HTMLInputElement; tunnelToken: HTMLInputElement; status: HTMLElement; refresh: HTMLButtonElement; disable: HTMLButtonElement; forget: HTMLButtonElement; origin: HTMLElement }
export interface ShareFitzBridge { shareStatus(): Promise<ShareFitzStatus>; enableShare(input: { publicUrl: string; tunnelToken: string }): Promise<ShareFitzStatus>; disableShare(forgetCredential?: boolean): Promise<ShareFitzStatus | undefined> }

export class ShareFitzController {
  constructor(private readonly elements: ShareFitzElements, private readonly bridge: ShareFitzBridge) {
    elements.form.addEventListener("submit", (event) => { event.preventDefault(); void this.enable(); });
    elements.refresh.addEventListener("click", () => void this.refresh());
    elements.disable.addEventListener("click", () => void this.disable(false));
    elements.forget.addEventListener("click", () => void this.disable(true));
    void this.refresh();
  }
  async refresh(): Promise<void> { try { this.render(await this.bridge.shareStatus()); } catch (error) { this.renderError(error); } }
  private async enable(): Promise<void> { this.setBusy(true); try { const status = await this.bridge.enableShare({ publicUrl: this.elements.publicUrl.value.trim(), tunnelToken: this.elements.tunnelToken.value.trim() }); this.elements.tunnelToken.value = ""; this.render(status); } catch (error) { this.renderError(error); } finally { this.setBusy(false); } }
  private async disable(forget: boolean): Promise<void> { this.setBusy(true); try { const status = await this.bridge.disableShare(forget); if (forget) this.elements.publicUrl.value = ""; if (status) this.render(status); } catch (error) { this.renderError(error); } finally { this.setBusy(false); } }
  private render(status: ShareFitzStatus): void {
    this.elements.status.dataset.state = status.state;
    this.elements.status.replaceChildren(Object.assign(document.createElement("strong"), { textContent: status.state === "connected" ? "Online" : status.state === "starting" ? "Connecting…" : status.state === "error" ? "Needs attention" : "Off" }), Object.assign(document.createElement("span"), { textContent: status.message ?? (status.available ? "No public tunnel is running" : "Bundled Cloudflare Tunnel is unavailable") }));
    this.elements.origin.textContent = status.origin;
    if (status.publicUrl) this.elements.publicUrl.value = status.publicUrl;
    this.elements.disable.disabled = status.state === "disabled";
    this.elements.forget.disabled = !status.configured;
  }
  private renderError(error: unknown): void { this.elements.status.dataset.state = "error"; this.elements.status.replaceChildren(Object.assign(document.createElement("strong"), { textContent: "Share Fitz unavailable" }), Object.assign(document.createElement("span"), { textContent: error instanceof Error ? error.message : String(error) })); }
  private setBusy(busy: boolean): void { for (const control of this.elements.form.elements) if (control instanceof HTMLElement && "disabled" in control) (control as HTMLInputElement | HTMLButtonElement).disabled = busy; }
}
