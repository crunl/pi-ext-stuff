import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

interface EditorInternals {
  autocompleteList?: { render(width: number): string[] };
  autocompleteState?: unknown;
  tui?: FloatingTui;
  __autocompleteAbove?: boolean;
}

interface PatchableEditor {
  render(width: number): string[];
  getPaddingX?(): number;
}

/** Minimal structural view of the pi-tui Component contract. */
interface FloatingComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface FloatingOverlayHandle {
  hide(): void;
}

interface FloatingOverlayOptions {
  row: number;
  col: number;
  width: number;
  nonCapturing: true;
}

/** Minimal structural view of the pi-tui TUI surface we rely on. */
export interface FloatingTui {
  terminal?: { rows: number; columns: number };
  children?: unknown[];
  showOverlay?(component: FloatingComponent, options: FloatingOverlayOptions): FloatingOverlayHandle;
  /** Private in pi-tui: logical end-of-content row from the previous frame. */
  cursorRow?: number;
}

/** Stateless overlay component that mirrors the autocomplete list lines. */
class FloatingPanel implements FloatingComponent {
  private lines: string[] = [];

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return this.lines;
  }

  invalidate(): void {}
}

/**
 * Compute the viewport row where the floating panel should sit so it hugs the
 * editor's top border. Returns null when floating placement is unsafe (short
 * sessions where content is top-aligned, missing internals, no room), in
 * which case the caller falls back to inline rendering above the editor.
 */
export function computePanelRow(
  tui: FloatingTui | undefined,
  editor: unknown,
  editorHeight: number,
  panelHeight: number,
): number | null {
  const termHeight = tui?.terminal?.rows;
  const termWidth = tui?.terminal?.columns;
  const children = tui?.children;
  if (!termHeight || !termWidth || !Array.isArray(children)) return null;

  // Content shorter than one screen renders top-aligned; the bottom-anchored
  // math below would detach the panel from the editor. Fall back to inline.
  const cursorRow = tui?.cursorRow;
  if (typeof cursorRow !== "number" || cursorRow + 1 < termHeight) return null;

  // Locate the editor (or its container) among the TUI root children, then
  // sum the rendered height of everything below it (widgets, footer).
  let editorIndex = -1;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as { children?: unknown[] };
    if (child === editor || (Array.isArray(child.children) && child.children.includes(editor))) {
      editorIndex = i;
      break;
    }
  }
  if (editorIndex === -1) return null;

  let suffixHeight = 0;
  for (let i = editorIndex + 1; i < children.length; i++) {
    const sibling = children[i] as { render?(width: number): string[] };
    if (typeof sibling.render !== "function") return null;
    suffixHeight += sibling.render(termWidth).length;
  }

  const row = termHeight - suffixHeight - editorHeight - panelHeight;
  return row >= 0 ? row : null;
}

/**
 * Patch an editor instance so its autocomplete panel appears ABOVE the input
 * box. When the surrounding TUI allows it, the panel floats as a nonCapturing
 * overlay hugging the editor's top border (no layout shift); otherwise it
 * degrades to inline lines prepended above the editor. Idempotent.
 */
export function applyAutocompleteAbove<T extends PatchableEditor>(editor: T): T {
  const internals = editor as unknown as EditorInternals;
  if (internals.__autocompleteAbove) return editor;
  internals.__autocompleteAbove = true;

  const originalRender = editor.render.bind(editor);
  const patched = editor as PatchableEditor;

  const panel = new FloatingPanel();
  let handle: FloatingOverlayHandle | undefined;
  let overlayOptions: FloatingOverlayOptions | undefined;

  const hideOverlay = () => {
    try {
      handle?.hide();
    } finally {
      handle = undefined;
      overlayOptions = undefined;
    }
  };

  patched.render = (width: number): string[] => {
    const list = internals.autocompleteList;
    if (!internals.autocompleteState || !list) {
      hideOverlay();
      return originalRender(width);
    }

    // Detach so the original render skips its own (below) placement.
    internals.autocompleteList = undefined;
    let editorLines: string[];
    try {
      editorLines = originalRender(width);
    } finally {
      internals.autocompleteList = list;
    }

    // Mirror the base Editor's padding math so the panel aligns with content.
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const paddingX = Math.min(editor.getPaddingX?.() ?? 0, maxPadding);
    const contentWidth = Math.max(1, width - paddingX * 2);
    const listLines = list.render(contentWidth).map((line) => {
      const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
      return `${line}${fill}`;
    });

    // Floating mode: composite the panel over existing content, zero layout shift.
    const tui = internals.tui;
    let row: number | null = null;
    try {
      row = computePanelRow(tui, editor, editorLines.length, listLines.length);
    } catch {
      row = null;
    }
    if (row !== null && tui && typeof tui.showOverlay === "function") {
      panel.setLines(listLines);
      if (handle && overlayOptions) {
        // Live-update: compositeOverlays re-reads options by reference each frame.
        overlayOptions.row = row;
        overlayOptions.col = paddingX;
        overlayOptions.width = contentWidth;
      } else {
        overlayOptions = { row, col: paddingX, width: contentWidth, nonCapturing: true };
        handle = tui.showOverlay(panel, overlayOptions);
      }
      return editorLines;
    }

    // Inline fallback: prepend the panel lines above the editor box.
    hideOverlay();
    const pad = " ".repeat(paddingX);
    return [...listLines.map((line) => `${pad}${line}${pad}`), ...editorLines];
  };
  return editor;
}

/**
 * Install the above-panel behavior. Composes with an editor factory set by an
 * earlier extension; extensions that install their own editor AFTER pi-core
 * (e.g. statusline) must call applyAutocompleteAbove() on their instance.
 */
export function registerAutocompleteAbove(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      previous
        ? applyAutocompleteAbove(previous(tui, theme, keybindings))
        : applyAutocompleteAbove(new CustomEditor(tui, theme, keybindings)),
    );
  });
}
