type Json = Record<string, any>;

/** Selects bounded transcript windows at user-message boundaries so initial
 * restore cost stays constant without splitting one conversational turn. */
export class TranscriptWindow {
  readonly chunkSize: number;
  #entries: Json[] = [];
  #start = 0;
  constructor(chunkSize = 250) { this.chunkSize = chunkSize }
  reset(entries: Json[]): readonly Json[] { this.#entries = entries; this.#start = this.#boundary(Math.max(0, entries.length - this.chunkSize)); return this.visible }
  prepend(entries: Json[]): readonly Json[] { this.#entries = [...entries, ...this.#entries]; this.#start = 0; return this.visible }
  expand(): readonly Json[] { this.#start = this.#boundary(Math.max(0, this.#start - this.chunkSize)); return this.visible }
  get hiddenCount(): number { return this.#start }
  get visible(): readonly Json[] { return this.#entries.slice(this.#start) }
  get oldestSequence(): number | undefined { const value = Number(this.#entries.at(0)?.sequence); return Number.isFinite(value) ? value : undefined }
  #boundary(candidate: number): number { for (let index = candidate; index > 0; index -= 1) { const entry = this.#entries[index]; if (entry?.kind === "message" && entry.role === "user") return index; } return 0 }
}
