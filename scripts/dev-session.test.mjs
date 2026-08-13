import { describe, expect, it } from "vitest";
import { findWorkspaceDevRoots, recordMatchesProcess } from "./dev-session.mjs";

describe("dev session process ownership", () => {
  it("selects each matching workspace controller once and ignores other checkouts", () => {
    const processes = [
      processEntry(10, 1, "node scripts/dev.mjs"),
      processEntry(11, 10, 'node C:\\repo\\node_modules\\tsx\\dist\\cli.mjs watch C:\\repo\\apps\\host\\src\\server.ts'),
      processEntry(12, 11, 'node --import tsx C:\\repo\\apps\\host\\src\\server.ts'),
      processEntry(20, 1, "node scripts/dev.mjs"),
      processEntry(21, 20, 'node C:\\other\\node_modules\\tsx\\dist\\cli.mjs watch C:\\other\\apps\\host\\src\\server.ts'),
    ];

    expect(findWorkspaceDevRoots("C:\\repo", processes, 999)).toEqual([10]);
  });

  it("falls back to the exact orphaned source-host process without climbing into a shell", () => {
    const processes = [
      processEntry(30, 1, "powershell"),
      processEntry(31, 30, 'node --import tsx C:\\repo\\apps\\host\\src\\server.ts'),
    ];

    expect(findWorkspaceDevRoots("C:\\repo", processes, 999)).toEqual([31]);
  });

  it("uses command identity and creation time to avoid terminating a reused PID", () => {
    const owner = { startedAt: "2026-08-13T12:00:00.000Z" };
    expect(recordMatchesProcess(owner, processEntry(40, 1, "node scripts/dev.mjs", "2026-08-13T12:00:01.000Z"))).toBe(true);
    expect(recordMatchesProcess(owner, processEntry(40, 1, "node scripts/dev.mjs", "2026-08-13T11:00:00.000Z"))).toBe(false);
    expect(recordMatchesProcess(owner, processEntry(40, 1, "node unrelated.mjs", "2026-08-13T12:00:01.000Z"))).toBe(false);
  });
});

function processEntry(pid, parentPid, commandLine, startedAt = "2026-08-13T12:00:00.000Z") {
  return { pid, parentPid, commandLine, startedAt };
}
