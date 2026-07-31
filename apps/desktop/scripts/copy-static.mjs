import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], outfile: fileURLToPath(new URL("../dist/preload.cjs", import.meta.url)), bundle: true, platform: "node", format: "cjs", external: ["electron"], sourcemap: true });
await build({ entryPoints: [fileURLToPath(new URL("../src/renderer.ts", import.meta.url))], outfile: fileURLToPath(new URL("../dist/renderer.js", import.meta.url)), bundle: true, platform: "browser", format: "esm", sourcemap: true });
mkdirSync(new URL("../dist/renderer/", import.meta.url), { recursive: true });
cpSync(new URL("../src/renderer/index.html", import.meta.url), new URL("../dist/renderer/index.html", import.meta.url));
cpSync(new URL("../src/renderer/styles.css", import.meta.url), new URL("../dist/renderer/styles.css", import.meta.url));
