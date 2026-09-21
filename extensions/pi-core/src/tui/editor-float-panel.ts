/**
 * EditorFloatPanel - a reusable floating panel anchored above the input
 * editor. Renders arbitrary lines as a nonCapturing overlay hugging the
 * editor's top border (zero layout shift). Self-heals when the anchor
 * editor disappears from the TUI (renders empty, then removes itself).
 *
 * Consumers decide WHAT to show (and any framing/colors); this class only
 * solves WHERE and HOW LONG to show it.
 */
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TUI,
  TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";

interface FloatingOverlayOptions extends OverlayOptions {
  row: number;
  col: number;
  width: number;
  nonCapturing: true;
}

/**
 * Public pi-tui surface used by the panel. `captureRenderState` belongs to
 * TuiMainScreen (not the common TUI interface), so it remains optional for
 * fullscreen renderers and structural test doubles.
 */
export interface FloatingTui {
  mode?: TUI["mode"];
  terminal?: Pick<TUI["terminal"], "rows" | "columns">;
  children?: unknown[];
  showOverlay?: TUI["showOverlay"];
  captureRenderState?: () => Pick<TuiMainScreenRenderState, "cursorRow">;
}

/**
 * Single seam for "where is the editor in the TUI": searches the root
 * children (and one nesting level, e.g. editorContainer). Placement math and
 * the panel's liveness check share this so their verdicts cannot diverge. An
 * overlay-hosted editor is deliberately unsupported: it cannot be positioned
 * from the public root layout. If Pi hosts the editor elsewhere, only this
 * function needs to learn the new location.
 */
export function locateEditor(
  tui: FloatingTui | undefined,
  editor: unknown,
): { childIndex: number } | null {
  const children = tui?.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as { children?: unknown[] };
      if (child === editor || (Array.isArray(child.children) && child.children.includes(editor))) {
        return { childIndex: i };
      }
    }
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

  const children = tui?.children as { render?(width: number): string[] }[];
  let suffixHeight = 0;
  for (let i = location.childIndex + 1; i < children.length; i++) {
    const sibling = children[i];
    if (typeof sibling.render !== "function") return null;
    suffixHeight += sibling.render(termWidth).length;
  }

  // Fullscreen always has a bottom dock. On the regular main screen, use its
  // public render-state snapshot: shorter content is top-aligned, while a
  // cursor at the last row means the editor is anchored to the viewport foot.
  const cursorRow = tui?.captureRenderState?.().cursorRow;
  const bottomAnchored =
    tui?.mode === "fullscreen" || (typeof cursorRow === "number" && cursorRow + 1 >= termHeight);
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
  const termHeight = tui?.terminal?.rows;
  if (!layout || !termHeight) return null;
  return computeRowFromLayout(layout, termHeight, editorHeight, panelHeight);
}

function computeRowFromLayout(
  layout: PanelLayout,
  termHeight: number,
  editorHeight: number,
  panelHeight: number,
): number | null {
  if (!layout.bottomAnchored) return null;
  const row = termHeight - layout.suffixHeight - editorHeight - panelHeight;
  return row >= 0 ? row : null;
}

/** Overlay component that replays the panel lines and self-heals. */
class PanelComponent implements Component {
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
 * The overlay entry is toggled via the public OverlayHandle API while its
 * geometry is stable, and re-mounted through showOverlay when geometry
 * changes. dispose() (or self-healing) removes the entry for good.
 */
export class EditorFloatPanel {
  private readonly component = new PanelComponent();
  private handle: OverlayHandle | undefined;
  private options: FloatingOverlayOptions | undefined;
  private layoutCache: { termHeight: number; termWidth: number; layout: PanelLayout } | undefined;
  private readonly tui: FloatingTui | undefined;
  private readonly anchor: unknown;

  // Explicit assignment (not parameter properties) keeps this file loadable
  // under node's strip-only TypeScript mode used by sibling extensions.
  constructor(tui: FloatingTui | undefined, anchor: unknown) {
    this.tui = tui;
    this.anchor = anchor;
  }

  get visible(): boolean {
    return this.handle !== undefined && !this.handle.isHidden();
  }

  show(lines: string[], opts: EditorFloatPanelShowOptions): boolean {
    const tui = this.tui;
    let row: number | null = null;
    try {
      const termHeight = tui?.terminal?.rows;
      const layout = this.getLayout();
      row = termHeight
        ? computeRowFromLayout(layout, termHeight, opts.editorHeight, lines.length)
        : null;
    } catch {
      row = null;
    }
    if (row === null || !tui || typeof tui.showOverlay !== "function") {
      this.conceal();
      return false;
    }

    this.component.setLines(lines);
    const nextOptions: FloatingOverlayOptions = {
      row,
      col: opts.col,
      width: opts.width,
      nonCapturing: true,
    };
    if (this.handle && this.options && hasSameGeometry(this.options, nextOptions)) {
      this.handle.setHidden(false);
    } else {
      // OverlayOptions has no public mutation API. Re-mount only when geometry
      // changes instead of relying on pi-tui retaining this object by reference.
      this.handle?.hide();
      this.component.isAlive = () => locateEditor(this.tui, this.anchor) !== null;
      // Self-healing removes the entry permanently: a dead anchor never
      // comes back, so the orphaned overlay must not linger in the stack.
      this.component.onDead = () => this.dispose();
      this.options = nextOptions;
      this.handle = tui.showOverlay(this.component, this.options);
    }
    return true;
  }

  /** Conceal the panel, keeping the overlay entry mounted for reuse. */
  hide(): void {
    this.layoutCache = undefined;
    this.conceal();
  }

  private conceal(): void {
    if (!this.handle) return;
    // Hidden entries are skipped by the compositor, so render()-based
    // self-healing cannot fire while concealed. If the anchor is already
    // gone, remove the entry now instead of leaving it in the stack.
    if (locateEditor(this.tui, this.anchor) === null) {
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
      this.layoutCache = undefined;
    }
  }

  /**
   * `captureRenderState()` copies main-screen history. Cache its result while
   * one panel is open; terminal resize or hide/dispose invalidates the cache.
   */
  private getLayout(): PanelLayout {
    const termHeight = this.tui?.terminal?.rows;
    const termWidth = this.tui?.terminal?.columns;
    if (!termHeight || !termWidth) return { suffixHeight: 0, bottomAnchored: false };
    if (
      this.layoutCache?.termHeight === termHeight &&
      this.layoutCache.termWidth === termWidth &&
      locateEditor(this.tui, this.anchor) !== null
    ) {
      return this.layoutCache.layout;
    }

    const layout = resolveLayout(this.tui, this.anchor);
    if (!layout) return { suffixHeight: 0, bottomAnchored: false };
    this.layoutCache = { termHeight, termWidth, layout };
    return layout;
  }
}

function hasSameGeometry(left: FloatingOverlayOptions, right: FloatingOverlayOptions): boolean {
  return left.row === right.row && left.col === right.col && left.width === right.width;
}
