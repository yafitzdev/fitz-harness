import { describe, expect, it } from "vitest";
import { redactToolResultContent } from "./redaction.js";

const PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAEAAABlAAAAMwAA",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

describe("redactToolResultContent", () => {
  it("redacts private key blocks", () => {
    const result = redactToolResultContent([{ type: "text", text: `here:\n${PRIVATE_KEY}\nend` }]);
    expect(result![0]!.text).toContain("[REDACTED]");
    expect(result![0]!.text).not.toContain("BEGIN OPENSSH");
  });

  it("redacts API tokens, AWS keys, JWTs, and bearer tokens", () => {
    const cases = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "xai-abcdefghijklmnop1234567890",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const secret of cases) {
      const result = redactToolResultContent([{ type: "text", text: `prefix ${secret} suffix` }]);
      expect(result![0]!.text, secret).toBe("prefix [REDACTED] suffix");
    }
  });

  it("redacts named key=value secrets", () => {
    const result = redactToolResultContent([{ type: "text", text: "api_key=hunter2 password=correct-horse" }]);
    expect(result![0]!.text).toBe("[REDACTED] [REDACTED]");
  });

  it("leaves non-text parts and safe text untouched", () => {
    const content = [{ type: "text", text: "all clear here" }, { type: "image", url: "https://x/y.png" }] as const;
    expect(redactToolResultContent(content as unknown as Array<{ type: string; text?: string }>)).toBeUndefined();
  });
});
