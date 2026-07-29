import { describe, expect, it, vi } from "vitest";
import {
  applyAutocompleteAbove,
  computePanelRow,
  type FloatingTui,
  frameLines,
  locateEditor,
  registerAutocompleteAbove,
} from "../src/tui/autocomplete-above.ts";

const EDITOR_LINES = ["────", " > input", "────"];

function fakeEditor() {
  const editor: any = {
    getPaddingX: () => 1,
    render: (_width: number) => [...EDITOR_LINES],
  };
  return editor;
}

function fakeComponent(height: number) {
  return { render: (_w: number) => Array.from({ length: height }, () => "") };
}

/** A tui whose content fills the screen (bottom-aligned editor). */
function fakeTui(editor: unknown, { rows = 24, cols = 80, footerHeight = 2 } = {}) {
  const overlays: any[] = [];
  const editorContainer = { children: [editor] };
  const tui: FloatingTui & { overlays: any[] } = {
    terminal: { rows, columns: cols },
    cursorRow: rows - 1, // full screen => floating allowed
    children: [fakeComponent(30), editorContainer, fakeComponent(footerHeight)],
    overlays,
    showOverlay: vi.fn((component: any, options: any) => {
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return { hide: () => overlays.splice(overlays.indexOf(entry), 1) };
    }),
  } as any;
  return tui;
}

function activateAutocomplete(editor: any, items: string[]) {
  editor.autocompleteState = { itemRange: [0, 0] };
  editor.autocompleteList = { render: () => [...items] };
}

describe("frameLines", () => {
  it("adds a rounded top border and side verticals at exact frame width", () => {
    const inner = "item-a".padEnd(16); // frameWidth 20 - overhead 4
    const lines = frameLines([inner], 20, (t) => t);
    expect(lines[0]).toBe(`╭${"─".repeat(18)}╮`);
    expect(lines[1]).toBe(`│ ${inner} │`);
    for (const line of lines) expect(line).toHaveLength(20); // width conserved
  });

  it("colors only the border, not the content", () => {
    const color = vi.fn((t: string) => `<${t}>`);
    const lines = frameLines(["x"], 9, color);
    expect(lines[0]).toBe(`<╭${"─".repeat(7)}╮>`);
    expect(lines[1]).toBe("<│ >x< │>"); // content outside color wrapping
    expect(color).toHaveBeenCalledTimes(3); // top, left, right
  });
});

describe("locateEditor", () => {
  it("finds the editor nested in a root child container", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    expect(locateEditor(tui, editor)).toEqual({ childIndex: 1 });
  });

  it("finds an overlay-hosted editor via the overlay stack", () => {
    const editor = fakeEditor();
    const tui = fakeTui(fakeEditor());
    (tui as any).overlayStack = [{ component: editor }];
    expect(locateEditor(tui, editor)).toEqual({ overlay: true });
  });

  it("returns null when the editor is nowhere", () => {
    const tui = fakeTui(fakeEditor());
    expect(locateEditor(tui, fakeEditor())).toBeNull();
    expect(locateEditor(undefined, fakeEditor())).toBeNull();
  });
});

describe("computePanelRow", () => {
  it("anchors the panel to the editor top border on a full screen", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor, { rows: 24, footerHeight: 2 });
    // 24 - footer(2) - editor(3) - panel(2) = 17
    expect(computePanelRow(tui, editor, 3, 2)).toBe(17);
  });

  it("returns null when session content is shorter than the screen", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    tui.cursorRow = 10; // top-aligned content
    expect(computePanelRow(tui, editor, 3, 2)).toBeNull();
  });

  it("returns null when the editor is not among tui children", () => {
    const editor = fakeEditor();
    const tui = fakeTui(fakeEditor());
    expect(computePanelRow(tui, editor, 3, 2)).toBeNull();
  });

  it("returns null when there is no room above the editor", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor, { rows: 6, footerHeight: 2 });
    expect(computePanelRow(tui, editor, 3, 2)).toBeNull();
  });

  it("returns null without tui internals", () => {
    expect(computePanelRow(undefined, {}, 3, 2)).toBeNull();
  });
});

describe("applyAutocompleteAbove - floating mode", () => {
  it("shows a nonCapturing overlay and keeps editor lines unshifted", () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    const tui = fakeTui(editor);
    editor.tui = tui;
    activateAutocomplete(editor, ["item-a", "item-b"]);

    const lines = editor.render(20);

    expect(lines).toEqual(EDITOR_LINES); // zero layout shift
    expect(tui.showOverlay).toHaveBeenCalledOnce();
    const [component, options] = (tui.showOverlay as any).mock.calls[0];
    expect(options.nonCapturing).toBe(true);
    // panel = top border + 2 items = 3 rows
    expect(options.row).toBe(24 - 2 - 3 - 3);
    const panelLines = component.render(0);
    expect(panelLines[0]).toContain("╭"); // rounded top border
    expect(panelLines[1]).toContain("item-a");
    expect(panelLines[1]).toContain("│"); // side verticals
  });

  it("live-updates overlay options instead of re-creating the overlay", () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    const tui = fakeTui(editor);
    editor.tui = tui;
    activateAutocomplete(editor, ["item-a", "item-b"]);
    editor.render(20);

    editor.autocompleteList = { render: () => ["only-one"] };
    editor.render(20);

    expect(tui.showOverlay).toHaveBeenCalledOnce();
    // panel = top border + 1 item = 2 rows
    expect(tui.overlays[0].options.row).toBe(24 - 2 - 3 - 2);
  });

  it("self-heals: empties and removes the overlay when the editor is swapped out", async () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    const tui = fakeTui(editor);
    editor.tui = tui;
    activateAutocomplete(editor, ["item-a"]);
    editor.render(20);
    expect(tui.overlays).toHaveLength(1);
    const panel = tui.overlays[0].component;

    // Simulate the host replacing the editor (e.g. /statusline toggle):
    // the old editor is detached and never rendered again.
    (tui.children as any[])[1] = { children: [fakeEditor()] };

    expect(panel.render(20)).toEqual([]); // invisible this frame
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(tui.overlays).toHaveLength(0); // removed from the stack
  });

  it("hides the overlay when autocomplete deactivates", () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    const tui = fakeTui(editor);
    editor.tui = tui;
    activateAutocomplete(editor, ["item-a"]);
    editor.render(20);
    expect(tui.overlays).toHaveLength(1);

    editor.autocompleteState = null;
    editor.autocompleteList = undefined;
    const lines = editor.render(20);

    expect(lines).toEqual(EDITOR_LINES);
    expect(tui.overlays).toHaveLength(0);
  });
});

describe("applyAutocompleteAbove - inline fallback", () => {
  it("prepends panel lines when floating placement is unavailable", () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    // No tui internals at all => fallback.
    activateAutocomplete(editor, ["item-a", "item-b"]);

    const lines = editor.render(20);

    expect(lines[0]).toContain("╭"); // top border first
    expect(lines[1]).toContain("item-a");
    expect(lines[2]).toContain("item-b");
    expect(lines[3]).toContain("────");
    expect(editor.autocompleteList).toBeDefined(); // re-attached
  });

  it("falls back inline on short sessions (top-aligned content)", () => {
    const editor = applyAutocompleteAbove(fakeEditor());
    const tui = fakeTui(editor);
    tui.cursorRow = 5;
    editor.tui = tui;
    activateAutocomplete(editor, ["item-a"]);

    const lines = editor.render(20);

    expect(lines[0]).toContain("╭");
    expect(lines[1]).toContain("item-a");
    expect(tui.showOverlay).not.toHaveBeenCalled();
  });

  it("is idempotent - patching twice keeps a single panel", () => {
    const editor = applyAutocompleteAbove(applyAutocompleteAbove(fakeEditor()));
    activateAutocomplete(editor, ["item-a"]);

    const lines = editor.render(20);
    expect(lines.filter((l: string) => l.includes("item-a"))).toHaveLength(1);
  });
});

describe("registerAutocompleteAbove", () => {
  function sessionStartContext() {
    let editorFactory: any;
    const ctx = {
      ui: {
        getEditorComponent: () => editorFactory,
        setEditorComponent: (factory: any) => {
          editorFactory = factory;
        },
      },
    };
    return { ctx, getFactory: () => editorFactory };
  }

  function fakePi(handlers: Map<string, (event: unknown, ctx: unknown) => void>) {
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
    } as any;
  }

  it("installs a patched editor factory on session_start", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerAutocompleteAbove(fakePi(handlers));

    const { ctx, getFactory } = sessionStartContext();
    handlers.get("session_start")?.({}, ctx);

    expect(typeof getFactory()).toBe("function");
  });

  it("wraps a previously installed factory instead of discarding it", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerAutocompleteAbove(fakePi(handlers));

    const inner = fakeEditor();
    const previous = vi.fn(() => inner);
    const { ctx, getFactory } = sessionStartContext();
    ctx.ui.setEditorComponent(previous);
    handlers.get("session_start")?.({}, ctx);

    const produced = getFactory()({}, {}, {});
    expect(previous).toHaveBeenCalledOnce();
    expect(produced).toBe(inner);
    expect((produced as any).__autocompleteAbove).toBe(true);
  });

  it("does not re-wrap its own factory on repeated session_start", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerAutocompleteAbove(fakePi(handlers));

    const { ctx, getFactory } = sessionStartContext();
    handlers.get("session_start")?.({}, ctx);
    const first = getFactory();
    handlers.get("session_start")?.({}, ctx); // host did NOT reset
    handlers.get("session_start")?.({}, ctx);

    expect(getFactory()).toBe(first); // unchanged, no nesting
  });
});
