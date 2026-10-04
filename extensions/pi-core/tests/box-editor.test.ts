import { describe, expect, it } from "vitest";
import { boxEditorLines } from "../src/tui/box-editor.ts";

const W = 20; // inner width

function plainBorder(width: number): string {
  return "─".repeat(width);
}

function content(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

describe("boxEditorLines", () => {
  it("wraps top, content, and bottom with corners and rails", () => {
    const lines = [plainBorder(W), content("hello", W), plainBorder(W)];
    const boxed = boxEditorLines(lines, W);
    expect(boxed).toHaveLength(3);
    expect(boxed[0]).toBe(`╭${plainBorder(W)}╮`);
    expect(boxed[1]).toBe(`│${content("hello", W)}│`);
    expect(boxed[2]).toBe(`╰${plainBorder(W)}╯`);
  });

  it("leaves autocomplete rows after the bottom border unboxed", () => {
    const lines = [plainBorder(W), content("cmd", W), plainBorder(W), content("/help", W)];
    const boxed = boxEditorLines(lines, W);
    expect(boxed[3]).toBe(content("/help", W));
    expect(boxed[3]).not.toContain("│");
  });

  it("gives scroll-indicator borders corners", () => {
    const scroll = `─── ↑ 3 more ${"─".repeat(W - 14)}`;
    const lines = [scroll, content("x", W), plainBorder(W)];
    const boxed = boxEditorLines(lines, W);
    expect(boxed[0].startsWith("╭")).toBe(true);
    expect(boxed[0].endsWith("╮")).toBe(true);
  });

  it("applies the chrome color function to corners and rails", () => {
    const paint = (s: string) => `<${s}>`;
    const boxed = boxEditorLines([plainBorder(W), content("a", W), plainBorder(W)], W, paint);
    expect(boxed[0]).toBe(`<╭>${plainBorder(W)}<╮>`);
    expect(boxed[1]).toBe(`<│>${content("a", W)}<│>`);
    expect(boxed[2]).toBe(`<╰>${plainBorder(W)}<╯>`);
  });

  it("returns input untouched when there is no border", () => {
    const lines = [content("just text", W)];
    expect(boxEditorLines(lines, W)).toEqual(lines);
  });

  it("boxes using known indices after labels destroy pure-border detection", () => {
    const labeledTop = `──Auto${"─".repeat(W - 6)}`;
    const labeledBottom = `── model ${"─".repeat(W - 9)}`;
    const lines = [labeledTop, content("hi", W), labeledBottom];
    // Auto-detect fails (labels contain letters)…
    expect(boxEditorLines(lines, W)).toEqual(lines);
    // …but known indices work.
    const boxed = boxEditorLines(lines, W, (s) => s, { topIdx: 0, bottomIdx: 2 });
    expect(boxed[0]).toBe(`╭${labeledTop}╮`);
    expect(boxed[1]).toBe(`│${content("hi", W)}│`);
    expect(boxed[2]).toBe(`╰${labeledBottom}╯`);
  });

  it("handles empty input and non-positive width", () => {
    expect(boxEditorLines([], W)).toEqual([]);
    expect(boxEditorLines([content("a", 4)], 0)).toEqual([content("a", 4)]);
  });
});
