import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { EditorFloatPanel, type FloatingTui } from "./editor-float-panel.ts";
import { FRAME_OVERHEAD, frameLines } from "./frame.ts";
import { installSelectorFloat } from "./selector-float.ts";
import { setSelectorNavAnchor } from "./selector-tab-nav.ts";
import { isInteractiveTui } from "./ui-guard.ts";

/** Mirror of pi-tui AutocompleteItem (official contract). */
interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

interface EditorInternals {
  autocompleteList?: {
    render(width: number): string[];
    handleInput?(data: string): void;
    getSelectedItem?(): CompletionItem | null;
  };
  /** Public on pi-tui Editor >= 0.84.1. */
  isShowingAutocomplete?(): boolean;
  /** Public on pi-tui Editor; kept dynamic by the host (thinking/bash mode). */
  borderColor?: (text: string) => string;
  __autocompleteAbove?: boolean;
}

interface PatchableEditor {
  render(width: number): string[];
  handleInput?(data: string): void;
  getPaddingX?(): number;
}

function isAutocompleteOpen(editor: EditorInternals): boolean {
  return typeof editor.isShowingAutocomplete === "function"
    ? editor.isShowingAutocomplete()
    : editor.autocompleteList !== undefined;
}

/**
 * Panel owned by the previously patched editor. Pi gives each extension its
 * own jiti module cache, so keep it on a shared symbol: statusline replacing
 * pi-core's editor must still be able to dispose the previous hidden overlay.
 */
const ACTIVE_PANEL_KEY = Symbol.for("@x1a2h1/pi-core:autocomplete-active-panel");

function getActivePanel(): EditorFloatPanel | undefined {
  return (globalThis as Record<symbol, EditorFloatPanel | undefined>)[ACTIVE_PANEL_KEY];
}

function setActivePanel(panel: EditorFloatPanel | undefined): void {
  (globalThis as Record<symbol, EditorFloatPanel | undefined>)[ACTIVE_PANEL_KEY] = panel;
}

/**
 * Patch an editor instance so its autocomplete panel appears ABOVE the input
 * box. When the surrounding TUI allows it, the panel floats via
 * EditorFloatPanel (no layout shift); otherwise it degrades to inline lines
 * prepended above the editor. Also remaps tab/shift+tab to panel navigation
 * while the panel is open. Idempotent.
 *
 * Pass the TUI from the editor factory to enable zero-shift floating. When it
 * is omitted, placement safely degrades to inline rendering.
 */
export function applyAutocompleteAbove<T extends PatchableEditor>(editor: T, tui?: FloatingTui): T {
  const internals = editor as unknown as EditorInternals;
  const resolveTui = () => tui;
  setSelectorNavAnchor(resolveTui, editor);
  getActivePanel()?.dispose();
  setActivePanel(undefined);
  if (internals.__autocompleteAbove) return editor;
  internals.__autocompleteAbove = true;

  const originalRender = editor.render.bind(editor);
  const patched = editor as PatchableEditor;
  let panel: EditorFloatPanel | undefined;
  let selectorFloatInstalled = false;

  patched.render = (width: number): string[] => {
    // Install the selector-float container patch once the editor is mounted
    // (the editorContainer can only be located while the editor sits in it).
    if (!selectorFloatInstalled) {
      selectorFloatInstalled = installSelectorFloat(
        resolveTui(),
        editor,
        () => internals.borderColor ?? ((text: string) => text),
      );
    }

    const list = internals.autocompleteList;
    if (!isAutocompleteOpen(internals) || !list) {
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
    }
    setActivePanel(panel);
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
  //
  // Enter completes the selected item into the input box and stops there
  // (never submits). This reuses the upstream editor's own tab branch: it
  // applies the official AutocompleteProvider.applyCompletion for any
  // prefix, writes state, closes the panel and returns. Upstream only
  // submits on tui.select.confirm, where "/" prefixes deliberately fall
  // through to submit — forwarding a synthetic tab sidesteps that path
  // entirely, giving uniform complete-without-sending. When nothing is
  // selected the guard falls through to the raw Enter (the upstream tab
  // branch would otherwise swallow it).
  const SELECT_UP = "\x1b[A";
  const SELECT_DOWN = "\x1b[B";
  const originalHandleInput = editor.handleInput?.bind(editor);
  patched.handleInput = (data: string): void => {
    const list = internals.autocompleteList;
    if (isAutocompleteOpen(internals) && list && typeof list.handleInput === "function") {
      if (matchesKey(data, "tab")) {
        list.handleInput(SELECT_DOWN);
        return;
      }
      if (matchesKey(data, "shift+tab")) {
        list.handleInput(SELECT_UP);
        return;
      }
      if (matchesKey(data, "enter") && list.getSelectedItem?.()) {
        originalHandleInput?.("\t");
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
    if (!isInteractiveTui(ctx)) return;
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
        ? applyAutocompleteAbove(previous(tui, theme, keybindings), tui)
        : applyAutocompleteAbove(new CustomEditor(tui, theme, keybindings), tui);
    (factory as { __autocompleteAbove?: boolean }).__autocompleteAbove = true;
    ctx.ui.setEditorComponent(factory);
  });
}
