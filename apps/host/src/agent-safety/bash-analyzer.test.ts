import { describe, expect, it } from "vitest";
import { analyzeBashCommand, tokenize } from "./bash-analyzer.js";

describe("analyzeBashCommand", () => {
  it("detects plain deletes with span-accurate targets", () => {
    const analysis = analyzeBashCommand("rm -rf build/ dist/");
    expect(analysis.intents).toHaveLength(1);
    const intent = analysis.intents[0]!;
    expect(intent.type).toBe("delete");
    expect(intent.kind).toBe("delete");
    expect(intent.command).toBe("rm");
    expect(intent.flags).toEqual(["-rf"]);
    expect(intent.targets.map((target) => target.raw)).toEqual(["build/", "dist/"]);
    expect(intent.targets.map((target) => target.unquoted)).toEqual(["build/", "dist/"]);
  });

  it("preserves quotes in raw while exposing unquoted text for classification", () => {
    const analysis = analyzeBashCommand(`rm "my folder"`);
    const target = analysis.intents[0]!.targets[0]!;
    expect(target.raw).toBe('"my folder"');
    expect(target.unquoted).toBe("my folder");
  });

  it("flags broad recursive deletes", () => {
    expect(analyzeBashCommand("rm -rf .").intents[0]!.broad).toBe(true);
    expect(analyzeBashCommand("rm -rf ./").intents[0]!.broad).toBe(true);
    expect(analyzeBashCommand("rm -rf *").intents[0]!.broad).toBe(true);
    expect(analyzeBashCommand("rm -rf src").intents[0]!.broad).toBe(false);
  });

  it("detects find -delete and find -exec rm", () => {
    const deleteIntent = analyzeBashCommand("find build -name '*.tmp' -delete").intents;
    expect(deleteIntent).toHaveLength(1);
    expect(deleteIntent[0]).toMatchObject({ type: "delete", kind: "find-delete" });
    expect(deleteIntent[0]!.targets.map((target) => target.raw)).toEqual(["build"]);

    const execIntent = analyzeBashCommand("find . -name '*.log' -exec rm {} \\;").intents;
    expect(execIntent[0]).toMatchObject({ type: "block", kind: "find-exec-rm" });
  });

  it("blocks destructive git operations", () => {
    for (const command of [
      "git clean -fd",
      "git reset --hard",
      "git checkout -- src/x.ts",
      "git restore .",
      "git branch -D topic",
      "git stash drop",
      "git stash clear",
    ]) {
      expect(analyzeBashCommand(command).intents[0], command).toMatchObject({ type: "block", kind: "git-destructive" });
    }
    // Non-destructive git commands produce no intent.
    expect(analyzeBashCommand("git status").intents).toHaveLength(0);
    expect(analyzeBashCommand("git reset --soft HEAD~1").intents).toHaveLength(0);
  });

  it("blocks inline python and node deletions", () => {
    expect(analyzeBashCommand(`python -c "import os; os.remove('x.txt')"`).intents[0]).toMatchObject({ type: "block", kind: "python-rm" });
    expect(analyzeBashCommand(`python3 -c "import shutil; shutil.rmtree('build')"`).intents[0]).toMatchObject({ type: "block", kind: "python-rm" });
    expect(analyzeBashCommand(`node -e "require('fs').unlinkSync('x.txt')"`).intents[0]).toMatchObject({ type: "block", kind: "node-rm" });
  });

  it("blocks xargs rm, shred and rsync --delete", () => {
    expect(analyzeBashCommand("find . -type f | xargs rm").intents[0]).toMatchObject({ type: "block", kind: "xargs-rm" });
    expect(analyzeBashCommand("shred -u secrets.txt").intents[0]).toMatchObject({ type: "block", kind: "shred" });
    expect(analyzeBashCommand("rsync -av --delete src/ dst/").intents[0]).toMatchObject({ type: "block", kind: "rsync-delete" });
  });

  it("tracks write destinations for cp, mv, tee, curl and dd", () => {
    const writeOf = (command: string) => analyzeBashCommand(command).intents.find((intent) => intent.type === "write");
    const readOf = (command: string) => analyzeBashCommand(command).intents.find((intent) => intent.type === "read");

    const cp = writeOf("cp a.txt /home/user/dst.txt")!;
    expect(cp).toMatchObject({ type: "write", kind: "write" });
    expect(cp.targets[0]!.unquoted).toBe("/home/user/dst.txt");
    // The source is classified as a read so `cp /etc/passwd .` cannot smuggle a system read.
    expect(readOf("cp a.txt /home/user/dst.txt")!.targets[0]!.unquoted).toBe("a.txt");

    const mv = writeOf("mv src.ts /mnt/c/Users/yanfi/projects/example/dst.ts")!;
    expect(mv.targets[0]!.unquoted).toBe("/mnt/c/Users/yanfi/projects/example/dst.ts");

    expect(writeOf("curl -o out.bin https://example.com/x")).toMatchObject({ type: "write" });
    expect(writeOf("curl --output out.bin https://example.com/x")).toMatchObject({ type: "write" });
    expect(writeOf("dd if=/dev/zero of=disk.img bs=1M count=1")!.targets[0]!.unquoted).toBe("disk.img");
    // dd's input file is a read source too.
    expect(readOf("dd if=/dev/zero of=disk.img bs=1M count=1")!.targets[0]!.unquoted).toBe("/dev/zero");
  });

  it("detects redirection writes and reads", () => {
    expect(analyzeBashCommand("echo hi > notes.txt").intents[0]).toMatchObject({ type: "write", command: ">" });
    expect(analyzeBashCommand(": > config.json").intents[0]).toMatchObject({ type: "write", command: ">" });
    expect(analyzeBashCommand("cat < input.txt").intents.some((intent) => intent.type === "read")).toBe(true);
  });

  it("sees through wrappers like sudo and nohup", () => {
    const intent = analyzeBashCommand("sudo rm -rf /mnt/c/Users/yanfi/projects/example/build").intents[0]!;
    expect(intent.type).toBe("delete");
    expect(analyzeBashCommand("nohup rm /tmp/x.log").intents[0]).toMatchObject({ type: "delete" });
  });

  it("tokenizes quotes, globs, and separators", () => {
    const tokens = tokenize(`rm -rf 'a b' *.tmp; echo done`);
    expect(tokens.map((token) => token.text)).toEqual(["rm", "-rf", "a b", "*.tmp", ";", "echo", "done"]);
    expect(tokens.map((token) => token.kind)).toEqual(["word", "word", "word", "glob", "sep", "word", "word"]);
  });
});
