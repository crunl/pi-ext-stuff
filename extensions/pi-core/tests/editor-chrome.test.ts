import { describe, expect, it } from "vitest";
import { PL_LEFT, PL_RIGHT } from "../../../packages/shared-tool-presentation/src/badge.ts";
import {
  bypassesExtensionShortcut,
  chromeEditorLines,
  registerEditorChrome,
} from "../src/tui/editor-chrome.ts";

// ------------------------------------------------------- shortcut bypass rule

describe("bypassesExtensionShortcut", () => {
  // shift+tab arrives as the raw CSI sequence \x1b[Z (pi-tui keys.js).
  const SHIFT_TAB = "\x1b[Z";

  it("bypasses shift+tab only while autocomplete is showing", () => {
    expect(bypassesExtensionShortcut(true, SHIFT_TAB)).toBe(true);
  });

  it("does not bypass shift+tab when autocomplete is closed (pi-safety mode cycling keeps working)", () => {
    expect(bypassesExtensionShortcut(false, SHIFT_TAB)).toBe(false);
  });

  it("does not bypass other keys even while autocomplete is showing", () => {
    expect(bypassesExtensionShortcut(true, "\t")).toBe(false); // plain tab
    expect(bypassesExtensionShortcut(true, "\r")).toBe(false); // enter
    expect(bypassesExtensionShortcut(true, "\x1b[A")).toBe(false); // up arrow
    expect(bypassesExtensionShortcut(true, "x")).toBe(false); // printable
  });
});

// ---------------------------------------------------------------- pure chrome

describe("chromeEditorLines", () => {
  const plain = (s: string) => s;

  it("splices the badge into the top border and closes the box", () => {
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", "─".repeat(28)],
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("Auto");
    expect(lines[1]).toBe("│hello│");
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("decorates the badge with powerline caps and the severity color", () => {
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", "─".repeat(28)],
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      (color) => (color === "warning" ? "\x1b[38;2;229;200;144m" : "\x1b[38;2;210;15;57m"),
    );
    const top = lines[0]!;
    expect(top).toContain(PL_LEFT);
    expect(top).toContain(PL_RIGHT);
    expect(top).toContain("\x1b[48;2;229;200;144m");
    expect(top).not.toContain("\x1b[38;2;210;15;57m");
  });

  it("falls back to inverse video without theme color data", () => {
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", "─".repeat(28)],
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    expect(lines[0]).toContain("\x1b[7m");
  });

  it("renders a plain border with no badge when there is no mode", () => {
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", "─".repeat(28)],
      28,
      true,
      undefined,
      plain,
      () => undefined,
    );
    expect(lines[0]).not.toContain(PL_LEFT);
    expect(lines[0]).toContain("╭");
  });

  it("treats a scroll-indicator row as the bottom border so the box closes", () => {
    const scrollRow = `─── ↓ 2 more ${"─".repeat(13)}`;
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", scrollRow],
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("skips the box when not boxed but still splices the badge", () => {
    const lines = chromeEditorLines(
      ["─".repeat(20), "hello", "─".repeat(20)],
      20,
      false,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    expect(lines[0]).toContain("Auto");
    expect(lines[0]).not.toContain("╭");
  });

  it("leaves autocomplete rows after the bottom border unboxed", () => {
    const lines = chromeEditorLines(
      ["─".repeat(28), "hello", "─".repeat(28), "  → item"],
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    // 4th row is after bottomIdx (2) → not wrapped in rails
    expect(lines[3]).toBe("  → item");
  });

  it("does not mutate the input array", () => {
    const input = ["─".repeat(28), "hello", "─".repeat(28)];
    const copy = [...input];
    chromeEditorLines(
      input,
      28,
      true,
      { label: "Auto", severity: "warning" },
      plain,
      () => undefined,
    );
    expect(input).toEqual(copy);
  });

  it("returns empty input untouched", () => {
    expect(
      chromeEditorLines(
        [],
        28,
        true,
        { label: "Auto", severity: "warning" },
        plain,
        () => undefined,
      ),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------- registration

function sessionStartContext() {
  let editorFactory: unknown;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: { getFgAnsi: () => undefined },
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: unknown) => {
        editorFactory = factory;
      },
    },
  };
  return { ctx, getFactory: () => editorFactory };
}

function fakePi() {
  const sessionHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
      sessionHandlers.set(name, handler);
    },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        busHandlers.set(name, handler);
      },
    },
  };
  return {
    pi,
    sessionHandlers,
    busHandlers,
    emitMode: (data: unknown) => busHandlers.get("pi-safety:mode")?.(data),
  };
}

describe("registerEditorChrome", () => {
  it("subscribes to the mode bus and installs an editor factory on session_start", () => {
    const pi = fakePi();
    registerEditorChrome(pi.pi as never);
    const { ctx, getFactory } = sessionStartContext();
    expect(pi.busHandlers.has("pi-safety:mode")).toBe(true);

    pi.sessionHandlers.get("session_start")?.({}, ctx);
    expect(typeof getFactory()).toBe("function");
  });

  it("does not install on a non-TUI session", () => {
    const pi = fakePi();
    registerEditorChrome(pi.pi as never);
    const { ctx, getFactory } = sessionStartContext();
    (ctx as { mode: string }).mode = "rpc";
    pi.sessionHandlers.get("session_start")?.({}, ctx);
    expect(getFactory()).toBeUndefined();
  });
});
