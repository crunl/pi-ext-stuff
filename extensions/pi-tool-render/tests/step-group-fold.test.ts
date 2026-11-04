import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  codexEditToolSpec,
  codexReadToolSpec,
  createCodexToolRendering,
} from "../../../packages/shared-tool-presentation/src/index.ts";
import {
  registerStepGroupFold,
  type StepGroupBaseRenderer,
  StepGroupFoldController,
  type StepGroupToolRenderContext,
} from "../src/step-group-fold.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

function createPaddingStub() {
  return {
    getOutputPad: () => 0 as const,
    track: () => {},
  };
}

function mountToolHost(
  renderer: StepGroupBaseRenderer,
  toolCallId: string,
  args: Record<string, unknown>,
  initialExpanded = false,
) {
  const state: Record<string, unknown> = {};
  let expanded = initialExpanded;
  let isError = false;
  let result: AgentToolResult<unknown> | undefined;
  let isPartial = false;
  let callComp: ReturnType<NonNullable<ToolRenderers["renderCall"]>> | undefined;
  let resultComp: ReturnType<NonNullable<ToolRenderers["renderResult"]>> | undefined;

  const invalidateSpy = vi.fn(() => {
    updateDisplayWithSpy();
  });

  const updateDisplayWithSpy = () => {
    const context: StepGroupToolRenderContext = {
      args,
      toolCallId,
      invalidate: invalidateSpy,
      lastComponent: callComp,
      state,
      cwd: "/repo",
      executionStarted: result !== undefined,
      argsComplete: true,
      isError,
      expanded,
      showImages: false,
    };
    callComp = renderer.renderCall?.(args, plainTheme, context);
    if (result && renderer.renderResult) {
      resultComp = renderer.renderResult(result, { expanded, isPartial }, plainTheme, {
        ...context,
        lastComponent: resultComp,
      });
    }
  };

  updateDisplayWithSpy();

  return {
    invalidateSpy,
    setResult(
      nextResult: { content: Array<{ type: "text"; text: string }>; details?: unknown },
      nextIsError = false,
      nextIsPartial = false,
    ) {
      result = { content: nextResult.content, details: nextResult.details };
      isError = nextIsError;
      isPartial = nextIsPartial;
      updateDisplayWithSpy();
    },
    setExpanded(nextExpanded: boolean) {
      expanded = nextExpanded;
      updateDisplayWithSpy();
    },
    render(width = 100): string[] {
      return [
        ...(callComp ? callComp.render(width) : []),
        ...(resultComp ? resultComp.render(width) : []),
      ].map((line) => line.trimEnd());
    },
    click(y: number) {
      const handler = (
        callComp as unknown as {
          handleMouse?: (event: {
            type: string;
            button: string;
            y: number;
          }) => { handled: true } | undefined;
        }
      )?.handleMouse;
      return handler?.({ type: "click", button: "left", y });
    },
  };
}

describe("StepGroupFoldController", () => {
  it("streams unsettled thoughts and tools individually, then folds into a 2-level group when text starts", () => {
    const padding = createPaddingStub();
    const controller = new StepGroupFoldController(padding);
    const readRenderer = controller.wrapRenderer(
      "read",
      createCodexToolRendering(codexReadToolSpec, padding),
    );
    const editRenderer = controller.wrapRenderer(
      "edit",
      createCodexToolRendering(codexEditToolSpec, padding),
    );

    // 1. Assistant message 1 streams: thinking + read("call-1")
    controller.handleMessageStart({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Inspecting src/a.ts first" }],
    });
    controller.handleMessageUpdate({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting src/a.ts first" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
      ],
    });
    const host1 = mountToolHost(readRenderer, "call-1", { path: "src/a.ts" });
    host1.setResult({ content: [{ type: "text", text: "const x = 1;\nconst y = 2;" }] });
    controller.handleMessageEnd({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting src/a.ts first" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
      ],
    });

    // Unsettled: shows Thinking... and Read src/a.ts (not a ▸ group)
    const unsettledLines1 = host1.render(100);
    expect(unsettledLines1[0]).toBe("Thinking...");
    expect(unsettledLines1[1]).toBe("");
    expect(unsettledLines1[2]).toContain("Read src/a.ts · 2 lines");

    // 2. Assistant message 2 streams: thinking + edit("call-2")
    controller.handleMessageStart({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Patching src/a.ts" }],
    });
    controller.handleMessageUpdate({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Patching src/a.ts" },
        {
          type: "toolCall",
          id: "call-2",
          name: "edit",
          arguments: { path: "src/a.ts", oldText: "const x = 1;", newText: "const x = 2;" },
        },
      ],
    });
    const host2 = mountToolHost(editRenderer, "call-2", {
      path: "src/a.ts",
      oldText: "const x = 1;",
      newText: "const x = 2;",
    });
    host2.setResult({
      content: [{ type: "text", text: "Edited src/a.ts" }],
      details: { diff: "-1 const x = 1;\n+1 const x = 2;" },
    });
    controller.handleMessageEnd({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Patching src/a.ts" },
        {
          type: "toolCall",
          id: "call-2",
          name: "edit",
          arguments: { path: "src/a.ts", oldText: "const x = 1;", newText: "const x = 2;" },
        },
      ],
    });

    // Still unsettled before assistant text! Both tools remain visible.
    expect(host1.render(100).join("\n")).toContain("Read src/a.ts · 2 lines");
    expect(host2.render(100).join("\n")).toContain("Edited src/a.ts · +1 -1");

    // 3. Assistant message 3 starts with final thinking, then emits text!
    controller.handleMessageStart({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Summarizing changes" }],
    });
    // Still unsettled while only thinking is present in message 3
    expect(host2.render(100).join("\n")).toContain("Thinking...");

    // Now assistant body text arrives -> settles and folds the segment!
    controller.handleMessageUpdate({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Summarizing changes" },
        { type: "text", text: "Updated `x` in `src/a.ts`." },
      ],
    });

    // State 0: host1 renders the 1-line summary header; host2 is absorbed (0 lines)
    expect(host1.render(100)).toEqual(["▸ Edited 1 file · Read 1 file · 3 thoughts"]);
    expect(host2.render(100)).toEqual([]);

    // Level 1 click on header (y=0) -> expands to │ gutter step list
    expect(host1.click(0)).toEqual({ handled: true });
    const state1Lines = host1.render(100);
    expect(state1Lines).toHaveLength(6);
    expect(state1Lines[0]).toBe("▾ Edited 1 file · Read 1 file · 3 thoughts");
    expect(state1Lines[1]).toBe("│ Thinking...");
    expect(state1Lines[2]).toContain("│ \uF15C Read src/a.ts · 2 lines");
    expect(state1Lines[3]).toBe("│ Thinking...");
    expect(state1Lines[4]).toContain("│ \uEE3C Edited src/a.ts · +1 -1");
    expect(state1Lines[5]).toBe("│ Thinking...");

    // Level 2 click on Edited row (y=4) -> expands only the edit diff with ├─
    expect(host1.click(4)).toEqual({ handled: true });
    const state2Lines = host1.render(100);
    expect(state2Lines[4]).toContain("├─\uEE3C Edited src/a.ts · +1 -1");
    expect(state2Lines.join("\n")).toContain("const x = 2;");

    // Level 2 click on first Thinking... row (y=1) -> expands that thought's text with ├─
    expect(host1.click(1)).toEqual({ handled: true });
    const state2WithThought = host1.render(100);
    expect(state2WithThought[1]).toBe("├─Thinking");
    expect(state2WithThought[2]).toContain("│   Inspecting src/a.ts first");

    // Click header (y=0) -> collapses back to State 0
    expect(host1.click(0)).toEqual({ handled: true });
    expect(host1.render(100)).toEqual(["▸ Edited 1 file · Read 1 file · 3 thoughts"]);

    // Re-expanding via header click (y=0) starts back at State 1 (child steps reset to collapsed)
    expect(host1.click(0)).toEqual({ handled: true });
    const reExpandedLines = host1.render(100);
    expect(reExpandedLines).toHaveLength(6);
    expect(reExpandedLines.join("\n")).not.toContain("const x = 2;");
    expect(reExpandedLines.join("\n")).not.toContain("Inspecting src/a.ts first");
  });

  it("settles multi-step segments on user boundary, agent_end, or aborted stopReason without assistant text", () => {
    const padding = createPaddingStub();
    const controller = new StepGroupFoldController(padding);
    const readRenderer = controller.wrapRenderer(
      "read",
      createCodexToolRendering(codexReadToolSpec, padding),
    );

    controller.handleMessageStart({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1" },
        { type: "toolCall", id: "u1", name: "read", arguments: { path: "a.ts" } },
      ],
    });
    const host = mountToolHost(readRenderer, "u1", { path: "a.ts" });
    host.setResult({ content: [{ type: "text", text: "1" }] });
    controller.handleMessageEnd({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step 1" },
        { type: "toolCall", id: "u1", name: "read", arguments: { path: "a.ts" } },
      ],
    });

    // Unsettled before agent_end
    expect(host.render(100)[0]).toBe("Thinking...");

    // agent_end settles the turn even without assistant text
    controller.handleAgentEnd();
    expect(host.render(100)).toEqual(["▸ Read 1 file · 1 thought"]);
  });

  it("routes absorbed child invalidate to anchor, skips base renders while collapsed, and excludes image results or unwrapped tools", () => {
    const padding = createPaddingStub();
    const controller = new StepGroupFoldController(padding);

    let capturedChildInvalidate: (() => void) | undefined;
    let childReady = false;
    const baseReadCallSpy = vi.fn(
      (_args: unknown, _theme: Theme, ctx: StepGroupToolRenderContext) => {
        capturedChildInvalidate = ctx.invalidate;
        return {
          render: () => [childReady ? "Read b.ts (ready)" : "Read b.ts (loading)"],
          invalidate: () => {},
        };
      },
    );

    const readRenderer = controller.wrapRenderer("read", {
      renderShell: "self",
      renderCall: baseReadCallSpy,
    });

    // Settle a 2-tool segment via branch reset
    controller.resetFromBranch([
      {
        id: "m1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "c2", name: "read", arguments: { path: "b.ts" } },
            { type: "text", text: "Done." },
          ],
        },
      },
    ]);

    const host1 = mountToolHost(readRenderer, "c1", { path: "a.ts" });
    const host2 = mountToolHost(readRenderer, "c2", { path: "b.ts" });

    // Because c1 and c2 are already folded, mounting them while collapsed does NOT invoke baseReadCallSpy!
    expect(baseReadCallSpy).toHaveBeenCalledTimes(0);
    expect(host1.render(100)).toEqual(["▸ Read 2 files"]);
    expect(host2.render(100)).toEqual([]);

    // Expand group -> renders child tools and captures child invalidate
    host1.click(0);
    expect(host1.render(100)).toContain("│ Read b.ts (loading)");

    // Triggering child's invalidate routes to host1's invalidateSpy!
    const prevCalls = host1.invalidateSpy.mock.calls.length;
    childReady = true;
    capturedChildInvalidate?.();
    expect(host1.invalidateSpy.mock.calls.length).toBeGreaterThan(prevCalls);
    expect(host1.render(100)).toContain("│ Read b.ts (ready)");

    // If c2 receives an image tool result, it splits out of the folded group so its image is not hidden
    controller.recordToolResult(
      "c2",
      { content: [{ type: "image", data: "abc", mimeType: "image/png" }] as never, details: {} },
      false,
      false,
    );
    expect(host2.render(100)).toEqual(["Read b.ts (ready)"]);

    // Resetting to an empty branch un-folds and prunes stale tool records
    controller.resetFromBranch([]);
    expect(host1.render(100)).toEqual(["Read b.ts (ready)"]);
    controller.clear();
  });

  it("does not fold a single-step segment when assistant text begins", () => {
    const padding = createPaddingStub();
    const controller = new StepGroupFoldController(padding);
    const readRenderer = controller.wrapRenderer(
      "read",
      createCodexToolRendering(codexReadToolSpec, padding),
    );

    controller.handleMessageStart({
      role: "assistant",
      content: [{ type: "toolCall", id: "single-read", name: "read", arguments: { path: "a.ts" } }],
    });
    const host = mountToolHost(readRenderer, "single-read", { path: "a.ts" });
    host.setResult({ content: [{ type: "text", text: "line 1" }] });
    controller.handleMessageEnd({
      role: "assistant",
      content: [{ type: "toolCall", id: "single-read", name: "read", arguments: { path: "a.ts" } }],
    });

    controller.handleMessageStart({
      role: "assistant",
      content: [{ type: "text", text: "Done reading." }],
    });

    const lines = host.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Read a.ts · 1 line");
    expect(lines[0]).not.toContain("▸");
  });

  it("treats non-group tools like codemode as segment boundaries and reconstructs branch on session_start", () => {
    const padding = createPaddingStub();
    const controller = new StepGroupFoldController(padding);
    const resolvers: Array<
      (toolName: string, next: () => ToolRenderers | undefined) => ToolRenderers | undefined
    > = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();

    const piMock = {
      registerToolRenderer: (resolver: (typeof resolvers)[number]) => resolvers.push(resolver),
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(event, handler);
      },
    };

    registerStepGroupFold(piMock as never, controller);

    const baseRead = createCodexToolRendering(codexReadToolSpec, padding);
    const codemodeMock: ToolRenderers = {
      renderShell: "self",
      renderCall: () => ({ render: () => ["codemode row"], invalidate: () => {} }),
    };

    const resolvedRead = resolvers[0]?.("read", () => baseRead as unknown as ToolRenderers);
    const resolvedCodemode = resolvers[0]?.("codemode", () => codemodeMock);
    expect(resolvedRead).toBeDefined();
    expect(resolvedCodemode).toBe(codemodeMock);

    // Simulate /resume: tools are mounted before session_start runs
    const host1 = mountToolHost(resolvedRead ?? baseRead, "r1", { path: "one.ts" });
    host1.setResult({ content: [{ type: "text", text: "1" }] });
    const host2 = mountToolHost(resolvedRead ?? baseRead, "r2", { path: "two.ts" });
    host2.setResult({ content: [{ type: "text", text: "2" }] });
    const host3 = mountToolHost(resolvedRead ?? baseRead, "r3", { path: "three.ts" });
    host3.setResult({ content: [{ type: "text", text: "3" }] });

    const setHiddenThinkingLabel = vi.fn();
    handlers.get("session_start")?.(
      {},
      {
        hasUI: true,
        mode: "tui",
        ui: {
          setHiddenThinkingLabel,
          setFooter: () => {},
          setHeader: () => {},
          custom: () => {},
        },
        sessionManager: {
          getBranch: () => [
            {
              id: "e1",
              type: "message",
              message: {
                role: "assistant",
                content: [
                  { type: "toolCall", id: "r1", name: "read", arguments: { path: "one.ts" } },
                  { type: "toolCall", id: "r2", name: "read", arguments: { path: "two.ts" } },
                  { type: "toolCall", id: "cm1", name: "codemode", arguments: {} },
                  {
                    type: "toolCall",
                    id: "r3",
                    name: "read",
                    arguments: { path: "three.ts" },
                  },
                  { type: "text", text: "All done." },
                ],
              },
            },
          ],
        },
      },
    );

    expect(setHiddenThinkingLabel).toHaveBeenCalledWith("");
    // Segment 1 (r1 + r2 before codemode) has 2 steps -> folded!
    expect(host1.render(100)).toEqual(["▸ Read 2 files"]);
    expect(host2.render(100)).toEqual([]);
    // Segment 2 (r3 after codemode) has only 1 step -> stays uncollapsed!
    expect(host3.render(100)[0]).toContain("Read three.ts · 1 line");

    // Ctrl+O host expansion opens and closes the folded group
    host1.setExpanded(true);
    expect(host1.render(100)[0]).toBe("▾ Read 2 files");
    host1.setExpanded(false);
    expect(host1.render(100)).toEqual(["▸ Read 2 files"]);
  });
});
