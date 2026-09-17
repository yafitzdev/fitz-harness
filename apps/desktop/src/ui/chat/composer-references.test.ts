import { describe, expect, it } from "vitest";
import { ComposerReferenceRegistry, serializeComposerReferences } from "./composer-references.js";

describe("ComposerReferenceRegistry", () => {
  it("merges providers, removes duplicate identities, and serializes stable typed refs", async () => {
    const duplicate = { providerId: "workspace", kind: "file" as const, label: "a.ts", value: "src/a.ts" };
    const registry = new ComposerReferenceRegistry([
      { id: "workspace", search: async () => [duplicate] },
      { id: "sessions", search: async () => [duplicate, { providerId: "sessions", kind: "session", label: "Old task", value: "session-1" }] },
    ]);
    const results = await registry.search("a");
    expect(results).toHaveLength(2);
    expect(serializeComposerReferences(results)).toBe('@file("src/a.ts") @session("session-1")');
  });
});
