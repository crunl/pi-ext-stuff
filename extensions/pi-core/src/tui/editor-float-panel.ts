/**
 * EditorFloatPanel - a reusable floating panel anchored above the input
 * editor. Renders arbitrary lines as a nonCapturing overlay hugging the
 * editor's top border (zero layout shift). Self-heals when the anchor
 * editor disappears from the TUI (renders empty, then removes itself).
 *
 * Consumers decide WHAT to show (and any framing/colors); this class only
 * solves WHERE and HOW LONG to show it.
 */

/** Minimal structural view of the pi-tui Component contract. */
interface FloatingComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface FloatingOverlayHandle {
  hide(): void;
  /** Present on pi-tui >= 0.x; toggles visibility without removing the entry. */
  setHidden?(hidden: boolean): void;
  isHidden?(): boolean;
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
  showOverlay?(
    component: FloatingComponent,
    options: FloatingOverlayOptions,
  ): FloatingOverlayHandle;
  /** Private in pi-tui: logical end-of-content row from the previous frame. */
  cursorRow?: number;
  /** Private in pi-tui: active overlay entries ({ component, ... }). */
  overlayStack?: { component?: unknown }[];
}

/**
 * Single seam for "where is the editor in the TUI": searches the root
 * children (and one nesting level, e.g. editorContainer) plus the overlay
 * stack. Placement math and the panel's liveness check share this so their
 * verdicts can never diverge. If a future pi hosts the editor elsewhere,
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
 * when the session content is shorter than one screen (pi renders content
 * top-aligned in that case, so bottom-anchored placement math would detach
 * the panel from the editor).
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
 * which case callers should fall back to inline rendering.
 */
export function computePanelRow(
  tui: FloatingTui | undefined,
  editor: unknown,
  editorHeight: number,
  panelHeight: number,
): number | null {
  const layout = resolveLayout(tui, editor);
  if (!layout?.bottomAnchored) return null;

  const termHeight = tui?.terminal?.rows;
  if (!termHeight) return null;
  const row = termHeight - layout.suffixHeight - editorHeight - panelHeight;
  return row >= 0 ? row : null;
}

/** Overlay component that replays the panel lines and self-heals. */
class PanelComponent implements FloatingComponent {
  private lines: string[] = [];
  isAlive?: () => boolean;
  onDead?: () => void;
  private deadNotified = false;

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  render(_width: number): string[] {
    // Self-healing: if the anchor editor was swapped out while the panel
    // was floating, nobody calls hide() anymore. Render nothing and
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

interface EditorFloatPanelShowOptions {
  /** Rendered height of the editor this frame (for row placement). */
  editorHeight: number;
  /** Column where the panel starts (usually the editor's paddingX). */
  col: number;
  /** Panel content width; lines must already be padded to this width. */
  width: number;
}

/**
 * Reusable floating panel anchored above the input editor.
 *
 * show() places (or live-updates) the panel; returns false when floating
 * placement is unavailable so the caller can degrade (e.g. render inline).
 * hide() conceals the panel. The panel self-heals if the anchor editor
 * disappears: it renders empty and removes its overlay on the next frame.
 *
 * The overlay entry is mounted once and toggled via the handle's
 * setHidden() (public OverlayHandle API), keeping the overlay stack stable
 * across rapid show/hide cycles while typing; dispose() (or self-healing)
 * removes the entry for good.
 */
export class EditorFloatPanel {
  private readonly component = new PanelComponent();
  private handle: FloatingOverlayHandle | undefined;
  private options: FloatingOverlayOptions | undefined;
  private readonly tui: FloatingTui | undefined;
  private readonly anchor: unknown;

  // Explicit assignment (not parameter properties) keeps this file loadable
  // under node's strip-only TypeScript mode used by sibling extensions.
  constructor(tui: FloatingTui | undefined, anchor: unknown) {
    this.tui = tui;
    this.anchor = anchor;
  }

  get visible(): boolean {
    return this.handle !== undefined && !(this.handle.isHidden?.() ?? false);
  }

  show(lines: string[], opts: EditorFloatPanelShowOptions): boolean {
    const tui = this.tui;
    let row: number | null = null;
    try {
      row = computePanelRow(tui, this.anchor, opts.editorHeight, lines.length);
    } catch {
      row = null;
    }
    if (row === null || !tui || typeof tui.showOverlay !== "function") {
      this.hide();
      return false;
    }

    this.component.setLines(lines);
    if (this.handle && this.options) {
      // Live-update: compositeOverlays re-reads options by reference each frame.
      this.options.row = row;
      this.options.col = opts.col;
      this.options.width = opts.width;
      this.handle.setHidden?.(false);
    } else {
      this.component.isAlive = () => locateEditor(this.tui, this.anchor) !== null;
      // Self-healing removes the entry permanently: a dead anchor never
      // comes back, so the orphaned overlay must not linger in the stack.
      this.component.onDead = () => this.dispose();
      this.options = { row, col: opts.col, width: opts.width, nonCapturing: true };
      this.handle = tui.showOverlay(this.component, this.options);
    }
    return true;
  }

  /** Conceal the panel, keeping the overlay entry mounted for reuse. */
  hide(): void {
    if (!this.handle) return;
    // Hidden entries are skipped by the compositor, so render()-based
    // self-healing cannot fire while concealed. If the anchor is already
    // gone, remove the entry now instead of leaving it in the stack.
    if (!this.handle.setHidden || locateEditor(this.tui, this.anchor) === null) {
      this.dispose();
      return;
    }
    this.handle.setHidden(true);
  }

  /** Remove the overlay entry permanently. */
  dispose(): void {
    try {
      this.handle?.hide();
    } finally {
      this.handle = undefined;
      this.options = undefined;
    }
  }
}
