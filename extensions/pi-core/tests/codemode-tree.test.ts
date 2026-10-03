import { describe, expect, it } from "vitest";
import type { ChildRow, GlanceSummary } from "../src/tui/codemode-contract.ts";
import {
  createCodemodeTreeRendering,
  formatCodemodeGlance,
  formatNestedCallRow,
} from "../src/tui/codemode-tree.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function glance(partial: Partial<GlanceSummary> = {}): GlanceSummary {
  return {
    total: 0,
    commands: 0,
    reads: 0,
    edits: 0,
    other: 0,
    failed: 0,
    running: 0,
    ...partial,
  };
}

function child(partial: Partial<ChildRow> & { id: string; toolLabel: string }): ChildRow {
  return {
    target: "",
    status: "ok",
    ...partial,
  };
}

describe("formatCodemodeGlance", () => {
  it("summarizes categories in English", () => {
    const line = formatCodemodeGlance(
      glance({ total: 5, commands: 1, reads: 3, edits: 1, failed: 1 }),
      theme,
    );
    expect(line).toBe("└ Ran 1 command · Read 3 files · Edited 1 file · 1 failed");
  });

  it("omits empty categories and uses singular nouns", () => {
    const line = formatCodemodeGlance(glance({ total: 1, commands: 1 }), theme);
    expect(line).toBe("└ Ran 1 command");
  });

  it("prefers review icon override when provided", () => {
    const line = formatCodemodeGlance(glance({ total: 1, commands: 1 }), theme, {
      leadingIconOverride: "R",
    });
    expect(line.startsWith("R ")).toBe(true);
  });
});

describe("formatNestedCallRow", () => {
  it("shows tool label, target, and duration", () => {
    const row = formatNestedCallRow(
      child({ id: "c1", toolLabel: "bash", target: "git status", durationMs: 12 }),
      theme,
    );
    expect(row).toContain("bash");
    expect(row).toContain("git status");
    expect(row).toContain("12ms");
  });

  it("appends error text when expanded", () => {
    const row = formatNestedCallRow(
      child({ id: "c1", toolLabel: "read", status: "error", errorText: "missing" }),
      theme,
      { expanded: true },
    );
    expect(row).toContain("missing");
  });
});

describe("createCodemodeTreeRendering", () => {
  const rendering = createCodemodeTreeRendering();

  function context(expanded: boolean, state: Record<string, unknown> = {}) {
    return {
      args: { code: "await tools.bash({ command: 'ls' })\nsecond line\nthird" },
      toolCallId: "call-1",
      invalidate() {},
      lastComponent: undefined,
      state,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded,
      showImages: true,
      isError: false,
    } as never;
  }

  function render(
    result: unknown,
    options: { expanded: boolean; isPartial?: boolean },
    ctx: unknown,
  ): string {
    const component = rendering.renderResult!(
      result as never,
      options as never,
      theme,
      ctx as never,
    ) as { render(width: number): string[] };
    return component.render(80).join("\n");
  }

  it("renders a single glance line when collapsed", () => {
    const joined = render(
      {
        content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nbody" }],
        details: {
          calls: [{ id: "c1", name: "bash", args: '{"command":"ls"}', status: "ok" }],
        },
      },
      { expanded: false },
      context(false),
    );
    expect(joined).toContain("Ran 1 command");
    expect(joined).not.toContain("body");
    expect(joined).not.toContain("├");
  });

  it("mentions generated images in the collapsed glance", () => {
    const joined = render(
      {
        content: [
          { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nbody" },
          { type: "image", data: "iVBOR", mimeType: "image/png" },
        ],
        details: {
          calls: [{ id: "c1", name: "bash", args: '{"command":"ls"}', status: "ok" }],
        },
      },
      { expanded: false },
      context(false),
    );
    expect(joined.trimEnd()).toBe("└ Ran 1 command · 1 image");
  });

  it("renders child rows and collapsible code/output when expanded", () => {
    const joined = render(
      {
        content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nbody" }],
        details: {
          calls: [
            { id: "c1", name: "bash", args: '{"command":"pwd"}', status: "ok" },
            { id: "c2", name: "read", args: '{"path":"a.ts"}', status: "error", error: "missing" },
          ],
        },
      },
      { expanded: true },
      context(true),
    );
    expect(joined).toContain("1 failed");
    expect(joined).toContain("pwd");
    expect(joined).toContain("▸ code");
    expect(joined).toContain("▸ output");
    expect(joined).not.toContain("images");
  });

  it("hides script output while partial", () => {
    const joined = render(
      {
        content: [{ type: "text", text: "partial-body" }],
        details: { calls: [{ id: "c1", name: "bash", args: "{}", status: "running" }] },
      },
      { expanded: true, isPartial: true },
      context(true),
    );
    expect(joined).toContain("running");
    expect(joined).not.toContain("partial-body");
    expect(joined).not.toContain("▸ output");
  });

  it("toggles a section on click at the mapped y", () => {
    const state: Record<string, unknown> = {};
    const component = rendering.renderResult!(
      {
        content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nbody" }],
        details: {
          calls: [{ id: "c1", name: "bash", args: '{"command":"ls"}', status: "ok" }],
        },
      } as never,
      { expanded: true, isPartial: false } as never,
      theme,
      context(true, state) as never,
    ) as {
      render(width: number): string[];
      handleMouse(event: { type: string; button: string; y: number }): unknown;
    };

    // line 0 = root, line 1 = code section
    const before = component.render(80).join("\n");
    expect(before).toContain("▸ code");
    const result = component.handleMouse({ type: "click", button: "left", y: 1 });
    expect(result).toMatchObject({ handled: true });
    expect(state.expandedCode).toBe(true);
  });

  it("shows an images section and toggles it on click", () => {
    const state: Record<string, unknown> = {};
    const component = rendering.renderResult!(
      {
        content: [
          { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nbody" },
          { type: "image", data: "iVBOR", mimeType: "image/png" },
          { type: "image", data: "/9j/", mimeType: "image/jpeg" },
        ],
        details: {
          calls: [{ id: "c1", name: "bash", args: '{"command":"ls"}', status: "ok" }],
        },
      } as never,
      { expanded: true, isPartial: false } as never,
      theme,
      context(true, state) as never,
    ) as {
      render(width: number): string[];
      handleMouse(event: { type: string; button: string; y: number }): unknown;
    };

    // line 0 = root, 1 = code, 2 = call, 3 = output, 4 = images
    const before = component.render(80).join("\n");
    expect(before).toContain("2 images");
    expect(before).toContain("▸ images");
    const result = component.handleMouse({ type: "click", button: "left", y: 4 });
    expect(result).toMatchObject({ handled: true });
    expect(state.expandedImages).toBe(true);
    expect(component.render(80).join("\n")).toContain("generated images are attached");
    // Clicking again collapses the section.
    const second = component.handleMouse({ type: "click", button: "left", y: 4 });
    expect(second).toMatchObject({ handled: true });
    expect(state.expandedImages).toBe(false);
  });

  it("keeps click mapping exact when output wraps to visual rows", () => {
    const longLine = "y".repeat(100);
    const state: Record<string, unknown> = { expandedOutput: true };
    const component = rendering.renderResult!(
      {
        content: [
          { type: "text", text: `Script completed\nWall time 0.1 seconds\nOutput:\n${longLine}` },
          { type: "image", data: "iVBOR", mimeType: "image/png" },
        ],
        details: { calls: [] },
      } as never,
      { expanded: true, isPartial: false } as never,
      theme,
      context(true, state) as never,
    ) as {
      render(width: number): string[];
      handleMouse(event: { type: string; button: string; y: number }): unknown;
    };

    // width 40 → content width 35 → 100-char line wraps to 3 visual rows.
    // line 0 = root, 1 = code, 2 = output head, 3-5 = output body, 6 = images head.
    const lines = component.render(40);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain("images");
    const result = component.handleMouse({ type: "click", button: "left", y: 6 });
    expect(result).toMatchObject({ handled: true });
    expect(state.expandedImages).toBe(true);
    // A body row still maps to its own section.
    const outputToggle = component.handleMouse({ type: "click", button: "left", y: 4 });
    expect(outputToggle).toMatchObject({ handled: true });
    expect(state.expandedOutput).toBe(false);
  });
});
