import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fitz/agent-core": fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
      "@fitz/agent-pi": fileURLToPath(new URL("./packages/agent-pi/src/index.ts", import.meta.url)),
      "@fitz/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@fitz/inference-core": fileURLToPath(
        new URL("./packages/inference-core/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-fake": fileURLToPath(
        new URL("./packages/engine-fake/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-ninfer": fileURLToPath(
        new URL("./packages/engine-ninfer/src/index.ts", import.meta.url),
      ),
      "@fitz/storage": fileURLToPath(new URL("./packages/storage/src/index.ts", import.meta.url)),
      "@fitz/security": fileURLToPath(new URL("./packages/security/src/index.ts", import.meta.url)),
      "@fitz/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
