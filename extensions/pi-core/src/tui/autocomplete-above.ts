import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { EditorFloatPanel, type FloatingTui } from "./editor-float-panel.ts";
import { setSelectorNavAnchor } from "./selector-tab-nav.ts";

interface EditorInternals {
  autocompleteList?: { render(width: number): string[]; handleInput?(data: string): void };
  autocompleteState?: unknown;
  /** Fallback only: used when the caller cannot pass the factory's tui. */
  tui?: FloatingTui;
  /** Public on pi-tui Editor; kept dynamic by the host (thinking/bash mode). */
  borderColor?: (text: string) => string;
  __autocompleteAbove?: boolean;
}

interface PatchableEditor {
  render(width: number): string[];
  handleInput?(data: string): void;
  getPaddingX?(): number;
}

/** Horizontal columns consumed by the frame: "│ " left + " │" right. */
const FRAME_OVERHEAD = 4;

/**
 * Panel owned by the previously patched editor. Disposed when a new editor
 * is patched: a swapped-out editor's concealed panel can no longer self-heal
 * (hidden overlays are skipped by the compositor, so its render() never
 * runs), and would otherwise leak one overlay entry per editor swap.
 */
let activePanel: EditorFloatPanel | undefined;

/**
 * Wrap panel lines with a rounded top border and left/right verticals. The
 * editor's own top border below the panel closes the frame visually:
 *
 *   ╭──────────╮
 *   │ → item   │
 *   ────────────  <- editor top border
 *
 * Lines must already be padded to frameWidth - FRAME_OVERHEAD.
 */
export function frameLines(
  lines: string[],
  frameWidth: number,
  color: (text: string) => string,
): string[] {
  const innerWidth = Math.max(1, frameWidth - FRAME_OVERHEAD);
  const top = color(`╭${"─".repeat(innerWidth + 2)}╮`);
  const left = color("│ ");
  const right = color(" │");
  return [top, ...lines.map((line) => `${left}${line}${right}`)];
}

/**
 * Patch an editor instance so its autocomplete panel appears ABOVE the input
 * box. When the surrounding TUI allows it, the panel floats via
 * EditorFloatPanel (no layout shift); otherwise it degrades to inline lines
 * prepended above the editor. Also remaps tab/shift+tab to panel navigation
 * while the panel is open. Idempotent.
 *
 * Pass the TUI from the editor factory when available (official parameter);
 * reading the editor's private tui field is only a fallback for callers
 * that do not have it.
 */
export function applyAutocompleteAbove<T extends PatchableEditor>(editor: T, tui?: FloatingTui): T {
  const internals = editor as unknown as EditorInternals;
  // Resolve lazily: the private-field fallback may be assigned after patching.
  const resolveTui = () => tui ?? internals.tui;
  setSelectorNavAnchor(resolveTui, editor);
  activePanel?.dispose();
  activePanel = undefined;
  if (internals.__autocompleteAbove) return editor;
  internals.__autocompleteAbove = true;

  const originalRender = editor.render.bind(editor);
  const patched = editor as PatchableEditor;
  let panel: EditorFloatPanel | undefined;

  patched.render = (width: number): string[] => {
    const list = internals.autocompleteList;
    if (!internals.autocompleteState || !list) {
      panel?.hide();
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
    // Render the list narrower so the frame fits within contentWidth, then
    // pad each line to the frame's inner width before framing.
    const innerWidth = Math.max(1, contentWidth - FRAME_OVERHEAD);
    const rawLines = list.render(innerWidth).map((line) => {
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      return `${line}${fill}`;
    });
    const borderColor = internals.borderColor ?? ((text: string) => text);
    const listLines = frameLines(rawLines, contentWidth, borderColor);

    // Floating mode: zero layout shift. Lazily create the panel so the
    // anchor is this editor instance.
    if (!panel) {
      panel = new EditorFloatPanel(resolveTui(), editor);
      activePanel = panel;
    }
    const floated = panel.show(listLines, {
      editorHeight: editorLines.length,
      col: paddingX,
      width: contentWidth,
    });
    if (floated) return editorLines;

    // Inline fallback: prepend the panel lines above the editor box.
    const pad = " ".repeat(paddingX);
    return [...listLines.map((line) => `${pad}${line}${pad}`), ...editorLines];
  };

  // Tab / shift+tab navigate the open panel instead of their default
  // meanings (tab = apply completion, shift+tab = extension shortcut such
  // as the pi-permissions mode cycle). This wrapper runs before
  // CustomEditor.handleInput, so it wins while the panel is open and is
  // fully transparent when it is closed. Navigation is forwarded to the
  // SelectList as arrow-key sequences (its own up/down bindings, with
  // wrap-around).
  const SELECT_UP = "\x1b[A";
  const SELECT_DOWN = "\x1b[B";
  const originalHandleInput = editor.handleInput?.bind(editor);
  patched.handleInput = (data: string): void => {
    const list = internals.autocompleteList;
    if (internals.autocompleteState && list && typeof list.handleInput === "function") {
      if (matchesKey(data, "tab")) {
        list.handleInput(SELECT_DOWN);
        return;
      }
      if (matchesKey(data, "shift+tab")) {
        list.handleInput(SELECT_UP);
        return;
      }
    }
    originalHandleInput?.(data);
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
        ? applyAutocompleteAbove(previous(tui, theme, keybindings), tui as unknown as FloatingTui)
        : applyAutocompleteAbove(
            new CustomEditor(tui, theme, keybindings),
            tui as unknown as FloatingTui,
          );
    (factory as { __autocompleteAbove?: boolean }).__autocompleteAbove = true;
    ctx.ui.setEditorComponent(factory);
  });
}
