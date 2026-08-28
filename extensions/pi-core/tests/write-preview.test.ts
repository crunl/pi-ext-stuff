import { describe, expect, it } from "vitest";
import { renderWritePreviewText, updateWriteHighlightCache } from "../src/tui/write-preview.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("write preview highlight cache", () => {
  it("truncates previews at 50 lines with a trailing hint", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const cache = updateWriteHighlightCache(undefined, "a.ts", content);
    const text = renderWritePreviewText(cache, theme as never);
    const lines = text.split("\n");
    expect(lines).toHaveLength(51);
    expect(lines[0]).toContain("1 │");
    expect(lines[49]).toContain("50 │");
    expect(lines[50]).toContain("10 more lines");
  });

  it("updates the highlight cache incrementally on prefix growth", () => {
    const first = updateWriteHighlightCache(undefined, "src/a.ts", "const a = 1;");
    expect(first).toBeDefined();
    const second = updateWriteHighlightCache(first, "src/a.ts", "const a = 1;\nconst b = 2;");
    expect(second).toBe(first);
    expect(second?.normalizedLines).toEqual(["const a = 1;", "const b = 2;"]);
    expect(second?.highlightedLines).toHaveLength(2);
  });

  it("normalizes carriage returns and tabs like Pi 0.84's write renderer", () => {
    const cache = updateWriteHighlightCache(undefined, "src/a.ts", "a\r\nb\rc\tend");
    expect(cache?.normalizedLines).toEqual(["a", "bc   end"]);

    const appended = updateWriteHighlightCache(cache, "src/a.ts", "a\r\nb\rc\tend\r\n\tmore");
    expect(appended).toBe(cache);
    expect(appended?.normalizedLines).toEqual(["a", "bc   end", "   more"]);
  });

  it("rebuilds the highlight cache when path or prefix changes", () => {
    const first = updateWriteHighlightCache(undefined, "src/a.ts", "const a = 1;");
    const changedPath = updateWriteHighlightCache(first, "src/b.ts", "const a = 1;");
    expect(changedPath).not.toBe(first);
    expect(changedPath?.rawPath).toBe("src/b.ts");
    const nonPrefix = updateWriteHighlightCache(first, "src/a.ts", "const z = 9;");
    expect(nonPrefix).not.toBe(first);
    expect(nonPrefix?.normalizedLines).toEqual(["const z = 9;"]);
  });

  it("skips highlighting for unknown languages", () => {
    const cache = updateWriteHighlightCache(undefined, "notes.txt", "plain text");
    expect(cache).toBeUndefined();
    expect(renderWritePreviewText(cache, theme as never)).toBe("");
  });

  it("returns the same cache when the content is unchanged", () => {
    const first = updateWriteHighlightCache(undefined, "src/a.ts", "const a = 1;");
    const same = updateWriteHighlightCache(first, "src/a.ts", "const a = 1;");
    expect(same).toBe(first);
  });

  it("returns undefined for an empty path", () => {
    expect(updateWriteHighlightCache(undefined, "", "const a = 1;")).toBeUndefined();
  });
});
