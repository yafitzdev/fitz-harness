// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaCreationForm, type MediaCreationRequest } from "./media-creation-form.js";

function setup() {
  const messages = document.createElement("div");
  document.body.append(messages);
  const form = new MediaCreationForm({ messages });
  return { form, messages };
}

function show(form: MediaCreationForm, overrides: Partial<MediaCreationRequest> = {}) {
  const onCreate = vi.fn(async () => undefined);
  form.show({ modality: "video", prompt: "a cat", refs: [], onCreate, ...overrides });
  return { onCreate };
}

function cardOf(messages: HTMLElement): HTMLElement {
  const card = messages.querySelector<HTMLElement>(".media-creation-card")!;
  expect(card.classList.contains("media-card")).toBe(true);
  return card;
}

function formOf(messages: HTMLElement): HTMLFormElement {
  return cardOf(messages).querySelector<HTMLFormElement>(".media-creation-form")!;
}

function submitForm(messages: HTMLElement): void {
  formOf(messages).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(() => document.body.replaceChildren());

describe("MediaCreationForm", () => {
  it("renders an inline card in the chat with the prompt pre-filled and the modality's fields", () => {
    const { form, messages } = setup();
    show(form, { modality: "video", prompt: "waves crashing" });
    const card = cardOf(messages);
    expect(card.classList.contains("message")).toBe(true);
    expect(card.querySelector("h2")!.textContent).toBe("Create video");
    const prompt = card.querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!;
    expect(prompt.value).toBe("waves crashing");
    expect(document.activeElement).toBe(prompt);
    expect(card.querySelector("[data-creation-field='durationSeconds']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='size']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='fps']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='seed']")).toBeNull();
  });

  it("shows image-specific fields for image commands", () => {
    const { form, messages } = setup();
    show(form, { modality: "image" });
    const card = cardOf(messages);
    expect(card.querySelector("[data-creation-field='size']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='seed']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='negativePrompt']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='durationSeconds']")).toBeNull();
  });

  it("shows duration and optional structured lyrics for audio commands", () => {
    const { form, messages } = setup();
    show(form, { modality: "audio" });
    const card = cardOf(messages);
    expect(card.querySelector("[data-creation-field='durationSeconds']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='lyrics']")).not.toBeNull();
    expect(card.querySelector("[data-creation-field='size']")).toBeNull();
    expect(card.querySelector("[data-creation-field='fps']")).toBeNull();
  });

  it("shows the reference count when reference images are attached", () => {
    const { form, messages } = setup();
    show(form, { refs: [{ artifactId: "a" }, { artifactId: "b" }] });
    expect(cardOf(messages).querySelector(".media-approval-references")!.textContent).toBe("2 references attached");
  });

  it("collects prompt and parameters on create and dismisses the card", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "video" });
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!.value = "dolly shot through a forest";
    formOf(messages).querySelector<HTMLInputElement>("[data-creation-field='durationSeconds']")!.value = "6";
    formOf(messages).querySelector<HTMLInputElement>("[data-creation-field='fps']")!.value = "24";
    submitForm(messages);
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({ prompt: "dolly shot through a forest", durationSeconds: 6, fps: 24 });
    expect(messages.querySelector(".media-creation-card")).toBeNull();
  });

  it("collects structured lyrics for audio generation", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "audio", prompt: "dreamy synth-pop" });
    formOf(messages).querySelector<HTMLInputElement>("[data-creation-field='durationSeconds']")!.value = "90";
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='lyrics']")!.value = "[Verse]\nNeon rain\n[Chorus]\nCome alive";
    submitForm(messages);
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({
      prompt: "dreamy synth-pop",
      durationSeconds: 90,
      lyrics: "[Verse]\nNeon rain\n[Chorus]\nCome alive",
    });
  });

  it("does not create when the prompt is empty", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "image" });
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!.value = "";
    submitForm(messages);
    expect(onCreate).not.toHaveBeenCalled();
    expect(messages.querySelector(".media-creation-card")).not.toBeNull();
  });

  it("keeps the card and re-enables buttons when creation fails", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "image", prompt: "portrait" });
    onCreate.mockRejectedValueOnce(new Error("admission failed"));
    submitForm(messages);
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(cardOf(messages).querySelector<HTMLButtonElement>(".media-creation-submit")!.disabled).toBe(false);
    });
    expect(messages.querySelector(".media-creation-card")).not.toBeNull();
  });

  it("submits on Enter in the prompt", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "image", prompt: "watercolor fox" });
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });

  it("keeps Shift+Enter available for multiline prompt editing", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "image", prompt: "watercolor fox" });
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!.dispatchEvent(event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not let Enter bypass numeric field constraints", async () => {
    const { form, messages } = setup();
    const { onCreate } = show(form, { modality: "video", prompt: "watercolor fox" });
    formOf(messages).querySelector<HTMLInputElement>("[data-creation-field='durationSeconds']")!.value = "-2";
    formOf(messages).querySelector<HTMLTextAreaElement>("[data-creation-field='prompt']")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    expect(onCreate).not.toHaveBeenCalled();
    expect(messages.querySelector(".media-creation-card")).not.toBeNull();
  });

  it("removes the card when Cancel is clicked", () => {
    const { form, messages } = setup();
    show(form);
    cardOf(messages).querySelector<HTMLButtonElement>(".media-creation-cancel")!.click();
    expect(messages.querySelector(".media-creation-card")).toBeNull();
  });

  it("showing again replaces the previous card", () => {
    const { form, messages } = setup();
    show(form, { modality: "image" });
    show(form, { modality: "audio" });
    expect(messages.querySelectorAll(".media-creation-card")).toHaveLength(1);
    expect(cardOf(messages).querySelector("h2")!.textContent).toBe("Create audio");
  });
});
