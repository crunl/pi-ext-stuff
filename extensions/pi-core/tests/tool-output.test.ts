import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripTerminalSequences,
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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

  it.each([1, 4])("fits omission hints within the terminal width with %i rows", (maxRows) => {
    const lines = buildOutputPreview("1\n2\n3\n4\n5\n6\n7\n8", 12, maxRows);

    expect(lines.length).toBeLessThanOrEqual(maxRows);
    expect(lines.some((line) => line.includes("… +"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
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

describe("narrow output layout", () => {
  it.each([-1, 0])("returns no rows when the width is %i", (width) => {
    expect(buildExpandedOutput("content", width)).toEqual([]);
    expect(buildOutputPreview("content", width)).toEqual([]);
  });

  it.each([
    { width: 1, outputPad: 0, expected: ["a", "b", "c", "d", "e", "f"] },
    { width: 4, outputPad: 0, expected: ["abcd", "ef"] },
    { width: 5, outputPad: 1, expected: ["abcde", "f"] },
  ] as const)(
    "gives content the full $width columns when prefixes cannot fit",
    ({ width, outputPad, expected }) => {
      expect(buildExpandedOutput("abcdef", width, outputPad)).toEqual(expected);
      expect(buildOutputPreview("abcdef", width, 6, outputPad)).toEqual(expected);
    },
  );
});

describe("output column contract", () => {
  it.each([
    "",
    "\n\n",
    "alpha beta gamma delta epsilon zeta eta theta\nlast",
    "abcdefghijklmnopqrstuvwxyz0123456789",
    "\u001b[31m红色 输出 内容\u001b[0m",
    "👨‍👩‍👧‍👦🙂🇨🇳a\u0301",
    "a\tb\r\nc",
    Array.from({ length: 125 }, (_, index) => `line ${index}`).join("\n"),
  ])("bounds every output row for input %#", (text) => {
    for (const width of [...Array.from({ length: 33 }, (_, index) => index), 80]) {
      for (const outputPad of [0, 1] as const) {
        const expanded = buildExpandedOutput(text, width, outputPad);
        expect(expanded.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (text.length > 0 && width > 0) expect(expanded.length).toBeGreaterThan(0);

        for (const maxRows of [0, 1, 4, 5]) {
          const preview = buildOutputPreview(text, width, maxRows, outputPad);
          expect(preview.length).toBeLessThanOrEqual(maxRows);
          expect(preview.every((line) => visibleWidth(line) <= width)).toBe(true);
          if (text.length > 0 && width > 0 && maxRows > 0) {
            expect(preview.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("preserves whole wide graphemes when decoration is dropped", () => {
    const lines = buildExpandedOutput("\u001b[31m中👨‍👩‍👧‍👦a\u0301\u001b[0m", 2, 1);

    expect(lines.map(stripTerminalSequences)).toEqual(["中", "👨‍👩‍👧‍👦", "a\u0301"]);
    expect(lines.join("")).toContain("\u001b[31m");
  });
});

describe("host differential rendering", () => {
  it("updates a 12-column terminal without stopping on an omission hint", () => {
    const terminal = {
      columns: 12,
      rows: 24,
      kittyProtocolActive: false,
      start: vi.fn(),
      stop: vi.fn(),
      drainInput: vi.fn(async () => {}),
      write: vi.fn<(data: string) => void>(),
      moveBy: vi.fn(),
      hideCursor: vi.fn(),
      showCursor: vi.fn(),
      clearLine: vi.fn(),
      clearFromCursor: vi.fn(),
      clearScreen: vi.fn(),
      setTitle: vi.fn(),
      setProgress: vi.fn(),
    } satisfies Terminal;
    const logDirectory = mkdtempSync(join(tmpdir(), "pi-core-output-test-"));
    const tui = new TuiMainScreen(terminal, false, logDirectory);
    let text = "ok";
    tui.addChild({
      render: (width) => buildOutputPreview(text, width, 4),
      invalidate() {},
    });

    try {
      tui.renderNow();
      expect(terminal.write).toHaveBeenCalled();
      terminal.write.mockClear();
      text = "1\n2\n3\n4\n5\n6\n7\n8";

      // First/forced renders bypass the host's differential width check.
      expect(() => tui.renderNow()).not.toThrow();
      expect(terminal.stop).not.toHaveBeenCalled();
      const output = stripTerminalSequences(
        terminal.write.mock.calls.map(([data]) => data).join(""),
      );
      expect(output).toContain("… +5");
      expect(output).toContain("    8");
    } finally {
      tui.stop();
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });
});

describe("countNonEmptyLines", () => {
  it("counts result entries without counting blank trailing lines", () => {
    expect(countNonEmptyLines("one\n\n two \n")).toBe(2);
  });
});
