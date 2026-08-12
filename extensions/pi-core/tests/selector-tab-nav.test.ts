import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FloatingTui } from "../src/tui/editor-float-panel.ts";
import {
  isSelectorOpen,
  registerSelectorTabNav,
  rewriteSelectorNavInput,
  setSelectorNavAnchor,
} from "../src/tui/selector-tab-nav.ts";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function fakeEditor() {
  return { render: (_w: number) => ["editor"] };
}

/** tui whose editorContainer (children[1]) currently holds `occupant`. */
function fakeTui(occupant: unknown): FloatingTui {
  return {
    mode: "regular",
    terminal: { rows: 24, columns: 80 },
    children: [{ render: () => [] }, { children: [occupant] }, { render: () => [] }],
  } as FloatingTui;
}

describe("selector tab navigation", () => {
  beforeEach(() => {
    setSelectorNavAnchor(undefined, undefined);
  });

  it("is closed while the editor sits in its container", () => {
    const editor = fakeEditor();
    setSelectorNavAnchor(fakeTui(editor), editor);
    expect(isSelectorOpen()).toBe(false);
    expect(rewriteSelectorNavInput(TAB)).toBeUndefined();
    expect(rewriteSelectorNavInput(SHIFT_TAB)).toBeUndefined();
  });

  it("rewrites tab/shift+tab to down/up while a selector occupies the slot", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    setSelectorNavAnchor(tui, editor);
    // Host swaps in a selector (showSelector: clear + addChild).
    (tui.children as any[])[1] = { children: [{ render: () => ["selector"] }] };

    expect(isSelectorOpen()).toBe(true);
    expect(rewriteSelectorNavInput(TAB)).toEqual({ data: DOWN });
    expect(rewriteSelectorNavInput(SHIFT_TAB)).toEqual({ data: UP });
  });

  it("passes other keys through while a selector is open", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    setSelectorNavAnchor(tui, editor);
    (tui.children as any[])[1] = { children: [{ render: () => ["selector"] }] };

    expect(rewriteSelectorNavInput("a")).toBeUndefined();
    expect(rewriteSelectorNavInput("\r")).toBeUndefined(); // enter untouched
    expect(rewriteSelectorNavInput("\x1b")).toBeUndefined(); // escape untouched
  });

  it("does nothing without an anchor (before any editor was patched)", () => {
    expect(isSelectorOpen()).toBe(false);
    expect(rewriteSelectorNavInput(TAB)).toBeUndefined();
  });

  it("recovers when the editor returns to its container (selector closed)", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    setSelectorNavAnchor(tui, editor);
    (tui.children as any[])[1] = { children: [{ render: () => ["selector"] }] };
    expect(isSelectorOpen()).toBe(true);

    (tui.children as any[])[1] = { children: [editor] }; // done() restores editor
    expect(isSelectorOpen()).toBe(false);
    expect(rewriteSelectorNavInput(TAB)).toBeUndefined();
  });

  it("registers a terminal input listener on session_start when UI exists", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerSelectorTabNav({
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
    } as any);

    const onTerminalInput = vi.fn();
    handlers.get("session_start")?.({}, { hasUI: true, mode: "tui", ui: { onTerminalInput } });
    expect(onTerminalInput).toHaveBeenCalledWith(rewriteSelectorNavInput);

    onTerminalInput.mockClear();
    handlers.get("session_start")?.({}, { hasUI: true, mode: "rpc", ui: { onTerminalInput } });
    expect(onTerminalInput).not.toHaveBeenCalled();
  });

  it("shares the anchor via globalThis across module copies (jiti isolation)", () => {
    const key = Symbol.for("@x1a2h1/pi-core:selector-tab-nav-anchor");
    const editor = fakeEditor();
    const tui = fakeTui(editor);

    // Writer path: setSelectorNavAnchor must land on the shared key.
    setSelectorNavAnchor(tui, editor);
    const stored = (globalThis as Record<symbol, { editor: unknown } | undefined>)[key];
    expect(stored?.editor).toBe(editor);

    // Reader path: a foreign jiti copy writing the same key is visible here.
    const foreignEditor = fakeEditor();
    const foreignTui = fakeTui(foreignEditor);
    (globalThis as Record<symbol, unknown>)[key] = {
      resolveTui: () => foreignTui,
      editor: foreignEditor,
    };
    expect(isSelectorOpen()).toBe(false);
    expect(rewriteSelectorNavInput(SHIFT_TAB)).toBeUndefined();

    (foreignTui.children as any[])[1] = { children: [{ render: () => ["selector"] }] };
    expect(isSelectorOpen()).toBe(true);
    expect(rewriteSelectorNavInput(SHIFT_TAB)).toEqual({ data: UP });
  });
});
