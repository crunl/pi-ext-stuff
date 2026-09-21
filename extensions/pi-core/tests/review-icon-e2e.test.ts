import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { codexBashToolSpec } from "../src/tui/codex-tool-specs.ts";
import { createCodexToolRendering } from "../src/tui/tool-renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

const REVIEW_ICON = "\u{F105E}";
const REVIEW_DETAILS = Symbol.for("pi-safety-review-details");

function decorateReviewDetails(details: unknown, status: string): unknown {
  return Object.freeze({ [REVIEW_DETAILS]: true, base: details, status });
}

/** Simulate host ToolExecutionComponent: renderCall then renderResult share state. */
function hostRenderPass(
  rendering: ReturnType<typeof createCodexToolRendering>,
  state: Record<string, unknown>,
  args: Record<string, unknown>,
  result?: { content: unknown[]; details?: unknown },
  options: { isPartial?: boolean; isError?: boolean } = {},
) {
  const makeContext = () =>
    ({
      args,
      toolCallId: "call-1",
      invalidate() {},
      lastComponent: undefined,
      state,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial: options.isPartial ?? false,
      expanded: false,
      showImages: false,
      isError: options.isError ?? false,
    }) as never;

  // Host updateDisplay order: renderCall first, then renderResult (which
  // mutates the same header via updateHeader). Re-render call after result
  // so the snapshot matches what the terminal paints.
  const callComponent = rendering.renderCall!(args, theme, makeContext());
  let resultLines: string[] = [];
  if (result) {
    resultLines = rendering.renderResult!(
      result as never,
      { expanded: false, isPartial: options.isPartial ?? false },
      theme,
      makeContext(),
    ).render(100);
  }
  return {
    call: callComponent.render(100).map((line) => stripTerminalSequences(line)),
    result: resultLines.map((line) => stripTerminalSequences(line)),
  };
}

/**
 * Mirror of pi-safety createReviewResultRenderer("header-icon"): stamp
 * leadingIconOverride when review status is present, never clear it, never overlay.
 */
function stampReviewBadge(
  base: ReturnType<typeof createCodexToolRendering>["renderResult"],
  result: { content: unknown[]; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  themeArg: unknown,
  context: { state?: Record<string, unknown> },
) {
  const details = result.details as { [REVIEW_DETAILS]?: true; status?: string } | undefined;
  const status = details && REVIEW_DETAILS in details ? details.status : undefined;
  if (status !== undefined && context.state) {
    context.state.leadingIconOverride = REVIEW_ICON;
  }
  return base?.(result as never, options, themeArg as never, context as never);
}

beforeAll(() => {
  initTheme("dark", false);
});

describe("review icon header e2e (host updateDisplay order)", () => {
  it("shows the original icon before review and the badge after, permanently", () => {
    const rendering = createCodexToolRendering(codexBashToolSpec, {
      getOutputPad: () => 0,
      track() {},
    });
    const state: Record<string, unknown> = {};
    const args = { command: "npm test" };

    // 1. tool_execution_start — no result yet
    const start = hostRenderPass(rendering, state, args);
    expect(start.call.join("\n")).toContain("Running");
    expect(start.call.join("\n")).not.toContain(REVIEW_ICON);

    // 2. reviewing partial — host updateResult then updateDisplay (call then result)
    const reviewing = decorateReviewDetails(undefined, "Reviewing approval request · bash");
    const ctx = {
      args,
      toolCallId: "call-1",
      invalidate() {},
      lastComponent: undefined,
      state,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    } as never;

    // Same order as ToolExecutionComponent.updateDisplay
    const callComponent = rendering.renderCall!(args, theme, ctx);
    stampReviewBadge(
      rendering.renderResult!,
      { content: [], details: reviewing },
      {
        expanded: false,
        isPartial: true,
      },
      theme,
      ctx as never,
    );

    const reviewLines = callComponent.render(100).map((l) => stripTerminalSequences(l));
    expect(reviewLines.join("\n")).toContain(REVIEW_ICON);
    expect(reviewLines.join("\n")).toContain("Running");
    expect(reviewLines.join("\n")).toContain("npm test");
    expect(state.leadingIconOverride).toBe(REVIEW_ICON);

    // 3. final success — status gone, badge remains
    const finalPass = hostRenderPass(
      rendering,
      state,
      args,
      { content: [{ type: "text", text: "ok" }] },
      { isPartial: false, isError: false },
    );
    expect(finalPass.call.join("\n")).toContain(REVIEW_ICON);
    expect(finalPass.call.join("\n")).toContain("Ran");
    expect(state.leadingIconOverride).toBe(REVIEW_ICON);

    // 4. a later failed render still keeps the badge
    const failedPass = hostRenderPass(
      rendering,
      state,
      args,
      { content: [{ type: "text", text: "boom" }] },
      { isPartial: false, isError: true },
    );
    expect(failedPass.call.join("\n")).toContain(REVIEW_ICON);
    expect(failedPass.call.join("\n")).toContain("Failed");
  });

  it("never stamps a call that never entered review", () => {
    const rendering = createCodexToolRendering(codexBashToolSpec, {
      getOutputPad: () => 0,
      track() {},
    });
    const state: Record<string, unknown> = {};
    const pass = hostRenderPass(
      rendering,
      state,
      { command: "ls" },
      { content: [{ type: "text", text: "file" }] },
    );
    expect(pass.call.join("\n")).not.toContain(REVIEW_ICON);
    expect(state.leadingIconOverride).toBeUndefined();
  });
});
