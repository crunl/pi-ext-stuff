import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  buildExpandedOutput,
  buildOutputPreview,
  countNonEmptyLines,
} from "../src/tui/tool-output.ts";

describe("buildOutputPreview", () => {
  it("keeps the head and tail within the Codex five-row budget", () => {
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(buildOutputPreview(output, 80, 5)).toEqual([
      "  └ line 1",
      "    line 2",
      "    … +4 lines",
      "    line 7",
      "    line 8",
    ]);
  });

  it("applies the row budget after wrapping", () => {
    const lines = buildOutputPreview("alpha beta gamma delta epsilon zeta eta theta\nlast", 12, 5);

    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.some((line) => line.includes("… +"))).toBe(true);
    expect(lines.at(-1)).toContain("last");
  });

  it("preserves ANSI and respects terminal width for CJK output", () => {
    const lines = buildExpandedOutput("\u001b[31m红色 输出 内容\u001b[0m", 12);

    expect(lines.join("")).toContain("红色");
    expect(lines.join("")).toContain("\u001b[31m");
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  it("applies output padding before the nested output prefix", () => {
    expect(buildOutputPreview("first\nsecond", 80, 5, 1)).toEqual(["   └ first", "     second"]);
    expect(buildExpandedOutput("first\nsecond", 80, 1)).toEqual(["   └ first", "     second"]);
  });
});

describe("countNonEmptyLines", () => {
  it("counts result entries without counting blank trailing lines", () => {
    expect(countNonEmptyLines("one\n\n two \n")).toBe(2);
  });
});
