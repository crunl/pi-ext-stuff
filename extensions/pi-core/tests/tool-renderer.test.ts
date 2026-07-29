import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  compactBashStatusSpacing,
  createCodexToolRendering,
  summarizeEditDiff,
} from "../src/tui/tool-renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function context(state: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    args: { command: "npm test" },
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  } as any;
}

describe("createCodexToolRendering", () => {
  it("updates the shared header from Running to Ran when a result arrives", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => String(args.command),
      collapsed: "preview",
    });
    const state = {};
    const header = rendering.renderCall!({ command: "npm test" } as any, theme, context(state));

    expect(header.render(80).join("\n")).toContain("• Running npm test");

    rendering.renderResult!(
      { content: [{ type: "text", text: "ok" }] } as any,
      { expanded: false, isPartial: false },
      theme,
      context(state, { lastComponent: undefined }),
    );

    expect(header.render(80).join("\n")).toContain("• Ran npm test");
  });

  it("marks a failed call and keeps its error visible when collapsed", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => String(args.command),
      collapsed: "hidden",
    });
    const state = {};
    const header = rendering.renderCall!({ command: "npm test" } as any, theme, context(state));
    const result = rendering.renderResult!(
      { content: [{ type: "text", text: "tests failed" }] } as any,
      { expanded: false, isPartial: false },
      theme,
      context(state, { isError: true }),
    );

    expect(header.render(80).join("\n")).toContain("• Failed npm test");
    expect(result.render(80).join("\n")).toContain("tests failed");
  });

  it("folds a successful collapsed summary into the completed header", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Searching",
      completedVerb: "Searched",
      argument: () => "\"renderCall\" in src",
      collapsed: () => "12 matches",
    });
    const state = {};
    const header = rendering.renderCall!(
      { pattern: "renderCall" } as any,
      theme,
      context(state),
    );
    const result = rendering.renderResult!(
      { content: [{ type: "text", text: "12 matching lines" }] } as any,
      { expanded: false, isPartial: false },
      theme,
      context(state),
    );

    expect(header.render(80).join("\n")).toContain(
      "• Searched \"renderCall\" in src · 12 matches",
    );
    expect(result.render(80)).toEqual([]);
  });

  it("uses a configured Nerd Font glyph as the lifecycle marker", () => {
    const rendering = createCodexToolRendering({
      icon: "",
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => String(args.command),
      collapsed: "hidden",
    });
    const state = {};
    const header = rendering.renderCall!(
      { command: "npm test" } as any,
      theme,
      context(state),
    );

    expect(header.render(80).join("\n")).toContain(" Running npm test");

    rendering.renderResult!(
      { content: [] } as any,
      { expanded: false, isPartial: false },
      theme,
      context(state),
    );
    expect(header.render(80).join("\n")).toContain(" Ran npm test");
  });

  it("removes only the blank separator before a trailing Bash status", () => {
    const rendering = createCodexToolRendering({
      icon: "",
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => String(args.command),
      collapsed: "preview",
      transformOutput: compactBashStatusSpacing,
    }, {
      getOutputPad: () => 0,
      track() {},
    });
    const state = {};
    rendering.renderCall!(
      { command: "gh api repos/example" } as any,
      theme,
      context(state),
    );
    const result = rendering.renderResult!(
      {
        content: [{
          type: "text",
          text: "Forbidden\n\nCommand exited with code 1",
        }],
      } as any,
      { expanded: false, isPartial: false },
      theme,
      context(state, { isError: true }),
    );

    expect(result.render(80)).toEqual([
      "  └ Forbidden",
      "    Command exited with code 1",
    ]);
    expect(compactBashStatusSpacing("first\n\nsecond")).toBe("first\n\nsecond");
  });

  it("recreates a working tool row when output padding changes", () => {
    let outputPad: 0 | 1 = 0;
    const paddingSource = {
      getOutputPad: () => outputPad,
      track: vi.fn(),
    };
    const rendering = createCodexToolRendering({
      runningVerb: "Running",
      completedVerb: "Ran",
      argument: (args) => String(args.command),
      collapsed: "preview",
    }, paddingSource);
    const state = {};
    const renderContext = context(state);

    const unpaddedHeader = rendering.renderCall!(
      { command: "npm test" } as any,
      theme,
      renderContext,
    );
    expect(unpaddedHeader.render(80)[0]).toMatch(/^• Running/);

    outputPad = 1;
    const paddedHeader = rendering.renderCall!(
      { command: "npm test" } as any,
      theme,
      renderContext,
    );
    const result = rendering.renderResult!(
      { content: [{ type: "text", text: "ok" }] } as any,
      { expanded: false, isPartial: true },
      theme,
      renderContext,
    );

    expect(paddedHeader).not.toBe(unpaddedHeader);
    expect(paddedHeader.render(80)[0]).toMatch(/^ • Running/);
    expect(result.render(80)[0]).toMatch(/^   └ ok/);
    expect(paddingSource.track).toHaveBeenCalledWith(
      "call-1",
      renderContext.invalidate,
    );
  });

  it("uses a custom component for a successful expanded result", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Editing",
      completedVerb: "Edited",
      argument: () => "file.ts",
      collapsed: summarizeEditDiff,
      renderExpandedResult: (_result, _args, _theme, outputPad) =>
        new Text(`custom diff at pad ${outputPad}`, 0, 0),
    }, {
      getOutputPad: () => 1,
      track() {},
    });
    const state = {};
    const result = rendering.renderResult!(
      {
        content: [{
          type: "text",
          text: "Successfully replaced 1 block.",
        }],
        details: { diff: "+1 added" },
      } as any,
      { expanded: true, isPartial: false },
      theme,
      context(state, { args: { path: "file.ts" } }),
    );
    const output = result.render(80).join("\n");

    expect(output).toContain("custom diff at pad 1");
    expect(output).not.toContain("Successfully replaced");
  });

  it("does not invoke the custom component renderer while collapsed", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Editing",
      completedVerb: "Edited",
      argument: () => "file.ts",
      collapsed: summarizeEditDiff,
      renderExpandedResult: () => {
        throw new Error("collapsed rendering must not create the diff panel");
      },
    });
    const result = rendering.renderResult!(
      {
        content: [{
          type: "text",
          text: "Successfully replaced 1 block.",
        }],
        details: { diff: "+1 added" },
      } as any,
      { expanded: false, isPartial: false },
      theme,
      context({}, { args: { path: "file.ts" } }),
    );

    expect(result.render(80)).toEqual([]);
  });

  it("keeps expanded failures on the existing error output path", () => {
    const rendering = createCodexToolRendering({
      runningVerb: "Editing",
      completedVerb: "Edited",
      argument: () => "file.ts",
      collapsed: summarizeEditDiff,
      renderExpandedResult: () => {
        throw new Error("failed rendering must not create the diff panel");
      },
    });
    const result = rendering.renderResult!(
      {
        content: [{
          type: "text",
          text: "oldText did not match",
        }],
      } as any,
      { expanded: true, isPartial: false },
      theme,
      context({}, {
        args: { path: "file.ts" },
        isError: true,
      }),
    );

    expect(result.render(80).join("\n")).toContain("oldText did not match");
  });
});

describe("summarizeEditDiff", () => {
  it("counts additions and deletions without counting diff headers", () => {
    expect(summarizeEditDiff({
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
    } as any)).toBe("+2 -1");
  });
});
