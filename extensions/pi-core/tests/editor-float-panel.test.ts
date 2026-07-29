import { describe, expect, it, vi } from "vitest";
import {
  computePanelRow,
  EditorFloatPanel,
  type FloatingTui,
  locateEditor,
} from "../src/tui/editor-float-panel.ts";

function fakeEditor() {
  return { render: (_w: number) => ["──", ">", "──"] };
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
      return {
        hide: () => overlays.splice(overlays.indexOf(entry), 1),
        setHidden: (hidden: boolean) => {
          entry.hidden = hidden;
        },
        isHidden: () => entry.hidden,
      };
    }),
  } as any;
  return tui;
}

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

describe("EditorFloatPanel", () => {
  it("shows a nonCapturing overlay at the computed row", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);

    const ok = panel.show(["line-1", "line-2"], { editorHeight: 3, col: 1, width: 18 });

    expect(ok).toBe(true);
    expect(panel.visible).toBe(true);
    const [component, options] = (tui.showOverlay as any).mock.calls[0];
    expect(options.nonCapturing).toBe(true);
    expect(options.row).toBe(24 - 2 - 3 - 2);
    expect(component.render(0)).toEqual(["line-1", "line-2"]);
  });

  it("live-updates options instead of re-creating the overlay", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a", "b"], { editorHeight: 3, col: 1, width: 18 });

    panel.show(["only-one"], { editorHeight: 3, col: 2, width: 20 });

    expect(tui.showOverlay).toHaveBeenCalledOnce();
    expect(tui.overlays[0].options.row).toBe(24 - 2 - 3 - 1);
    expect(tui.overlays[0].options.col).toBe(2);
    expect(tui.overlays[0].options.width).toBe(20);
  });

  it("returns false and conceals when floating placement is unavailable", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });
    expect(panel.visible).toBe(true);

    tui.cursorRow = 5; // content no longer fills the screen
    const ok = panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });

    expect(ok).toBe(false);
    expect(panel.visible).toBe(false);
    // Entry stays mounted (hidden) for cheap re-show; editor is still alive.
    expect(tui.overlays).toHaveLength(1);
    expect(tui.overlays[0].hidden).toBe(true);
  });

  it("hide() conceals the overlay entry and show() re-reveals it", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });

    panel.hide();

    expect(panel.visible).toBe(false);
    expect(tui.overlays).toHaveLength(1); // mounted but hidden
    expect(tui.overlays[0].hidden).toBe(true);

    panel.show(["b"], { editorHeight: 3, col: 1, width: 18 });
    expect(panel.visible).toBe(true);
    expect(tui.overlays[0].hidden).toBe(false);
    expect(tui.showOverlay).toHaveBeenCalledOnce(); // stack untouched
  });

  it("hide() removes the entry when the anchor editor is already gone", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });

    (tui.children as any[])[1] = { children: [fakeEditor()] }; // anchor detached
    panel.hide();

    expect(tui.overlays).toHaveLength(0); // no orphan left in the stack
  });

  it("hide() falls back to removal without setHidden support", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const legacyShow = tui.showOverlay as any;
    tui.showOverlay = vi.fn((component: any, options: any) => {
      const handle = legacyShow(component, options);
      return { hide: handle.hide }; // no setHidden
    }) as any;
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });

    panel.hide();

    expect(panel.visible).toBe(false);
    expect(tui.overlays).toHaveLength(0);
  });

  it("dispose() removes the overlay entry", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });

    panel.dispose();

    expect(panel.visible).toBe(false);
    expect(tui.overlays).toHaveLength(0);
  });

  it("self-heals when the anchor editor is swapped out", async () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const panel = new EditorFloatPanel(tui, editor);
    panel.show(["a"], { editorHeight: 3, col: 1, width: 18 });
    const component = tui.overlays[0].component;

    // Host replaces the editor; the old anchor is detached.
    (tui.children as any[])[1] = { children: [fakeEditor()] };

    expect(component.render(20)).toEqual([]); // invisible this frame
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(tui.overlays).toHaveLength(0); // removed from the stack
    expect(panel.visible).toBe(false);
  });

  it("returns false without a tui or showOverlay", () => {
    const editor = fakeEditor();
    expect(
      new EditorFloatPanel(undefined, editor).show(["a"], { editorHeight: 3, col: 0, width: 10 }),
    ).toBe(false);
    const noOverlayTui = { terminal: { rows: 24, columns: 80 }, children: [] } as FloatingTui;
    expect(
      new EditorFloatPanel(noOverlayTui, editor).show(["a"], {
        editorHeight: 3,
        col: 0,
        width: 10,
      }),
    ).toBe(false);
  });
});
