import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  createEditDiffBox,
  parseEditDiff,
} from "../src/tui/edit-diff.ts";

const BG_START = "\u001b[48;5;22m";
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const theme = {
  fg: (color: string, text: string) => {
    if (color === "toolDiffAdded") {
      return `\u001b[32m${text}\u001b[0m`;
    }
    if (color === "toolDiffRemoved") {
      return `\u001b[31m${text}\u001b[0m`;
    }
    return `\u001b[90m${text}\u001b[0m`;
  },
  bg: (_color: string, text: string) =>
    `${BG_START}${text}\u001b[0m`,
} as Theme;

describe("parseEditDiff", () => {
  it("parses context, removed, and added rows with old and new line numbers", () => {
    expect(parseEditDiff([
      " 9 before",
      "-10 old value",
      "+10 new value",
      "+11 added value",
    ].join("\n"))).toEqual([
      { kind: "context", lineNumber: 9, content: "before" },
      { kind: "removed", lineNumber: 10, content: "old value" },
      { kind: "added", lineNumber: 10, content: "new value" },
      { kind: "added", lineNumber: 11, content: "added value" },
    ]);
  });

  it("preserves an unrecognized row as context content", () => {
    expect(parseEditDiff("\\ No newline at end of file")).toEqual([
      {
        kind: "context",
        lineNumber: undefined,
        content: "\\ No newline at end of file",
      },
    ]);
  });

  it("returns no rows for an empty diff", () => {
    expect(parseEditDiff("")).toEqual([]);
  });
});

describe("createEditDiffBox", () => {
  it("aligns old and new line numbers inside an Edit-only background box", () => {
    const component = createEditDiffBox(
      " 9 before\n-10 old value\n+10 new value",
      theme,
      { outputPad: 1 },
    );
    const rendered = component.render(40);
    const plain = stripAnsi(rendered.join("\n"));

    expect(rendered).toHaveLength(3);
    expect(plain).toContain("  9 │ before");
    expect(plain).toContain("- 10 │ old value");
    expect(plain).toContain("+ 10 │ new value");
    expect(rendered.some((line) => line.includes(BG_START))).toBe(true);
    expect(rendered.every((line) => line.startsWith(" "))).toBe(true);
  });

  it("uses an empty gutter when a long CJK diff row wraps", () => {
    const component = createEditDiffBox(
      "+120 新增内容需要在狭窄终端正确换行",
      theme,
      { outputPad: 0 },
    );
    const rendered = component.render(18);
    const plain = rendered.map(stripAnsi);

    expect(plain[0]).toContain("+ 120 │");
    expect(plain.slice(1).some((line) => line.includes("     │"))).toBe(true);
    expect(rendered.every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  it("renders no panel when the diff is empty", () => {
    expect(createEditDiffBox("", theme, { outputPad: 1 }).render(40)).toEqual(
      [],
    );
  });
});
