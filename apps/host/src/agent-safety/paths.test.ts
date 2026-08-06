import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePath, classifyPath, isPathInside, rawBasename, resolveAbsolutePath, shellQuote } from "./paths.js";

const CWD = "/mnt/c/Users/yanfi/projects/example";

describe("canonicalizePath", () => {
  it("collapses WSL mounts, drive letters, backslashes and case into one key", () => {
    expect(canonicalizePath("/mnt/c/Users/yanfi/projects/example/src/app.ts", CWD)).toBe("c:/users/yanfi/projects/example/src/app.ts");
    expect(canonicalizePath("C:/Users/yanfi/projects/example/src/app.ts", CWD)).toBe("c:/users/yanfi/projects/example/src/app.ts");
    expect(canonicalizePath("c:\\Users\\YANFI\\projects\\example\\src\\app.ts", CWD)).toBe("c:/users/yanfi/projects/example/src/app.ts");
  });

  it("resolves relative paths against the cwd and collapses dot segments", () => {
    expect(canonicalizePath("src/app.ts", CWD)).toBe("c:/users/yanfi/projects/example/src/app.ts");
    expect(canonicalizePath("./src/../lib/x.ts", CWD)).toBe("c:/users/yanfi/projects/example/lib/x.ts");
  });

  it("expands ~ to the home directory", () => {
    const home = canonicalizePath(homedir(), CWD)!;
    expect(canonicalizePath("~/notes.md", CWD)).toBe(`${home}/notes.md`);
    expect(canonicalizePath("~", CWD)).toBe(home);
  });

  it("keeps the case-preserving form for filesystem operations", () => {
    expect(resolveAbsolutePath("C:\\Users\\Yanfi\\Notes.txt", CWD)).toBe("C:/Users/Yanfi/Notes.txt");
    expect(resolveAbsolutePath("/mnt/c/Users/Yanfi/Notes.txt", CWD)).toBe("C:/Users/Yanfi/Notes.txt");
    expect(resolveAbsolutePath('"src/app.ts"', CWD)).toBe(`${CWD.replace(/^\/mnt\/c/, "C:")}/src/app.ts`);
  });

  it("returns undefined for unresolvable input", () => {
    expect(canonicalizePath("", CWD)).toBeUndefined();
    expect(canonicalizePath("   ", CWD)).toBeUndefined();
  });
});

describe("isPathInside", () => {
  it("accepts the parent itself and direct children, rejects siblings", () => {
    expect(isPathInside("c:/a/b", "c:/a/b")).toBe(true);
    expect(isPathInside("c:/a/b", "c:/a/b/c/d.txt")).toBe(true);
    expect(isPathInside("c:/a/b", "c:/a/bc/d.txt")).toBe(false);
    expect(isPathInside("c:/a/b", "c:/a/c/d.txt")).toBe(false);
  });
});

describe("classifyPath", () => {
  const options = { workspaceRoot: CWD, homeDir: "/home/user", runtimeDirs: [] as string[], tempDirs: [tmpdir()] };

  it("classifies workspace paths", () => {
    expect(classifyPath("/mnt/c/Users/yanfi/projects/example/src", options).zone).toBe("workspace");
    expect(classifyPath("src/index.ts", options).zone).toBe("workspace");
  });

  it("classifies the Fitz trash as protected", () => {
    expect(classifyPath("/mnt/c/Users/yanfi/projects/example/.fitz-trash/run-1/x.txt", options).zone).toBe("protected");
  });

  it("classifies sensitive locations outside the workspace", () => {
    expect(classifyPath("~/.ssh/id_rsa", options).zone).toBe("sensitive");
    expect(classifyPath("~/.aws/credentials", options).zone).toBe("sensitive");
    expect(classifyPath("~/.gnupg/secring.gpg", options).zone).toBe("sensitive");
    expect(classifyPath("/home/user/.env", options).zone).toBe("sensitive");
    expect(classifyPath("/home/user/secrets.json", options).zone).toBe("sensitive");
  });

  it("allows sensitive files inside the workspace (the agent may work on project files)", () => {
    expect(classifyPath("/mnt/c/Users/yanfi/projects/example/.env", options).zone).toBe("workspace");
  });

  it("classifies system paths and drive roots", () => {
    expect(classifyPath("/etc/hosts", options).zone).toBe("system");
    expect(classifyPath("/usr/bin/python3", options).zone).toBe("system");
    expect(classifyPath("C:/Windows/System32/drivers", options).zone).toBe("system");
    expect(classifyPath("C:/", options).zone).toBe("system");
  });

  it("classifies runtime dirs the agent owns", () => {
    const withRuntime = { ...options, runtimeDirs: ["/mnt/c/Users/yanfi/AppData/Local/Fitz/pi"] };
    expect(classifyPath("/mnt/c/Users/yanfi/AppData/Local/Fitz/pi/extensions", withRuntime).zone).toBe("runtime");
  });

  it("classifies temp dirs", () => {
    expect(classifyPath(join(tmpdir(), "fitz-x"), options).zone).toBe("temp");
  });

  it("classifies anything else outside the workspace", () => {
    expect(classifyPath("/home/user/notes.md", options).zone).toBe("outside");
    expect(classifyPath("/mnt/d/data/report.pdf", options).zone).toBe("outside");
  });

  it("classifies unresolvable paths as unknown", () => {
    const info = classifyPath("", options);
    expect(info.zone).toBe("unknown");
    expect(info.raw).toBe("");
  });
});

describe("path helpers", () => {
  it("extracts a raw basename for trash filenames", () => {
    expect(rawBasename("/mnt/c/Users/yanfi/a.txt")).toBe("a.txt");
    expect(rawBasename("C:\\Users\\yanfi\\a.txt")).toBe("a.txt");
    expect(rawBasename("/mnt/c/Users/yanfi/folder/")).toBe("folder");
  });

  it("quotes paths for shell reconstruction only when needed", () => {
    expect(shellQuote("C:/Users/yanfi/projects/x/.fitz-trash/run-1")).toBe("C:/Users/yanfi/projects/x/.fitz-trash/run-1");
    expect(shellQuote("/home/user/my file.txt")).toBe("'/home/user/my file.txt'");
    expect(shellQuote("/home/user/it's.txt")).toBe(`'/home/user/it'\\''s.txt'`);
  });
});
