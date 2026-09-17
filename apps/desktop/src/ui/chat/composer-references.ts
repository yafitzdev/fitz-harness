export type ComposerReferenceKind = "file" | "folder" | "session";
export interface ComposerReference { providerId: string; kind: ComposerReferenceKind; label: string; value: string; detail?: string }
export interface ComposerReferenceProvider { id: string; search(query: string): Promise<ComposerReference[]> }

/** Merges typed reference sources behind one bounded, deterministic contract. */
export class ComposerReferenceRegistry {
  constructor(private readonly providers: readonly ComposerReferenceProvider[]) {}
  async search(query: string, limit = 12): Promise<ComposerReference[]> {
    const settled = await Promise.allSettled(this.providers.map((provider) => provider.search(query)));
    const seen = new Set<string>(); const results: ComposerReference[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const reference of result.value) {
        const key = `${reference.providerId}:${reference.kind}:${reference.value}`;
        if (seen.has(key)) continue;
        seen.add(key); results.push(reference);
        if (results.length >= limit) return results;
      }
    }
    return results;
  }
}

export function serializeComposerReferences(references: readonly ComposerReference[]): string {
  return references.map((reference) => `@${reference.kind}(${JSON.stringify(reference.value)})`).join(" ");
}
