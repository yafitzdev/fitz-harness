import { describe, expect, it } from "vitest";
import {
  activityKind,
  burstIconPath,
  describeTool,
  displayName,
  iconPathFor,
  projectRelativePath,
  registerToolMeta,
  summarizeBurst,
  toolPath,
} from "./tool-activity.js";

describe("summarizeBurst", () => {
  it("uses the present tense while a burst is running", () => {
    expect(summarizeBurst({ bash: 1 }, true)).toBe("Running command");
    expect(summarizeBurst({ bash: 3 }, true)).toBe("Running 3 commands");
    expect(summarizeBurst({ edit: 1 }, true)).toBe("Editing file");
    expect(summarizeBurst({ edit: 2 }, true)).toBe("Editing 2 files");
    expect(summarizeBurst({ edit: 1, bash: 1 }, true)).toBe("Editing file, running command");
  });

  it("settles to the past tense once every tool in the burst completes", () => {
    expect(summarizeBurst({ bash: 1 }, false)).toBe("Ran command");
    expect(summarizeBurst({ bash: 3 }, false)).toBe("Ran 3 commands");
    expect(summarizeBurst({ edit: 2 }, false)).toBe("Edited 2 files");
    expect(summarizeBurst({ edit: 2, bash: 2 }, false)).toBe("Edited 2 files, ran 2 commands");
  });

  it("describes a burst by what it did rather than as bare commands", () => {
    expect(summarizeBurst({ web_search: 1 }, false)).toBe("Searched the web");
    expect(summarizeBurst({ web_search: 1, fetch_content: 1, get_search_content: 1 }, false)).toBe("Fetched 2 pages, searched the web");
    expect(summarizeBurst({ read: 4, grep: 2 }, false)).toBe("Read 4 files, searched code");
    expect(summarizeBurst({ bash: 5, grep: 1 }, false)).toBe("Ran 5 commands, searched code");
  });

  it("orders buckets by volume, then a stable priority for ties", () => {
    expect(summarizeBurst({ grep: 1, bash: 1 }, false)).toBe("Ran command, searched code");
    expect(summarizeBurst({ edit: 1, read: 2, bash: 3 }, false)).toBe("Ran 3 commands, read 2 files");
    expect(summarizeBurst({ bash: 1, grep: 1, edit: 1, read: 1 }, false)).toBe("Edited file, ran command");
  });

  it("treats an empty burst as a command burst (unreachable today, pinned for safety)", () => {
    expect(summarizeBurst({}, true)).toBe("Running commands");
    expect(summarizeBurst({}, false)).toBe("Ran commands");
  });
});

describe("describeTool", () => {
  it("uses the built-in verb table and the input target for known tools", () => {
    expect(describeTool("bash", { command: "git status --short" }, true)).toBe("Running git status --short");
    expect(describeTool("bash", { command: "git status --short" }, false)).toBe("Ran git status --short");
    expect(describeTool("edit", { path: "src/app.ts" }, true)).toBe("Editing src/app.ts");
    expect(describeTool("write", { file_path: "README.md" }, false)).toBe("Wrote README.md");
    expect(describeTool("grep", { pattern: "TODO" }, false)).toBe("Searched TODO");
    expect(describeTool("read", { path: "src/app.ts" }, true)).toBe("Reading src/app.ts");
  });

  it("keeps single-word tool names lowercase when a known tool has no target", () => {
    expect(describeTool("bash", undefined, true)).toBe("Running bash");
    expect(describeTool("bash", undefined, false)).toBe("Ran bash");
  });

  it("falls back to a generic verb plus a prettified display name for unknown tools", () => {
    expect(describeTool("web_search", undefined, true)).toBe("Running Web search");
    expect(describeTool("web_search", undefined, false)).toBe("Ran Web search");
    expect(describeTool("websearch", undefined, true)).toBe("Running websearch");
  });

  it("keeps the input target for unknown tools when one is present", () => {
    expect(describeTool("web_search", { query: "fitz codex" }, true)).toBe("Running fitz codex");
    expect(describeTool("web_search", { query: "fitz codex" }, false)).toBe("Ran fitz codex");
  });

  it("uses the prettified display name when an unknown tool has no recognizable target", () => {
    expect(describeTool("gh_issue", { number: 42 }, false)).toBe("Ran Gh issue");
  });
});

describe("registerToolMeta", () => {
  it("overrides presentation for a tool and describes it from the registered metadata", () => {
    registerToolMeta("__review_test_web_search__", {
      kind: "command",
      presentVerb: "Searching",
      pastVerb: "Searched",
      displayName: "Web search",
    });
    expect(describeTool("__review_test_web_search__", undefined, true)).toBe("Searching Web search");
    expect(describeTool("__review_test_web_search__", undefined, false)).toBe("Searched Web search");
    expect(activityKind("__review_test_web_search__")).toBe("command");
  });

  it("merges partial metadata over the defaults without disturbing built-ins", () => {
    registerToolMeta("__review_test_partial__", { displayName: "Partial tool" });
    expect(describeTool("__review_test_partial__", undefined, true)).toBe("Running Partial tool");
    expect(describeTool("bash", undefined, true)).toBe("Running bash");
  });

  it("lets plugins steer their burst bucket alongside presentation", () => {
    registerToolMeta("__review_test_bucket__", { bucket: "web" });
    expect(summarizeBurst({ __review_test_bucket__: 1 }, false)).toBe("Searched the web");
    expect(summarizeBurst({ __review_test_bucket__: 1, bash: 1 }, false)).toBe("Ran command, searched the web");
  });
});

describe("displayName", () => {
  it("replaces underscores with spaces and capitalizes the first word", () => {
    expect(displayName("web_search")).toBe("Web search");
    expect(displayName("apply_patch")).toBe("Apply patch");
  });

  it("leaves single-word tool names untouched", () => {
    expect(displayName("bash")).toBe("bash");
    expect(displayName("websearch")).toBe("websearch");
  });
});

describe("activityKind", () => {
  it("buckets edit and write as edits, everything else as commands", () => {
    expect(activityKind("edit")).toBe("edit");
    expect(activityKind("write")).toBe("edit");
    expect(activityKind("bash")).toBe("command");
    expect(activityKind("web_search")).toBe("command");
  });
});

describe("iconPathFor", () => {
  it("returns the tool-specific icon for built-ins and the generic icon otherwise", () => {
    expect(iconPathFor("edit")).toContain('d="m4.2 14.8');
    expect(iconPathFor("bash")).toContain('d="m6 7 2.2 2');
    expect(iconPathFor("web_search")).toContain('d="M10 2.8');
  });
});

describe("burstIconPath", () => {
  it("uses the edit icon when a burst edits files, the terminal icon otherwise", () => {
    expect(burstIconPath(1, 0)).toContain('d="m4.2 14.8');
    expect(burstIconPath(1, 2)).toContain('d="m4.2 14.8');
    expect(burstIconPath(0, 1)).toContain('d="m6 7 2.2 2');
    expect(burstIconPath(0, 0)).toContain('d="m6 7 2.2 2');
  });
});

describe("projectRelativePath", () => {
  it("strips the project root prefix from absolute paths", () => {
    expect(projectRelativePath("/home/me/proj/src/app.ts", "/home/me/proj")).toBe("src/app.ts");
    expect(projectRelativePath("C:\\work\\fitz\\src\\app.ts", "C:\\work\\fitz")).toBe("src/app.ts");
    expect(projectRelativePath("/home/me/proj/src/app.ts", "/home/me/proj/")).toBe("src/app.ts");
  });

  it("matches root prefixes case-insensitively on Windows-style paths", () => {
    expect(projectRelativePath("c:\\Work\\Fitz\\src\\app.ts", "C:\\work\\fitz")).toBe("src/app.ts");
  });

  it("leaves already-relative and out-of-root paths unchanged", () => {
    expect(projectRelativePath("src/app.ts", "/home/me/proj")).toBe("src/app.ts");
    expect(projectRelativePath("/etc/hosts", "/home/me/proj")).toBe("/etc/hosts");
    expect(projectRelativePath("/home/me/proj-other/app.ts", "/home/me/proj")).toBe("/home/me/proj-other/app.ts");
  });

  it("returns the path unchanged when no root or path is provided", () => {
    expect(projectRelativePath("/home/me/proj/src/app.ts", "")).toBe("/home/me/proj/src/app.ts");
    expect(projectRelativePath("", "/home/me/proj")).toBe("");
  });
});

describe("toolPath", () => {
  it("extracts and trims the file path across the supported field names", () => {
    expect(toolPath({ path: "src/app.ts" })).toBe("src/app.ts");
    expect(toolPath({ file_path: " README.md " })).toBe("README.md");
    expect(toolPath({ filePath: "a/b.ts" })).toBe("a/b.ts");
  });

  it("returns undefined when there is no usable path", () => {
    expect(toolPath(undefined)).toBeUndefined();
    expect(toolPath("nope")).toBeUndefined();
    expect(toolPath({ command: "ls" })).toBeUndefined();
    expect(toolPath({ path: "   " })).toBeUndefined();
    expect(toolPath({ path: 42 })).toBeUndefined();
  });
});
