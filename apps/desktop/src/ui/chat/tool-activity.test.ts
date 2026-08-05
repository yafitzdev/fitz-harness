import { describe, expect, it } from "vitest";
import { activityKind, burstLabel, describeTool, displayName, iconPathFor } from "./tool-activity.js";

describe("burstLabel", () => {
  it("uses the present tense while a burst is running", () => {
    expect(burstLabel(0, 1, true)).toBe("Running command");
    expect(burstLabel(0, 3, true)).toBe("Running commands");
    expect(burstLabel(1, 0, true)).toBe("Editing file");
    expect(burstLabel(2, 0, true)).toBe("Editing files");
    expect(burstLabel(1, 1, true)).toBe("Editing files, running commands");
  });

  it("settles to the past tense once every tool in the burst completes", () => {
    expect(burstLabel(0, 1, false)).toBe("Ran command");
    expect(burstLabel(0, 3, false)).toBe("Ran commands");
    expect(burstLabel(1, 0, false)).toBe("Edited file");
    expect(burstLabel(2, 0, false)).toBe("Edited files");
    expect(burstLabel(2, 2, false)).toBe("Edited files, ran commands");
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
