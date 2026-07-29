import { locateEditor, type FloatingTui } from "./autocomplete-above.ts";

interface PinnableTui extends FloatingTui {
  render?(width: number): string[];
  __pinnedBottomRef?: { editor: unknown; container?: unknown };
}

interface RenderableChild {
  render?(width: number): string[];
}

/**
 * Compute how many blank lines to insert, and where, so the pinned tail
 * (widgetContainerAbove, editorContainer, widgetContainerBelow, footer)
 * sits at the bottom of the viewport when content is shorter than one
 * screen. Returns null when no padding is needed or the layout cannot be
 * resolved safely.
 */
export function computeBottomPadding(
  tui: PinnableTui,
  editor: unknown,
  totalLines: number,
  width: number,
  container?: unknown,
): { insertAt: number; count: number } | null {
  const rows = tui.terminal?.rows;
  if (!rows || totalLines >= rows) return null;

  const children = tui.children as RenderableChild[] | undefined;
  if (!Array.isArray(children)) return null;

  // Primary: locate the current editor. Fallback: locate the remembered
  // editorContainer - the host swaps editor instances inside the same
  // container (setCustomEditorComponent clears + re-adds), so the container
  // keeps pinning alive when our editor reference goes stale (e.g. the
  // /statusline toggle restoring the default editor).
  const location = locateEditor(tui, editor);
  let childIndex: number;
  if (location && "childIndex" in location) {
    childIndex = location.childIndex;
  } else if (container !== undefined) {
    childIndex = children.indexOf(container as RenderableChild);
    if (childIndex === -1) return null;
  } else {
    return null;
  }

  // Pinned tail starts at widgetContainerAbove: the sibling right before the
  // editor container. Guard against the editor being the first child.
  // NOTE: positional coupling with interactive-mode's child order - if the
  // host ever inserts a container between widgetContainerAbove and the
  // editor, this start index must be revisited.
  const pinnedStart = Math.max(0, childIndex - 1);
  let pinnedHeight = 0;
  for (let i = pinnedStart; i < children.length; i++) {
    const child = children[i];
    if (typeof child.render !== "function") return null;
    pinnedHeight += child.render(width).length;
  }
  if (pinnedHeight >= rows) return null; // tail alone overflows: nothing sane to pin

  return {
    insertAt: totalLines - pinnedHeight,
    count: rows - totalLines,
  };
}

/**
 * Patch a TUI instance so the editor area and footer stay pinned to the
 * bottom of the terminal even when the session content is shorter than one
 * screen. Works by padding blank lines between the content flow and the
 * pinned tail inside render(); the differential renderer, overlays, and
 * cursor extraction all run after this and need no adaptation.
 *
 * Idempotent per TUI instance; repeated calls only refresh the tracked
 * editor reference (editors are recreated on session switches and
 * /statusline toggles while the TUI instance survives).
 */
export function applyPinnedBottom(tui: unknown, editor: unknown): void {
  const target = tui as PinnableTui | undefined;
  if (!target) return;
  if (target.__pinnedBottomRef) {
    target.__pinnedBottomRef.editor = editor;
    return;
  }
  if (typeof target.render !== "function") return;
  const ref: { editor: unknown; container?: unknown } = { editor };
  target.__pinnedBottomRef = ref;

  const originalRender = target.render.bind(target);
  target.render = (width: number): string[] => {
    const lines = originalRender(width);
    let padding: { insertAt: number; count: number } | null = null;
    try {
      // Remember the editor's container while the editor is locatable, so
      // future frames survive an editor swap we were not told about (e.g.
      // /statusline toggle restoring the default editor). Refreshed every
      // frame, not just when padding applies - a session can start beyond
      // one screen and swap editors before ever needing padding.
      const location = locateEditor(target, ref.editor);
      if (location && "childIndex" in location) {
        ref.container = (target.children as unknown[])[location.childIndex];
      }
      padding = computeBottomPadding(target, ref.editor, lines.length, width, ref.container);
    } catch {
      padding = null;
    }
    if (!padding) return lines;
    lines.splice(padding.insertAt, 0, ...Array.from({ length: padding.count }, () => ""));
    return lines;
  };
}
