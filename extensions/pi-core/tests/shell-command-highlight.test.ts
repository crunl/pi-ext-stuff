import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { highlightShellCommandLines } from "../src/tui/shell-command-highlight.ts";

beforeAll(() => {
  initTheme("dark", false);
});

describe("highlightShellCommandLines", () => {
  it("highlights command-position executables after separators", () => {
    const lines = highlightShellCommandLines("echo a && grep -rn xai . | head");
    const plain = lines.join("\n");
    // grep and head sit at command positions after && and |
    expect(plain).toContain("echo");
    expect(plain).toContain("grep");
    expect(plain).toContain("head");
    // Must emit ANSI (shell/code coloring)
    expect(plain.includes(String.fromCharCode(27))).toBe(true);
  });

  it("does not treat VAR=value assignments as command position", () => {
    const lines = highlightShellCommandLines("B=/tmp/file.md; wc -l $B");
    const plain = lines.join("\n");
    expect(plain).toContain("B=");
    expect(plain).toContain("wc");
  });

  it("returns empty for empty command", () => {
    expect(highlightShellCommandLines("")).toEqual([]);
  });
});
