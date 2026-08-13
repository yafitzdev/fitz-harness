import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fitz/agent-core": fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
      "@fitz/agent-pi": fileURLToPath(new URL("./packages/agent-pi/src/index.ts", import.meta.url)),
      "@fitz/context": fileURLToPath(new URL("./packages/context/src/index.ts", import.meta.url)),
      "@fitz/connectivity/reconnect": fileURLToPath(new URL("./packages/connectivity/src/reconnect.ts", import.meta.url)),
      "@fitz/connectivity": fileURLToPath(new URL("./packages/connectivity/src/index.ts", import.meta.url)),
      "@fitz/media": fileURLToPath(new URL("./packages/media/src/index.ts", import.meta.url)),
      "@fitz/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@fitz/inference-core": fileURLToPath(
        new URL("./packages/inference-core/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-fake": fileURLToPath(
        new URL("./packages/engine-fake/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-media-fake": fileURLToPath(
        new URL("./packages/engine-media-fake/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-ninfer": fileURLToPath(
        new URL("./packages/engine-ninfer/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-openai-compatible": fileURLToPath(
        new URL("./packages/engine-openai-compatible/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-llama-cpp": fileURLToPath(
        new URL("./packages/engine-llama-cpp/src/index.ts", import.meta.url),
      ),
      "@fitz/engine-comfyui": fileURLToPath(
        new URL("./packages/engine-comfyui/src/index.ts", import.meta.url),
      ),
      "@fitz/media-providers": fileURLToPath(
        new URL("./packages/media-providers/src/index.ts", import.meta.url),
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
    include: ["apps/{desktop,host}/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/release/**"],
    testTimeout: 10_000,
    restoreMocks: true,
  },
});
