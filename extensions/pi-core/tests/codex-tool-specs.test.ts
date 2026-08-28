import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  codexBashToolSpec,
  codexEditToolSpec,
  codexWriteToolSpec,
  summarizeEditDiff,
} from "../src/tui/codex-tool-specs.ts";
import { type CodexToolRendererSpec, createCodexToolRendering } from "../src/tui/tool-renderer.ts";

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

function renderHeader<TPreviewState = unknown>(
  spec: CodexToolRendererSpec<TPreviewState>,
  args: Record<string, unknown>,
) {
  const rendering = createCodexToolRendering<TPreviewState>(spec);
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
    const text = `${completed.render(100).join("\n")}\n${result.render(100).join("\n")}`;
    expect(text).toContain("Edited src/a.ts");
    expect(text).toContain("+2 -1");
  });

  it("write spec collapses to the header with a green +N line summary", () => {
    const text = renderHeader(codexWriteToolSpec, { path: "note.txt", content: "a\nb\n" });
    expect(text).toContain("Wrote note.txt");
    expect(text).toContain("+2");
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

  it("keeps a long multiline bash header on one visual row", () => {
    const rendering = createCodexToolRendering(codexBashToolSpec, {
      getOutputPad: () => 0,
      track() {},
    });
    const args = {
      command:
        "git status --short && git add README.md\nsrc/tui/tool-renderer.ts && git commit -m test",
    };
    const ctx = context({ args });
    const header = rendering.renderCall(args, theme as never, ctx as never);
    rendering.renderResult(
      { content: [{ type: "text", text: "ok" }] } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );

    const lines = header.render(120);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0])).toBe(120);
    expect(stripTerminalSequences(lines[0]).trimEnd()).toBe(
      " Ran git status --short && git add README.md ↵ src/tui/tool-renderer.ts && git commit -m test",
    );
  });

  it("limits collapsed bash previews to four rows", () => {
    const rendering = createCodexToolRendering(codexBashToolSpec, {
      getOutputPad: () => 0,
      track() {},
    });
    const ctx = context({ args: { command: "seq 1 8" } });
    rendering.renderCall({ command: "seq 1 8" }, theme as never, ctx as never);
    const result = rendering.renderResult(
      {
        content: [
          {
            type: "text",
            text: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
          },
        ],
      } as never,
      { expanded: false, isPartial: false },
      theme as never,
      ctx as never,
    );

    expect(result.render(100)).toEqual([
      "  └ line 1",
      "    line 2",
      "    … +5 lines",
      "    line 8",
    ]);
  });
});

describe("summarizeEditDiff", () => {
  it("counts additions and deletions without counting diff headers", () => {
    expect(
      summarizeEditDiff({
        content: [],
        details: {
          diff: [
            "--- a/file.ts",
            "+++ b/file.ts",
            "@@ -1,2 +1,3 @@",
            "-old",
            "+new",
            "+added",
            " unchanged",
          ].join("\n"),
        },
      } as never),
    ).toBe("+2 -1");
  });
});
