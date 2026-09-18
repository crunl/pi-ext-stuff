import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createReadEvidence,
  READ_EVIDENCE_MAX_CHARS,
  READ_EVIDENCE_MAX_LINES,
  summarizeReadLines,
} from "../src/tui/read-evidence.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

beforeAll(() => {
  initTheme("dark", false);
});

function renderEvidence(options: {
  path: string;
  text: string;
  startLine?: number;
  outputPad?: number;
  width?: number;
}): string[] {
  return createReadEvidence({
    path: options.path,
    text: options.text,
    theme,
    outputPad: (options.outputPad ?? 0) as never,
    startLine: options.startLine ?? 1,
  })
    .render(options.width ?? 80)
    .map((line) => stripTerminalSequences(line));
}

describe("summarizeReadLines", () => {
  it("counts file lines and omits count on failure", () => {
    const result = { content: [{ type: "text", text: "a\nb\nc" }] };
    expect(summarizeReadLines(result, {}, { isError: false })).toBe("3 lines");
    expect(summarizeReadLines(result, {}, { isError: true })).toBeUndefined();
    expect(
      summarizeReadLines({ content: [{ type: "text", text: "only" }] }, {}, { isError: false }),
    ).toBe("1 line");
  });
});

describe("createReadEvidence", () => {
  it("renders absolute line numbers under a dim gutter, never the bash └ rail", () => {
    const lines = renderEvidence({
      path: "src/a.ts",
      text: "export const a = 1;\nexport const b = 2;\n",
      startLine: 10,
    });
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("10 │");
    expect(lines[1]).toContain("11 │");
    expect(lines.join("\n")).not.toContain("└");
  });

  it("emits ANSI syntax highlight for known language paths", () => {
    const component = createReadEvidence({
      path: "src/a.ts",
      text: "export const a = 1;",
      theme,
      outputPad: 0 as never,
      startLine: 1,
    });
    const raw = component.render(80).join("\n");
    expect(raw.includes(String.fromCharCode(27))).toBe(true);
  });

  it("falls back to plain content when the path has no language", () => {
    const lines = renderEvidence({ path: "README.unknownext", text: "hello world" });
    expect(lines[0]).toContain("1 │");
    expect(lines[0]).toContain("hello world");
  });

  it("expands tabs to spaces like the write preview", () => {
    const lines = renderEvidence({ path: "a.txt", text: "col\tnext" });
    expect(lines[0]).toContain("col   next");
    expect(lines[0]).not.toContain("\t");
  });

  it("caps long files by line count and reports omitted lines", () => {
    const text = Array.from(
      { length: READ_EVIDENCE_MAX_LINES + 20 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const lines = renderEvidence({ path: "big.log", text });
    expect(lines.length).toBe(READ_EVIDENCE_MAX_LINES + 1);
    expect(lines[lines.length - 1]).toContain("… +20 lines");
  });

  it("caps by character budget when a few lines are huge", () => {
    const huge = "x".repeat(Math.floor(READ_EVIDENCE_MAX_CHARS / 2) + 10);
    const text = `${huge}\n${huge}\n${huge}`;
    const lines = renderEvidence({ path: "wide.log", text });
    const body = lines.filter((line) => !line.includes("… +"));
    expect(body.length).toBeLessThan(3);
    expect(lines[lines.length - 1]).toMatch(/… \+\d+ lines/u);
  });

  it("truncates long rows to width without wrapping", () => {
    const long = "x".repeat(200);
    const width = 40;
    const lines = renderEvidence({ path: "a.ts", text: long, width });
    expect(lines.length).toBe(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("honors outputPad on every evidence row", () => {
    const lines = renderEvidence({ path: "a.ts", text: "one", outputPad: 1 });
    expect(lines[0].startsWith(" ")).toBe(true);
  });
});
