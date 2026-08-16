import { isFollowingLatest, resumeFollowingLatest } from "../chat/conversation-scroll.js";

export interface ConversationLayoutOptions {
  workspace: HTMLElement;
  messages: HTMLElement;
  composer: HTMLElement;
  scrollButton: HTMLButtonElement;
  inspectorWidth: () => number;
}

export class ConversationLayout {
  readonly #options: ConversationLayoutOptions;
  readonly #resizeObserver: ResizeObserver;
  readonly #contentObserver: MutationObserver;

  constructor(options: ConversationLayoutOptions) {
    this.#options = options;
    isFollowingLatest(options.messages);
    this.#resizeObserver = new ResizeObserver(this.sync);
    this.#contentObserver = new MutationObserver(this.sync);
    for (const target of [options.messages, options.composer, options.workspace]) this.#resizeObserver.observe(target);
    this.#contentObserver.observe(options.messages, { childList: true, subtree: true });
    options.messages.addEventListener("scroll", this.updateScrollButton, { passive: true });
    options.scrollButton.addEventListener("click", this.scrollToBottom);
    this.sync();
  }

  readonly sync = (): void => {
    const { workspace, messages, composer } = this.#options;
    const workspaceWidth = workspace.clientWidth;
    const panelWidth = workspace.classList.contains("inspector-open") ? this.#options.inspectorWidth() : 0;
    const viewportWidth = Math.max(280, workspaceWidth - panelWidth);
    const compact = panelWidth > 0;
    const minimumGutter = compact ? 18 : 24;
    const inset = Math.max(compact ? 36 : 48, Math.min(compact ? 72 : 96, viewportWidth * (compact ? .07 : .08)));
    // Scrollbars are viewport chrome, not conversation geometry. Keeping them
    // out of these calculations prevents the composer and transcript axis from
    // moving when content starts or stops overflowing.
    const conversationWidth = Math.max(240, Math.min(768, viewportWidth - inset));
    const gutter = Math.max(minimumGutter, (viewportWidth - conversationWidth) / 2);
    workspace.style.setProperty("--conversation-viewport", `${viewportWidth}px`);
    workspace.style.setProperty("--conversation-width", `${conversationWidth}px`);
    workspace.style.setProperty("--conversation-gutter", `${gutter}px`);
    workspace.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
    const composerCard = composer.querySelector<HTMLElement>(".composer-card");
    workspace.style.setProperty("--composer-card-height", `${composerCard?.offsetHeight ?? composer.offsetHeight}px`);
    this.updateScrollButton();
  };

  readonly updateScrollButton = (): void => {
    const { messages, scrollButton } = this.#options;
    const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    scrollButton.hidden = distanceFromBottom < 48 || Boolean(messages.querySelector(".landing, .new-chat-landing"));
  };

  readonly scrollToBottom = (): void => {
    resumeFollowingLatest(this.#options.messages);
    this.#options.messages.scrollTo({ top: this.#options.messages.scrollHeight, behavior: "smooth" });
  };
}
