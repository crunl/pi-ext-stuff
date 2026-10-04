import { describe, expect, it } from "vitest";
import {
  BADGE_CAP_WIDTH,
  PL_LEFT,
  PL_RIGHT,
} from "../../../packages/shared-tool-presentation/src/badge.ts";
import { buildTopBorder } from "../src/tui/border-labels.ts";
import { applyBoxChrome } from "../src/tui/model-editor.ts";

const WIDTH = 40;

describe("buildTopBorder", () => {
  it("puts the mode badge on the left, sized for its powerline caps", () => {
    const top = buildTopBorder(WIDTH, "Plan");
    if (top === undefined) throw new Error("expected top border segments");
    expect(top.pre).toBe("──");
    expect(top.mode).toBe("Plan");
    expect(top.post).toMatch(/^─+$/);
    expect(top.pre.length + top.mode.length + BADGE_CAP_WIDTH + top.post.length).toBe(WIDTH);
  });

  it("keeps the badge text plain — the caller decorates it", () => {
    const top = buildTopBorder(WIDTH, "Auto");
    expect(top?.mode).toBe("Auto");
    expect(top?.mode).not.toContain(PL_LEFT);
  });

  it("returns undefined without a mode", () => {
    expect(buildTopBorder(WIDTH, undefined)).toBeUndefined();
  });

  it("returns undefined when the badge cannot fit", () => {
    expect(buildTopBorder(4, "Plan")).toBeUndefined();
  });
});

describe("applyBoxChrome", () => {
  function fakeEditor(lines: string[]) {
    return {
      customProp: 42,
      borderColor: (s: string) => `[c]${s}[/c]`,
      render: (_width: number) => lines,
    };
  }

  it("wraps the editor in-place and preserves original properties", () => {
    const rawEditor = fakeEditor(["─".repeat(28), "hello", "─".repeat(28)]);
    const decorated = applyBoxChrome(rawEditor, {
      getPermissionsMode: () => ({ label: "Plan", severity: "warning" }),
    });

    expect(decorated).toBe(rawEditor);
    expect(decorated.customProp).toBe(42);

    const lines = decorated.render(30);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("Plan");
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("decorates the badge with powerline caps and the severity color", () => {
    const rawEditor = fakeEditor(["─".repeat(28), "hello", "─".repeat(28)]);
    const decorated = applyBoxChrome(rawEditor, {
      getPermissionsMode: () => ({ label: "Auto", severity: "warning" }),
      getBadgeFgAnsi: (color) =>
        color === "warning" ? "\x1b[38;2;229;200;144m" : "\x1b[38;2;210;15;57m",
    });

    const top = decorated.render(30)[0];
    // Caps from the decorator, theme color as the pill background.
    expect(top).toContain(PL_LEFT);
    expect(top).toContain(PL_RIGHT);
    expect(top).toContain("\x1b[48;2;229;200;144m");
    expect(top).not.toContain("\x1b[48;2;210;15;57m");
  });

  it("falls back to inverse video without theme color data", () => {
    const rawEditor = fakeEditor(["─".repeat(28), "hello", "─".repeat(28)]);
    const decorated = applyBoxChrome(rawEditor, {
      getPermissionsMode: () => ({ label: "Auto", severity: "warning" }),
    });

    const top = decorated.render(30)[0];
    expect(top).toContain("\x1b[7m");
  });

  it("treats a scroll-indicator row as the bottom border", () => {
    // A scrolled editor replaces its bottom border with a scroll row;
    // the box must still close instead of dangling with a half box.
    const scrollRow = `─── ↓ 2 more ${"─".repeat(13)}`;
    const rawEditor = fakeEditor(["─".repeat(28), "input", scrollRow]);
    const decorated = applyBoxChrome(rawEditor);

    const lines = decorated.render(30);
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    expect(lines[2]).toContain("╰");
    expect(lines[2]).toContain("╯");
  });

  it("is transparent when disabled", () => {
    let enabled = true;
    const rawEditor = fakeEditor(["─".repeat(30), "input", "─".repeat(30)]);
    const decorated = applyBoxChrome(rawEditor, { isEnabled: () => enabled });

    expect(decorated.render(30)[0]).toContain("╭");

    enabled = false;
    expect(decorated.render(30)).toEqual(["─".repeat(30), "input", "─".repeat(30)]);
  });

  it("is idempotent — inner render runs once per render() invocation", () => {
    let renderCount = 0;
    const rawEditor = {
      borderColor: (s: string) => s,
      render: (_width: number) => {
        renderCount += 1;
        return ["─".repeat(30), "input", "─".repeat(30)];
      },
    };

    applyBoxChrome(rawEditor);
    applyBoxChrome(rawEditor);

    rawEditor.render(30);
    expect(renderCount).toBe(1);
  });
});
