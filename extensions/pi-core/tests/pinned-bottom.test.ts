import { describe, expect, it } from "vitest";
import { applyPinnedBottom, computeBottomPadding } from "../src/tui/pinned-bottom.ts";

const CONTENT_HEIGHT = 8;
const WIDGET_ABOVE = 1;
const EDITOR_HEIGHT = 3;
const WIDGET_BELOW = 1;
const FOOTER_HEIGHT = 2;
const PINNED = WIDGET_ABOVE + EDITOR_HEIGHT + WIDGET_BELOW + FOOTER_HEIGHT;

function fakeComponent(height: number, label = "") {
  return { render: (_w: number) => Array.from({ length: height }, (_, i) => `${label}${i}`) };
}

function fakeEditor() {
  return { render: (_w: number) => ["──", ">", "──"], getPaddingX: () => 0 };
}

/** Mimics the interactive-mode children layout: [content..., widgetAbove, editorContainer, widgetBelow, footer]. */
function fakeTui(editor: unknown, { rows = 24, contentHeight = CONTENT_HEIGHT } = {}) {
  const children = [
    fakeComponent(contentHeight, "c"),
    fakeComponent(WIDGET_ABOVE, "wa"),
    { children: [editor] , render: (_w: number) => ["──", ">", "──"] },
    fakeComponent(WIDGET_BELOW, "wb"),
    fakeComponent(FOOTER_HEIGHT, "f"),
  ];
  const tui: any = {
    terminal: { rows, columns: 80 },
    children,
    render: (width: number) => children.flatMap((c: any) => c.render(width)),
  };
  return tui;
}

describe("computeBottomPadding", () => {
  it("pads between content and the pinned tail on a short session", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    const total = CONTENT_HEIGHT + PINNED; // 15 < 24
    const padding = computeBottomPadding(tui, editor, total, 80);
    expect(padding).toEqual({
      insertAt: total - PINNED, // right after content, before widgetAbove
      count: 24 - total,
    });
  });

  it("returns null when content already fills the screen", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor, { contentHeight: 40 });
    expect(computeBottomPadding(tui, editor, 40 + PINNED, 80)).toBeNull();
  });

  it("returns null when the editor cannot be located", () => {
    const tui = fakeTui(fakeEditor());
    expect(computeBottomPadding(tui, fakeEditor(), 10, 80)).toBeNull();
  });

  it("returns null when the pinned tail alone overflows the screen", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor, { rows: 5 });
    expect(computeBottomPadding(tui, editor, 4, 80)).toBeNull();
  });
});

describe("applyPinnedBottom", () => {
  it("pins the tail to the last rows of the viewport", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    applyPinnedBottom(tui, editor);

    const lines = tui.render(80);

    expect(lines).toHaveLength(24);
    expect(lines[24 - PINNED]).toBe("wa0"); // widgetAbove starts the pinned tail
    expect(lines[23]).toBe("f1"); // footer bottom row is the last viewport row
    expect(lines[CONTENT_HEIGHT]).toBe(""); // padding right after content
  });

  it("leaves a full screen untouched", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor, { contentHeight: 40 });
    const before = tui.render(80).length;
    applyPinnedBottom(tui, editor);
    expect(tui.render(80)).toHaveLength(before);
  });

  it("re-pads correctly after terminal resize", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    applyPinnedBottom(tui, editor);
    tui.terminal.rows = 30;
    expect(tui.render(80)).toHaveLength(30);
    tui.terminal.rows = 10; // 15 content+tail > 10 rows: no padding
    expect(tui.render(80)).toHaveLength(CONTENT_HEIGHT + PINNED);
  });

  it("is idempotent and refreshes the tracked editor reference", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    applyPinnedBottom(tui, editor);
    applyPinnedBottom(tui, editor); // second call must not double-wrap
    expect(tui.render(80)).toHaveLength(24);

    // Swap the editor (session switch): old ref would fail locateEditor,
    // refreshing via a new applyPinnedBottom call restores pinning.
    const newEditor = fakeEditor();
    (tui.children as any[])[2] = { children: [newEditor], render: () => ["──", ">", "──"] };
    expect(tui.render(80)).toHaveLength(CONTENT_HEIGHT + PINNED); // stale ref: no padding
    applyPinnedBottom(tui, newEditor);
    expect(tui.render(80)).toHaveLength(24); // pinned again
  });

  it("falls back to unpadded lines when padding math throws", () => {
    const editor = fakeEditor();
    const tui = fakeTui(editor);
    applyPinnedBottom(tui, editor);
    // Base render (children flatMap) does not touch terminal, but
    // computeBottomPadding reads terminal.rows first - make it throw.
    Object.defineProperty(tui, "terminal", {
      get() {
        throw new Error("boom");
      },
    });
    const lines = tui.render(80);
    expect(lines).toHaveLength(CONTENT_HEIGHT + PINNED); // unpadded, no crash
  });
});
