import { describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  countWrittenLines,
} from "../src/tui/codex-tool-specs.ts";
import { createCodexToolRendering } from "../src/tui/tool-renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function renderHeader(spec: typeof codexEditToolSpec, args: Record<string, unknown>) {
  const rendering = createCodexToolRendering(spec);
  const state: Record<string, unknown> = {};
  const context = { args, state, cwd: "/repo", isError: false, invalidate: () => {} };
  const header = rendering.renderCall(args, theme as never, context as never);
  const result = rendering.renderResult(
    { content: [{ type: "text", text: "ok" }] } as never,
    { expanded: false, isPartial: false },
    theme as never,
    context as never,
  );
  return (
    header.render(100).join("\n") +
    (result.render(100).join("\n") ? `\n${result.render(100).join("\n")}` : "")
  );
}

describe("codex tool specs", () => {
  it("edit spec renders Editing header with a +N -M summary", () => {
    const rendering = createCodexToolRendering(codexEditToolSpec);
    const state: Record<string, unknown> = {};
    const context = {
      args: { path: "src/a.ts" },
      state,
      cwd: "/repo",
      isError: false,
      invalidate: () => {},
    };
    const running = rendering.renderCall({ path: "src/a.ts" }, theme as never, context as never);
    expect(running.render(100).join("\n")).toContain("Editing src/a.ts");

    const result = rendering.renderResult(
      {
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." }],
        details: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n+c" },
      } as never,
      { expanded: false, isPartial: false },
      theme as never,
      context as never,
    );
    const completed = rendering.renderCall({ path: "src/a.ts" }, theme as never, context as never);
    const text = completed.render(100).join("\n") + "\n" + result.render(100).join("\n");
    expect(text).toContain("Edited src/a.ts");
    expect(text).toContain("+2 -1");
  });

  it("write spec renders Wrote header with a +N line summary", () => {
    const text = renderHeader(codexWriteToolSpec, { path: "note.txt", content: "a\nb\n" });
    expect(text).toContain("Wrote note.txt");
    expect(text).toContain("+2");
  });

  it("bash spec renders Ran header with the command", () => {
    const text = renderHeader(codexBashToolSpec, { command: "npm test" });
    expect(text).toContain("Ran npm test");
  });

  it("countWrittenLines ignores a trailing newline", () => {
    expect(countWrittenLines("")).toBe(0);
    expect(countWrittenLines("a")).toBe(1);
    expect(countWrittenLines("a\n")).toBe(1);
    expect(countWrittenLines("a\nb\nc")).toBe(3);
    expect(countWrittenLines("a\r\nb\r\n")).toBe(2);
  });
});
