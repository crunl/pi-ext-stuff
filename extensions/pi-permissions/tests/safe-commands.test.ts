import { describe, expect, it } from "vitest";
import { isKnownSafeCommand } from "../src/permissions/safe-commands.ts";

describe("read-only whitelist (codex-aligned)", () => {
  it("auto-approves plain read-only commands", () => {
    for (const command of [
      "ls",
      "ls -la",
      "cat src/a.ts",
      "grep -rn pattern src",
      "head -20 file.txt",
      "tail -f log",
      "wc -l file.ts",
      "pwd",
      "git status",
      "git log --oneline -5",
      "git diff HEAD",
      "git branch",
      "git branch --show-current",
      "git branch -a --list",
      "base64 README.md",
      "sed -n 5p file.txt",
      "sed -n 1,5p file.txt",
      "nl -ba file.txt",
      'bash -lc "ls && grep pattern file"',
      "stat file.ts",
    ]) {
      expect(isKnownSafeCommand(command), command).toBe(true);
    }
  });

  it("does not auto-approve mutating or unsafe commands", () => {
    for (const command of [
      "rm file.txt",
      "rm -rf build",
      "git push",
      "git commit -m x",
      "git branch feature",
      "git checkout main",
      "find . -exec rm {} \\;",
      "find . -delete",
      "base64 -o out.txt file.txt",
      "npm install",
      "npm test",
      "python script.py",
      "sed -i s/a/b/ file.txt",
      'bash -lc "rm -rf build"',
      'bash -lc "ls && rm x"',
      "rg -z --search-zip pattern .",
      "rg --pre 'cat' pattern .",
    ]) {
      expect(isKnownSafeCommand(command), command).toBe(false);
    }
  });

  it("allows plain safe-command combinations but rejects mixed ones", () => {
    expect(isKnownSafeCommand("ls && cat x")).toBe(true);
    expect(isKnownSafeCommand("ls; pwd")).toBe(true);
    expect(isKnownSafeCommand("ls && rm x")).toBe(false);
    expect(isKnownSafeCommand("ls > out.txt")).toBe(false);
  });
});
