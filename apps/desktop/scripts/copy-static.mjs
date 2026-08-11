import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({ entryPoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))], outfile: fileURLToPath(new URL("../dist/preload.cjs", import.meta.url)), bundle: true, platform: "node", format: "cjs", external: ["electron"], sourcemap: true });
await build({ entryPoints: [fileURLToPath(new URL("../src/renderer.ts", import.meta.url))], outfile: fileURLToPath(new URL("../dist/renderer.js", import.meta.url)), bundle: true, platform: "browser", format: "esm", sourcemap: true });
mkdirSync(new URL("../dist/renderer/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/theme/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/primitives/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/chat/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/connections/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/plugins/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/models/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/administration/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/usage/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/playbooks/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/sidebar/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/inspector/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/layout/", import.meta.url), { recursive: true });
mkdirSync(new URL("../dist/ui/catalog/", import.meta.url), { recursive: true });
cpSync(new URL("../src/renderer/index.html", import.meta.url), new URL("../dist/renderer/index.html", import.meta.url));
cpSync(new URL("../src/renderer/styles.css", import.meta.url), new URL("../dist/renderer/styles.css", import.meta.url));
cpSync(new URL("../src/ui/theme/tokens.css", import.meta.url), new URL("../dist/ui/theme/tokens.css", import.meta.url));
cpSync(new URL("../src/ui/primitives/scroll-surface.css", import.meta.url), new URL("../dist/ui/primitives/scroll-surface.css", import.meta.url));
cpSync(new URL("../src/ui/primitives/action-menu.css", import.meta.url), new URL("../dist/ui/primitives/action-menu.css", import.meta.url));
cpSync(new URL("../src/ui/chat/message-actions.css", import.meta.url), new URL("../dist/ui/chat/message-actions.css", import.meta.url));
cpSync(new URL("../src/ui/chat/activity-timeline.css", import.meta.url), new URL("../dist/ui/chat/activity-timeline.css", import.meta.url));
cpSync(new URL("../src/ui/chat/media-creation-form.css", import.meta.url), new URL("../dist/ui/chat/media-creation-form.css", import.meta.url));
cpSync(new URL("../src/ui/chat/reasoning-view.css", import.meta.url), new URL("../dist/ui/chat/reasoning-view.css", import.meta.url));
cpSync(new URL("../src/ui/chat/composer-controls.css", import.meta.url), new URL("../dist/ui/chat/composer-controls.css", import.meta.url));
cpSync(new URL("../src/ui/chat/composer.css", import.meta.url), new URL("../dist/ui/chat/composer.css", import.meta.url));
cpSync(new URL("../src/ui/connections/connection-workspace.css", import.meta.url), new URL("../dist/ui/connections/connection-workspace.css", import.meta.url));
cpSync(new URL("../src/ui/plugins/plugin-catalog.css", import.meta.url), new URL("../dist/ui/plugins/plugin-catalog.css", import.meta.url));
cpSync(new URL("../src/ui/models/model-catalog.css", import.meta.url), new URL("../dist/ui/models/model-catalog.css", import.meta.url));
cpSync(new URL("../src/ui/administration/administration-page.css", import.meta.url), new URL("../dist/ui/administration/administration-page.css", import.meta.url));
cpSync(new URL("../src/ui/usage/usage-page.css", import.meta.url), new URL("../dist/ui/usage/usage-page.css", import.meta.url));
cpSync(new URL("../src/ui/playbooks/playbook-workspace.css", import.meta.url), new URL("../dist/ui/playbooks/playbook-workspace.css", import.meta.url));
cpSync(new URL("../src/ui/sidebar/project-sidebar.css", import.meta.url), new URL("../dist/ui/sidebar/project-sidebar.css", import.meta.url));
cpSync(new URL("../src/ui/inspector/inspector-panel.css", import.meta.url), new URL("../dist/ui/inspector/inspector-panel.css", import.meta.url));
cpSync(new URL("../src/ui/layout/management-page.css", import.meta.url), new URL("../dist/ui/layout/management-page.css", import.meta.url));
cpSync(new URL("../src/ui/layout/collapsible-section.css", import.meta.url), new URL("../dist/ui/layout/collapsible-section.css", import.meta.url));
cpSync(new URL("../src/ui/catalog/catalog-filter-bar.css", import.meta.url), new URL("../dist/ui/catalog/catalog-filter-bar.css", import.meta.url));
cpSync(new URL("../src/bootstrap.cjs", import.meta.url), new URL("../dist/bootstrap.cjs", import.meta.url));

// Every @import in the shell stylesheet must resolve inside dist: a missing
// file silently drops that stylesheet at runtime, leaving pages unstyled.
// Fail the build loudly instead of shipping a blank page again.
const shellStyles = readFileSync(new URL("../dist/renderer/styles.css", import.meta.url), "utf8");
for (const match of shellStyles.matchAll(/@import\s+"([^"]+)"/g)) {
  const target = new URL(match[1], new URL("../dist/renderer/styles.css", import.meta.url));
  if (!existsSync(target)) throw new Error(`styles.css imports ${match[1]}, but ${fileURLToPath(target)} was not copied into dist`);
}
