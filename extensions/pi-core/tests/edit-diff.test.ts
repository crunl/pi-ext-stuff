import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createEditDiffBox, parseEditDiff } from "../src/tui/edit-diff.ts";

// Truecolor fake theme: base surface + green/red diff foregrounds, so
// buildRowBackgrounds can derive tinted row backgrounds.
const BASE_BG = "\u001b[48;2;60;60;70m";
const GREEN_FG = "\u001b[38;2;0;200;0m";
const RED_FG = "\u001b[38;2;220;40;40m";
// Expected tints: base*0.7 + diff*0.3 per channel
const ADDED_BG = "\u001b[48;2;42;102;49m";
const REMOVED_BG = "\u001b[48;2;108;54;61m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape sequences
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const theme = {
  fg: (color: string, text: string) => {
    if (color === "toolDiffAdded") {
      return `\u001b[32m${text}\u001b[39m`;
    }
    if (color === "toolDiffRemoved") {
      return `\u001b[31m${text}\u001b[39m`;
    }
    return `\u001b[90m${text}\u001b[39m`;
  },
  bg: (_color: string, text: string) => `${BASE_BG}${text}\u001b[49m`,
  getBgAnsi: (_color: string) => BASE_BG,
  getFgAnsi: (color: string) => (color === "toolDiffAdded" ? GREEN_FG : RED_FG),
} as unknown as Theme;

describe("parseEditDiff", () => {
  it("parses context, removed, and added rows with old and new line numbers", () => {
    expect(
      parseEditDiff([" 9 before", "-10 old value", "+10 new value", "+11 added value"].join("\n")),
    ).toEqual([
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
  it("aligns line numbers and tints added/removed row backgrounds", () => {
    const component = createEditDiffBox(" 9 before\n-10 old value\n+10 new value", theme, {
      outputPad: 1,
    });
    const rendered = component.render(40);
    const plain = stripAnsi(rendered.join("\n"));

    expect(rendered).toHaveLength(3);
    expect(plain).toContain("  9 │ before");
    expect(plain).toContain("- 10 │ old value");
    expect(plain).toContain("+ 10 │ new value");
    expect(rendered[0]).toContain(BASE_BG); // context: neutral box background
    expect(rendered[1]).toContain(REMOVED_BG); // removed: red-tinted
    expect(rendered[2]).toContain(ADDED_BG); // added: green-tinted
    expect(rendered.every((line) => line.startsWith(" "))).toBe(true);
  });

  it("extends row backgrounds across the full width", () => {
    const component = createEditDiffBox("+10 x", theme, { outputPad: 0 });
    const rendered = component.render(40);
    // background applies to padded row, so visible width spans the full row
    expect(visibleWidth(rendered[0])).toBe(40);
    expect(rendered[0]).toContain(ADDED_BG);
  });

  it("falls back to the uniform box background without truecolor theme data", () => {
    const nonTruecolor = {
      ...(theme as unknown as Record<string, unknown>),
      getBgAnsi: () => "\u001b[48;5;22m", // 256-color, not parseable as truecolor
    } as unknown as Theme;
    const component = createEditDiffBox("+10 x\n-11 y", nonTruecolor, { outputPad: 0 });
    const rendered = component.render(40);
    expect(rendered[0]).toContain(BASE_BG); // both rows: plain box bg
    expect(rendered[1]).toContain(BASE_BG);
  });

  it("uses an empty gutter when a long CJK diff row wraps", () => {
    const component = createEditDiffBox("+120 新增内容需要在狭窄终端正确换行", theme, {
      outputPad: 0,
    });
    const rendered = component.render(18);
    const plain = rendered.map(stripAnsi);

    expect(plain[0]).toContain("+ 120 │");
    expect(plain.slice(1).some((line) => line.includes("     │"))).toBe(true);
    expect(rendered.every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  it("renders no panel when the diff is empty", () => {
    expect(createEditDiffBox("", theme, { outputPad: 1 }).render(40)).toEqual([]);
  });

  it("applies syntax highlighting to all rows when lang is given", () => {
    const highlight = (line: string) => `\x1b[35m${line}\x1b[39m`;
    const component = createEditDiffBox(" 9 before\n-10 old value\n+10 new value", theme, {
      outputPad: 0,
      lang: "ts",
      highlight,
    });
    const rendered = component.render(60);

    expect(rendered[0]).toContain("\x1b[35mbefore\x1b[39m"); // context highlighted
    expect(rendered[2]).toContain("\x1b[35mnew value\x1b[39m"); // added highlighted
    expect(rendered[1]).toContain("\x1b[35mold value\x1b[39m"); // removed highlighted too
    expect(rendered[1]).toContain(REMOVED_BG); // removal signaled by background
    expect(stripAnsi(rendered[1])).toContain("- 10 │ old value");
  });

  it("keeps the gutter diff-colored while content is highlighted", () => {
    const highlight = (line: string) => `\x1b[35m${line}\x1b[39m`;
    const component = createEditDiffBox("+10 x", theme, {
      outputPad: 0,
      lang: "ts",
      highlight,
    });
    const rendered = component.render(60);
    // gutter colored via theme.fg(toolDiffAdded, ...) before the content colors
    expect(rendered[0].indexOf("+ 10 │")).toBeLessThan(rendered[0].indexOf("\x1b[35m"));
  });

  it("falls back to plain content when the highlighter throws", () => {
    const component = createEditDiffBox("+10 boom", theme, {
      outputPad: 0,
      lang: "ts",
      highlight: () => {
        throw new Error("boom");
      },
    });
    const plain = component.render(60).map(stripAnsi);
    expect(plain[0]).toContain("+ 10 │ boom");
  });

  it("skips highlighting entirely without a lang", () => {
    const highlight = () => {
      throw new Error("must not be called");
    };
    const component = createEditDiffBox("+10 x", theme, { outputPad: 0, highlight });
    expect(stripAnsi(component.render(60)[0])).toContain("+ 10 │ x");
  });
});
