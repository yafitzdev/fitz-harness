import { describe, expect, it } from "vitest";
import { evaluateToolCall, type PolicyContext } from "./policy.js";
import type { ToolActionEffect } from "@fitz/protocol";

const CWD = "/mnt/c/Users/yanfi/projects/example";
const HOME = "/home/user";
const TRASH = `${CWD}/.fitz-trash/run-1`;

interface TrashCall { runId: string; workspaceRoot: string; path: string; sequence: number }
interface RecordedAction { toolName: string; effect: ToolActionEffect; path?: string; detail?: Readonly<Record<string, unknown>> }
interface RecordedTrashEntry { workspaceRoot: string; originalPath: string; trashPath: string }

function makeContext(overrides: Partial<PolicyContext> = {}): { ctx: PolicyContext; trashCalls: TrashCall[]; records: RecordedAction[]; createdPaths: Set<string>; trashEntries: RecordedTrashEntry[] } {
  const trashCalls: TrashCall[] = [];
  const records: RecordedAction[] = [];
  const trashEntries: RecordedTrashEntry[] = [];
  const createdPaths = new Set<string>();
  const ctx: PolicyContext = {
    runId: "run-1",
    cwd: CWD,
    homeDir: HOME,
    runtimeDirs: [],
    tempDirs: ["/tmp"],
    trashDir: TRASH,
    trash: {
      move: async (input) => { trashCalls.push(input); return `${TRASH}/${input.sequence}-moved`; },
      record: (input) => trashEntries.push(input),
    },
    nextSequence: () => 1,
    log: { record: (entry) => records.push(entry as RecordedAction) },
    createdPaths,
    ...overrides,
  };
  return { ctx, trashCalls, records, createdPaths, trashEntries };
}

async function bash(ctx: PolicyContext, command: string) {
  return evaluateToolCall({ toolName: "bash", input: { command } }, ctx);
}

describe("delete policy (trash-everything)", () => {
  it("rewrites rm of a workspace path into a trash move (the Reddit typo scenario)", async () => {
    const { ctx, trashCalls, trashEntries } = makeContext();
    const outcome = await bash(ctx, `rm -rf ${CWD}/Documents`);
    expect(outcome.action).toBe("rewrite");
    if (outcome.action === "rewrite") {
      expect(outcome.input.command).toBe(`mv ${CWD}/Documents ${TRASH}/1-Documents`);
    }
    // The rewrite never performs a real delete, so the trash service is untouched here;
    // the rewritten command itself is the mechanism. But the entry is recorded so the
    // management API can restore the file once the shell move lands.
    expect(trashCalls).toHaveLength(0);
    expect(trashEntries).toEqual([{ workspaceRoot: CWD, originalPath: "C:/Users/yanfi/projects/example/Documents", trashPath: `${TRASH}/1-Documents` }]);
  });

  it("rewrites rm of relative workspace paths too", async () => {
    const { ctx } = makeContext();
    const outcome = await bash(ctx, "rm -rf build dist");
    expect(outcome.action).toBe("rewrite");
    if (outcome.action === "rewrite") expect(outcome.input.command).toBe(`mv build ${TRASH}/1-build; mv dist ${TRASH}/1-dist`);
  });

  it("rewrites quoted workspace deletes preserving the original path text", async () => {
    const { ctx } = makeContext();
    const outcome = await bash(ctx, `rm "my folder"`);
    expect(outcome.action).toBe("rewrite");
    if (outcome.action === "rewrite") expect(outcome.input.command).toBe(`mv "my folder" '${TRASH}/1-my folder'`);
  });

  it("blocks rm -rf of the current directory and of the workspace root", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, "rm -rf .")).resolves.toEqual({ action: "block", reason: expect.stringContaining("current or containing directory") });
    await expect(bash(ctx, `rm -rf ${CWD}`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("entire project workspace") });
  });

  it("blocks deletes of sensitive locations (the real Reddit trigger)", async () => {
    const { ctx } = makeContext();
    const outcome = await bash(ctx, `rm -rf ${HOME}/.ssh`);
    expect(outcome.action).toBe("block");
    if (outcome.action === "block") expect(outcome.reason).toContain("secrets");
    await expect(bash(ctx, `rm -rf ${HOME}/.aws`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
  });

  it("blocks deletes of system paths and drive roots", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, "rm -rf C:/Windows/System32")).resolves.toEqual({ action: "block", reason: expect.stringContaining("operating-system") });
    await expect(bash(ctx, "rm -rf /etc")).resolves.toEqual({ action: "block", reason: expect.stringContaining("operating-system") });
  });

  it("blocks deletes outside the workspace but allows temp deletes", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, `rm -rf ${HOME}/Documents`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("outside the project workspace") });
    await expect(bash(ctx, "rm /tmp/setup.log")).resolves.toEqual({ action: "allow" });
  });

  it("blocks mixed workspace + temp deletes instead of splitting the rewrite", async () => {
    const { ctx } = makeContext();
    const outcome = await bash(ctx, `rm -rf ${CWD}/build /tmp/cache.tmp`);
    expect(outcome.action).toBe("block");
    if (outcome.action === "block") expect(outcome.reason).toContain("Split them");
  });

  it("blocks deletes of the Fitz trash itself", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, `rm -rf ${TRASH}/1-old.txt`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("Fitz trash") });
  });

  it("blocks destructive operations it cannot rewrite", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, "git reset --hard")).resolves.toEqual({ action: "block", reason: expect.stringContaining("git") });
    await expect(bash(ctx, "git clean -fd")).resolves.toEqual({ action: "block", reason: expect.stringContaining("git") });
    await expect(bash(ctx, `python -c "import os; os.remove('x.txt')"`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("Python") });
    await expect(bash(ctx, "shred -u secrets.txt")).resolves.toEqual({ action: "block", reason: expect.stringContaining("shred") });
    await expect(bash(ctx, "find . -type f -exec rm {} \\;")).resolves.toEqual({ action: "block", reason: expect.stringContaining("find -exec rm") });
    await expect(bash(ctx, "rsync -av --delete src/ dst/")).resolves.toEqual({ action: "block", reason: expect.stringContaining("--delete") });
    await expect(bash(ctx, "find . -type f | xargs rm")).resolves.toEqual({ action: "block", reason: expect.stringContaining("xargs") });
  });

  it("rewrites find -delete under the workspace into a trash move and allows it under temp", async () => {
    const { ctx } = makeContext();
    const outcome = await bash(ctx, "find build -name '*.tmp' -delete");
    expect(outcome.action).toBe("rewrite");
    if (outcome.action === "rewrite") expect(outcome.input.command).toBe(`find build -name '*.tmp' -exec mv -t ${TRASH} {} +`);
    await expect(bash(ctx, "find /tmp -name '*.tmp' -delete")).resolves.toEqual({ action: "allow" });
  });

  it("blocks find -delete outside the workspace", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, `find ${HOME}/Downloads -name '*.tmp' -delete`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("outside") });
  });

  it("records the outcome in the action log", async () => {
    const { ctx, records } = makeContext();
    await bash(ctx, `rm -rf ${CWD}/build`);
    expect(records).toEqual([{ toolName: "bash", effect: "rewrite", detail: expect.objectContaining({ original: `rm -rf ${CWD}/build` }) }]);
    await bash(ctx, `rm -rf ${HOME}/.ssh`);
    expect(records[1]).toMatchObject({ toolName: "bash", effect: "block", detail: expect.objectContaining({ reasons: expect.arrayContaining([expect.stringContaining("secrets")]) }) });
  });
});

describe("write policy", () => {
  it("allows writes inside the workspace and tracks created paths", async () => {
    const { ctx, createdPaths } = makeContext();
    await expect(bash(ctx, "echo x > notes.txt")).resolves.toEqual({ action: "allow" });
    await expect(bash(ctx, `cp a.txt ${CWD}/dst.txt`)).resolves.toEqual({ action: "allow" });
    expect(createdPaths.has("c:/users/yanfi/projects/example/notes.txt")).toBe(true);
    expect(createdPaths.has("c:/users/yanfi/projects/example/dst.txt")).toBe(true);
  });

  it("blocks writes outside the workspace, to sensitive files, and to system paths", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, `echo x > ${HOME}/notes.txt`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("outside") });
    await expect(bash(ctx, "echo x > ~/.aws/credentials")).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
    await expect(bash(ctx, "echo x > /etc/hosts")).resolves.toEqual({ action: "block", reason: expect.stringContaining("operating-system") });
  });

  it("allows writes into temp and runtime dirs", async () => {
    const { ctx } = makeContext();
    const withRuntime = makeContext({ runtimeDirs: ["/mnt/c/Users/yanfi/AppData/Local/Fitz/pi"] });
    await expect(bash(ctx, "echo x > /tmp/x.log")).resolves.toEqual({ action: "allow" });
    await expect(bash(withRuntime.ctx, "echo x > /mnt/c/Users/yanfi/AppData/Local/Fitz/pi/extensions/x.txt")).resolves.toEqual({ action: "allow" });
  });

  it("applies the same zone rules to the write and edit tools", async () => {
    const { ctx } = makeContext();
    await expect(evaluateToolCall({ toolName: "write", input: { path: "src/new.ts" } }, ctx)).resolves.toEqual({ action: "allow" });
    await expect(evaluateToolCall({ toolName: "edit", input: { path: `${HOME}/notes.md` } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("outside") });
    await expect(evaluateToolCall({ toolName: "edit", input: { path: "~/.ssh/config" } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
  });
});

describe("read policy", () => {
  it("blocks reads of sensitive and system paths through the read tool", async () => {
    const { ctx } = makeContext();
    await expect(evaluateToolCall({ toolName: "read", input: { path: "~/.ssh/id_rsa" } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
    await expect(evaluateToolCall({ toolName: "read", input: { path: "C:/Windows/System32/config/system" } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("operating-system") });
  });

  it("allows reads inside the workspace, temp, and harmless outside paths", async () => {
    const { ctx } = makeContext();
    await expect(evaluateToolCall({ toolName: "read", input: { path: "README.md" } }, ctx)).resolves.toEqual({ action: "allow" });
    await expect(evaluateToolCall({ toolName: "read", input: { path: "/tmp/x.log" } }, ctx)).resolves.toEqual({ action: "allow" });
    await expect(evaluateToolCall({ toolName: "read", input: { path: `${HOME}/notes.md` } }, ctx)).resolves.toEqual({ action: "allow" });
  });

  it("blocks bash reads of secrets (cat/grep) while allowing workspace reads", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, `cat ${HOME}/.ssh/id_rsa`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
    await expect(bash(ctx, `grep -r password ${HOME}/.aws`)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
    await expect(bash(ctx, "cat README.md")).resolves.toEqual({ action: "allow" });
    await expect(bash(ctx, `cat ${CWD}/.env`)).resolves.toEqual({ action: "allow" });
  });

  it("blocks grep/find/ls on sensitive or system roots", async () => {
    const { ctx } = makeContext();
    await expect(evaluateToolCall({ toolName: "grep", input: { path: `${HOME}/.ssh` } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("secrets") });
    await expect(evaluateToolCall({ toolName: "find", input: { path: "/etc" } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("operating-system") });
    await expect(evaluateToolCall({ toolName: "ls", input: { path: `${TRASH}` } }, ctx)).resolves.toEqual({ action: "block", reason: expect.stringContaining("Fitz trash") });
  });
});

describe("misc policy behavior", () => {
  it("lets the fitz_trash tool and unknown tools through (their handlers enforce zones)", async () => {
    const { ctx } = makeContext();
    await expect(evaluateToolCall({ toolName: "fitz_trash", input: { paths: [`${CWD}/x.txt`] } }, ctx)).resolves.toEqual({ action: "allow" });
    await expect(evaluateToolCall({ toolName: "git", input: { command: "status" } }, ctx)).resolves.toEqual({ action: "allow" });
  });

  it("honors an aborted signal", async () => {
    const { ctx } = makeContext();
    const controller = new AbortController();
    controller.abort();
    await expect(evaluateToolCall({ toolName: "bash", input: { command: "rm x" } }, ctx, controller.signal)).resolves.toEqual({ action: "block", reason: "The run was cancelled" });
  });

  it("treats empty and non-bash commands as harmless", async () => {
    const { ctx } = makeContext();
    await expect(bash(ctx, "")).resolves.toEqual({ action: "allow" });
    await expect(evaluateToolCall({ toolName: "bash", input: {} }, ctx)).resolves.toEqual({ action: "allow" });
  });
});
