import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  it("installs, disables, enables, and removes a local Pi package", async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, "agent");
    const packageDir = join(root, "package");
    await mkdir(join(packageDir, "skills", "hello"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fitz-test-package", version: "1.0.0", description: "Test package", pi: { skills: ["skills"] } }));
    await writeFile(join(packageDir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Says hello\n---\nSay hello.\n");
    const service = new PiPackageService({ agentDir, cwd: root });

    await service.install(packageDir);
    const [installed] = await service.installed();
    expect(installed).toEqual(expect.objectContaining({ displayName: "fitz-test-package", enabled: true }));
    expect(await service.skills()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "hello", enabled: true })]));
    await service.setEnabled(installed!.source, false);
    expect(await service.installed()).toEqual([expect.objectContaining({ enabled: false })]);
    await service.setEnabled(installed!.source, true);
    expect(await service.installed()).toEqual([expect.objectContaining({ enabled: true })]);
    await service.remove(installed!.source);
    expect(await service.installed()).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "fitz-pi-packages-")); temporaryDirectories.push(path); return path; }
