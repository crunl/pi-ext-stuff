import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyPinnedBottom } from "./pinned-bottom.ts";

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
  /** Private in pi-tui: active overlay entries ({ component, ... }). */
  overlayStack?: { component?: unknown }[];
}

/** Stateless overlay component that mirrors the autocomplete list lines. */
class FloatingPanel implements FloatingComponent {
  private lines: string[] = [];
  /** When set and returning false, the panel renders empty and schedules removal. */
  isAlive?: () => boolean;
  /** Invoked (once) from render when isAlive() turns false. */
  onDead?: () => void;
  private deadNotified = false;

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  render(_width: number): string[] {
    // Self-healing: if the patched editor was swapped out while the panel
    // was floating, nobody calls hideOverlay() anymore. Render nothing and
    // schedule removal outside the composite pass.
    if (this.isAlive && !this.isAlive()) {
      if (!this.deadNotified) {
        this.deadNotified = true;
        if (this.onDead) queueMicrotask(this.onDead);
      }
      return [];
    }
    this.deadNotified = false;
    return this.lines;
  }

  invalidate(): void {}
}

/**
 * Single seam for "where is the editor in the TUI": searches the root
 * children (and one nesting level, e.g. editorContainer) plus the overlay
 * stack. computePanelRow and the panel's isAlive check share this so their
 * verdicts can never diverge. If a future pi pins the editor as an overlay,
 * only this function needs to learn the new location.
 */
export function locateEditor(
  tui: FloatingTui | undefined,
  editor: unknown,
): { childIndex: number } | { overlay: true } | null {
  const children = tui?.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as { children?: unknown[] };
      if (child === editor || (Array.isArray(child.children) && child.children.includes(editor))) {
        return { childIndex: i };
      }
    }
  }
  const overlays = tui?.overlayStack;
  if (Array.isArray(overlays) && overlays.some((entry) => entry?.component === editor)) {
    return { overlay: true };
  }
  return null;
}

interface PanelLayout {
  /** Rendered height of everything below the editor (widgets, footer). */
  suffixHeight: number;
  /** True when the editor sits at the bottom of the viewport. */
  bottomAnchored: boolean;
}

/**
 * Resolve the layout facts computePanelRow needs. bottomAnchored is false
 * for short top-aligned sessions today; a future pinned-bottom layout only
 * needs to make this return bottomAnchored: true for its new structure.
 */
function resolveLayout(tui: FloatingTui | undefined, editor: unknown): PanelLayout | null {
  const termHeight = tui?.terminal?.rows;
  const termWidth = tui?.terminal?.columns;
  if (!termHeight || !termWidth) return null;

  const location = locateEditor(tui, editor);
  if (!location) return null;
  if (!("childIndex" in location)) return null; // overlay-hosted editor: not supported yet

  const children = tui?.children as { render?(width: number): string[] }[];
  let suffixHeight = 0;
  for (let i = location.childIndex + 1; i < children.length; i++) {
    const sibling = children[i];
    if (typeof sibling.render !== "function") return null;
    suffixHeight += sibling.render(termWidth).length;
  }

  // Content shorter than one screen renders top-aligned (cursorRow is the
  // previous frame's end-of-content row).
  const cursorRow = tui?.cursorRow;
  const bottomAnchored = typeof cursorRow === "number" && cursorRow + 1 >= termHeight;
  return { suffixHeight, bottomAnchored };
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
  const layout = resolveLayout(tui, editor);
  if (!layout || !layout.bottomAnchored) return null;

  const termHeight = tui!.terminal!.rows;
  const row = termHeight - layout.suffixHeight - editorHeight - panelHeight;
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
  // Pin the editor area + footer to the bottom of the viewport. Runs on
  // every call (not gated by the idempotency flag below) so a recreated
  // editor refreshes the reference tracked by the TUI-level patch.
  applyPinnedBottom(internals.tui, editor);
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
        panel.isAlive = () => locateEditor(internals.tui, editor) !== null;
        panel.onDead = hideOverlay;
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
    // The host resets the editor factory before re-emitting session_start,
    // but guard anyway: never wrap our own factory (would grow the closure
    // chain across resumes/forks if that reset ever changes).
    if ((previous as { __autocompleteAbove?: boolean } | undefined)?.__autocompleteAbove) return;
    const factory = (
      tui: Parameters<NonNullable<typeof previous>>[0],
      theme: Parameters<NonNullable<typeof previous>>[1],
      keybindings: Parameters<NonNullable<typeof previous>>[2],
    ) =>
      previous
        ? applyAutocompleteAbove(previous(tui, theme, keybindings))
        : applyAutocompleteAbove(new CustomEditor(tui, theme, keybindings));
    (factory as { __autocompleteAbove?: boolean }).__autocompleteAbove = true;
    ctx.ui.setEditorComponent(factory);
  });
}
