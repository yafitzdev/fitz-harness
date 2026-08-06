import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiPackageService } from "./pi-packages.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("PiPackageService", () => {
  it("maps the npm Pi package catalog", async () => {
    const service = new PiPackageService({
      agentDir: await temporaryDirectory(), cwd: process.cwd(),
      fetch: async () => new Response(JSON.stringify({ total: 1, objects: [{ package: { name: "pi-example", version: "1.2.3", description: "Example", keywords: ["pi-package", "skill"], publisher: { username: "fitz" } } }] })) as typeof fetch,
    });
    const result = await service.catalog("example", 0, 10);
    expect(result).toEqual({ total: 1, packages: [expect.objectContaining({ name: "pi-example", version: "1.2.3", publisher: "fitz", types: ["skill"] })] });
  });

  it("sorts the npm catalog by popularity when downloads is requested", async () => {
    const requested: string[] = [];
    const service = new PiPackageService({
      agentDir: await temporaryDirectory(), cwd: process.cwd(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return new Response(JSON.stringify({ total: 0, objects: [] })) as typeof fetch; },
    });
    await service.catalog("example", 0, 10, "downloads", "desc");
    expect(requested[0]).toContain("popularity=1.0");
    expect(requested[0]).toContain("quality=0");
    expect(requested[0]).toContain("maintenance=0");
  });

  it("orders the npm catalog by name and update date over the fetched page", async () => {
    const service = new PiPackageService({
      agentDir: await temporaryDirectory(), cwd: process.cwd(),
      fetch: async () => new Response(JSON.stringify({ total: 3, objects: [
        { package: { name: "pi-zeta", version: "1.0.0", date: "2024-01-01T00:00:00.000Z" } },
        { package: { name: "pi-alpha", version: "1.0.0", date: "2024-03-01T00:00:00.000Z" } },
        { package: { name: "pi-mid", version: "1.0.0", date: "2024-02-01T00:00:00.000Z" } },
      ] })) as typeof fetch,
    });
    const byName = await service.catalog("", 0, 10, "name", "asc");
    expect(byName.packages.map((entry) => entry.name)).toEqual(["pi-alpha", "pi-mid", "pi-zeta"]);
    const byDate = await service.catalog("", 0, 10, "updated", "desc");
    expect(byDate.packages.map((entry) => entry.name)).toEqual(["pi-alpha", "pi-mid", "pi-zeta"]);
  });

  it("pushes a single type facet into the npm search keywords", async () => {
    const requested: string[] = [];
    const service = new PiPackageService({
      agentDir: await temporaryDirectory(), cwd: process.cwd(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return new Response(JSON.stringify({ total: 0, objects: [] })) as typeof fetch; },
    });
    await service.catalog("", 0, 10, "downloads", "desc", ["skill"]);
    expect(new URL(requested[0]!).searchParams.get("text")).toBe("keywords:pi-package keywords:skill");
    // The text query still applies alongside the type filter.
    await service.catalog("cookbook", 0, 10, "downloads", "desc", ["theme"]);
    expect(new URL(requested[1]!).searchParams.get("text")).toBe("cookbook keywords:pi-package keywords:theme");
  });

  it("keeps the client-side facet filter for multi-select and unknown types", async () => {
    const requested: string[] = [];
    const service = new PiPackageService({
      agentDir: await temporaryDirectory(), cwd: process.cwd(),
      fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return new Response(JSON.stringify({ total: 0, objects: [] })) as typeof fetch; },
    });
    await service.catalog("", 0, 10, "downloads", "desc", ["skill", "prompt"]);
    expect(requested[0]).not.toContain("keywords:skill");
    expect(requested[0]).not.toContain("keywords:prompt");
    await service.catalog("", 0, 10, "downloads", "desc", ["bogus" as never]);
    expect(requested[1]).not.toContain("keywords:bogus");
  });

  it("installs a local Pi package into the registry folder and manages it", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const packageDir = join(root, "package");
    await mkdir(join(packageDir, "skills", "hello"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fitz-test-package", version: "1.0.0", description: "Test package", pi: { skills: ["skills"] } }));
    await writeFile(join(packageDir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello\n---\nSay hello.\n");
    const service = new PiPackageService({ agentDir, cwd: root });

    await service.install(packageDir);
    const [installed] = await service.installed();
    expect(installed).toEqual(expect.objectContaining({ displayName: "fitz-test-package", enabled: true, installedPath: join(agentDir, "extensions", "package") }));
    expect(await service.skills()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "hello", enabled: true })]));
    // The registry is the single source of truth: the package lives in extensions/ and
    // nothing is written to settings.json or the old npm/ tree.
    const registry = JSON.parse(await readFile(join(agentDir, "extensions", "registry.json"), "utf8"));
    expect(registry).toEqual({ version: 1, packages: [{ source: packageDir, name: "package", version: "1.0.0", enabled: true }] });
    expect(await readFile(join(agentDir, "extensions", "package", "skills", "hello", "SKILL.md"), "utf8")).toContain("Say hello");
    await service.setEnabled(installed!.source, false);
    expect(await service.installed()).toEqual([expect.objectContaining({ enabled: false })]);
    await service.setEnabled(installed!.source, true);
    expect(await service.installed()).toEqual([expect.objectContaining({ enabled: true })]);
    await service.remove(installed!.source);
    expect(await service.installed()).toEqual([]);
    await expect(access(join(agentDir, "extensions", "package"))).rejects.toThrow();
  });

  it("installs an npm Pi package into its own folder with its own node_modules", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const stub = join(root, "stub-npm.js");
    await writeFile(stub, stubNpm, "utf8");
    const service = new PiPackageService({ agentDir, cwd: root, npmCommand: [process.execPath, stub] });

    await service.install("npm:pi-web-access");
    const [installed] = await service.installed();
    expect(installed).toEqual(expect.objectContaining({ source: "npm:pi-web-access", displayName: "pi-web-access", version: "1.0.0", enabled: true, installedPath: join(agentDir, "extensions", "pi-web-access") }));
    expect(JSON.parse(await readFile(join(agentDir, "extensions", "registry.json"), "utf8"))).toEqual({
      version: 1,
      packages: [{ source: "npm:pi-web-access", name: "pi-web-access", version: "1.0.0", enabled: true }],
    });
    // The wrapper install is hoisted: the package's real manifest and files sit at the
    // folder root, with its own node_modules beside them.
    expect(JSON.parse(await readFile(join(agentDir, "extensions", "pi-web-access", "package.json"), "utf8")).name).toBe("pi-web-access");
    expect(await readFile(join(agentDir, "extensions", "pi-web-access", "index.js"), "utf8")).toBe("export default {};\n");
  });

  it("keeps a package's config.json when updating it", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const stub = join(root, "stub-npm.js");
    await writeFile(stub, stubNpm, "utf8");
    const service = new PiPackageService({ agentDir, cwd: root, npmCommand: [process.execPath, stub] });
    await service.install("npm:pi-web-access");
    const configPath = join(agentDir, "extensions", "pi-web-access", "config.json");
    await writeFile(configPath, JSON.stringify({ retries: 3 }));

    process.env.FITZ_STUB_VERSION = "2.0.0";
    try { await service.update("npm:pi-web-access"); }
    finally { delete process.env.FITZ_STUB_VERSION; }

    expect(await service.installed()).toEqual([expect.objectContaining({ source: "npm:pi-web-access", version: "2.0.0" })]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ retries: 3 });
  });

  it("migrates the legacy npm/settings layout into the extensions registry", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const npmPkg = join(agentDir, "npm", "node_modules", "pi-rtk-optimizer");
    await mkdir(npmPkg, { recursive: true });
    await writeFile(join(agentDir, "npm", "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies: { "pi-rtk-optimizer": "^0.9.0" } }));
    await writeFile(join(npmPkg, "package.json"), JSON.stringify({ name: "pi-rtk-optimizer", version: "0.9.0", description: "RTK optimizer", keywords: ["pi-package", "pi-extension"] }));
    await writeFile(join(npmPkg, "index.ts"), "export default {};\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-rtk-optimizer"], other: "kept" }));
    // Pi CLI convention: the package's config lives at extensions/<name>/config.json.
    const legacyConfigDir = join(agentDir, "extensions", "pi-rtk-optimizer");
    await mkdir(legacyConfigDir, { recursive: true });
    await writeFile(join(legacyConfigDir, "config.json"), JSON.stringify({ retries: 3 }));

    // ["false"] guards against an unexpected npm spawn: the migrated package declares no
    // dependencies, so the migration must not invoke npm at all.
    const service = new PiPackageService({ agentDir, cwd: root, npmCommand: ["false"] });

    expect(await service.installed()).toEqual([expect.objectContaining({ source: "npm:pi-rtk-optimizer", displayName: "pi-rtk-optimizer", version: "0.9.0", enabled: true, installedPath: legacyConfigDir })]);
    // The registry is now the single source of truth; settings and the old tree are gone.
    expect(JSON.parse(await readFile(join(agentDir, "extensions", "registry.json"), "utf8"))).toEqual({
      version: 1,
      packages: [{ source: "npm:pi-rtk-optimizer", name: "pi-rtk-optimizer", version: "0.9.0", enabled: true }],
    });
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({ other: "kept" });
    await expect(access(join(agentDir, "npm"))).rejects.toThrow();
    // rtk's config and the package files survive the consolidation.
    expect(JSON.parse(await readFile(join(legacyConfigDir, "config.json"), "utf8"))).toEqual({ retries: 3 });
    expect(await readFile(join(legacyConfigDir, "index.ts"), "utf8")).toBe("export default {};\n");
    // Idempotent: a fresh service over the migrated layout sees the same state and does
    // not re-run the migration.
    const again = new PiPackageService({ agentDir, cwd: root, npmCommand: ["false"] });
    expect(await again.installed()).toEqual([expect.objectContaining({ source: "npm:pi-rtk-optimizer", enabled: true })]);
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({ other: "kept" });
  });
});

/** Stand-in for `npm install --prefix <dir>`: writes node_modules/<name> from the wrapper package.json. */
const stubNpm = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prefix = args.indexOf("--prefix");
const dir = prefix !== -1 ? args[prefix + 1] : process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const version = process.env.FITZ_STUB_VERSION ?? "1.0.0";
for (const name of Object.keys(manifest.dependencies ?? {})) {
  const target = path.join(dir, "node_modules", ...name.split("/"));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, version, keywords: ["pi-package", "pi-extension"], pi: { extensions: ["index.js"] } }));
  fs.writeFileSync(path.join(target, "index.js"), "export default {};\\n");
}
`;

async function temporaryDirectory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "fitz-pi-packages-")); temporaryDirectories.push(path); return path; }
