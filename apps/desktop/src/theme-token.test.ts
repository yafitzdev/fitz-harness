import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeColor } from "./theme-token.js";

describe("theme token bridge", () => {
  it("resolves native window chrome from the CSS color register", () => {
    const tokens = fileURLToPath(new URL("./ui/theme/tokens.css", import.meta.url));
    expect(readThemeColor(tokens, "--window-background")).toBe("#0d0d0d");
  });
});
