import { describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
} from "../src/tui/codex-tool-specs.ts";
import { createCodexToolRendering } from "../src/tui/tool-renderer.ts";
import { renderWritePreviewText, updateWriteHighlightCache } from "../src/tui/write-preview.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    args: {} as Record<string, unknown>,
    toolCallId: "t1",
    invalidate: () => {},
    state: {},
    cwd: "/repo",
    isError: false,
    expanded: false,
    ...overrides,
  };
}

function renderHeader(spec: typeof codexEditToolSpec, args: Record<string, unknown>) {
  const rendering = createCodexToolRendering(spec);
  const ctx = context({ args });
  const header = rendering.renderCall(args, theme as never, ctx as never);
  const result = rendering.renderResult(
    { content: [{ type: "text", text: "ok" }] } as never,
    { expanded: false, isPartial: false },
    theme as never,
    ctx as never,
  );
  return (
    header.render(100).join("\n") +
    (result.render(100).join("\n") ? `\n${result.render(100).join("\n")}` : "")
  );
}

describe("codex tool specs", () => {
  it("edit spec renders Editing header with a +N -M summary", () => {
    const rendering = createCodexToolRendering(codexEditToolSpec);
    const ctx = context({ args: { path: "src/a.ts" } });
    const running = rendering.renderCall({ path: "src/a.ts" }, theme as never, ctx as never);
    expect(running.render(100).join("\n")).toContain("Editing src/a.ts");

    const result = rendering.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
        details: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n+c" },
      } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );
    const completed = rendering.renderCall({ path: "src/a.ts" }, theme as never, ctx as never);
    const text = completed.render(100).join("\n") + "\n" + result.render(100).join("\n");
    expect(text).toContain("Edited src/a.ts");
    expect(text).toContain("+2 -1");
  });

  it("write spec collapses to the header without a summary", () => {
    const text = renderHeader(codexWriteToolSpec, { path: "note.txt", content: "a\nb\n" });
    expect(text).toContain("Wrote note.txt");
    expect(text).not.toMatch(/\+\d/);
  });

  it("write spec renders a streamed preview with line numbers when expanded", () => {
    const rendering = createCodexToolRendering(codexWriteToolSpec);
    const ctx = context({ args: { path: "src/a.ts", content: "a\nb\n" }, expanded: true });
    const call = rendering.renderCall(
      { path: "src/a.ts", content: "a\nb\n" },
      theme as never,
      ctx as never,
    );
    const text = call.render(100).join("\n");
    expect(text).toContain("Writing src/a.ts");
    expect(text).toContain("1 │");
    expect(text).toContain("2 │");
    expect(text).toContain("b");
  });

  it("write spec renders the settled preview from the result", () => {
    const rendering = createCodexToolRendering(codexWriteToolSpec);
    const ctx = context({ args: { path: "src/a.ts", content: "a\nb\n" } });
    const result = rendering.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: true, isPartial: false },
      theme as never,
      ctx as never,
    );
    const text = result.render(100).join("\n");
    expect(text).toContain("1 │");
    expect(text).toContain("2 │");
  });

  it("bash spec renders Ran header with the command", () => {
    const text = renderHeader(codexBashToolSpec, { command: "npm test" });
    expect(text).toContain("Ran npm test");
  });

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
});
