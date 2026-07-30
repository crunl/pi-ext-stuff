/**
 * selector-tab-nav - tab / shift+tab navigation for pi's built-in selector
 * panels (/model, /resume, /settings, /theme, ...).
 *
 * The host swaps the editor out of its container and puts a selector
 * component in its place (showSelector). While that is the case, a raw
 * terminal input listener rewrites tab -> down and shift+tab -> up, which
 * the selectors already handle (tui.select.down/up, with wrap-around).
 * Enter confirms natively.
 *
 * Trade-off (accepted): the model and session selectors previously used
 * tab to toggle their scope (scoped/all models, cwd/all sessions). That
 * shortcut is sacrificed for consistent tab navigation; scope narrowing
 * remains available through typing the search filter.
 *
 * The rewrite is scoped tightly: it only fires when a selector occupies
 * the editor slot. The editor's own autocomplete panel keeps its editor-
 * level tab handling (the editor stays in place in that case, so this
 * listener stays out of the way).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type FloatingTui, locateEditor } from "./editor-float-panel.ts";

const SELECT_UP = "\x1b[A";
const SELECT_DOWN = "\x1b[B";

/**
 * Cross-extension shared anchor. pi loads each extension through its own
 * jiti instance with `moduleCache: false`, so a plain module-level `let` is
 * NOT shared: statusline's import of this file and pi-core's
 * `registerSelectorTabNav` each get their own copy. The listener is bound to
 * pi-core's copy; the live editor is usually patched from statusline's copy
 * (it replaces the factory rather than wrapping). The listener then saw a
 * stale/empty anchor, `isSelectorOpen()` stuck true, and shift+tab was always
 * rewritten to ↑ — killing pi-permissions mode cycling in the normal editor.
 *
 * Same pattern pi uses for its theme singleton. Last writer wins: whoever
 * last called applyAutocompleteAbove holds the mounted editor.
 */
const ANCHOR_KEY = Symbol.for("@x1a2h1/pi-core:selector-tab-nav-anchor");

interface Anchor {
  resolveTui: () => FloatingTui | undefined;
  editor: unknown;
}

function getAnchor(): Anchor | undefined {
  return (globalThis as Record<symbol, Anchor | undefined>)[ANCHOR_KEY];
}

function setAnchor(next: Anchor | undefined): void {
  (globalThis as Record<symbol, Anchor | undefined>)[ANCHOR_KEY] = next;
}

/**
 * Remember the active editor instance and how to reach its TUI. Called by
 * applyAutocompleteAbove whenever an editor is (re)patched, so the input
 * rewrite can tell "selector open" (editor swapped out) from normal
 * editing. Stored on globalThis so every jiti copy of this module sees the
 * same (most-recently-mounted) editor. The tui is resolved lazily; a plain
 * value is also accepted.
 */
export function setSelectorNavAnchor(
  tui: FloatingTui | undefined | (() => FloatingTui | undefined),
  editor: unknown,
): void {
  if (tui === undefined && editor === undefined) {
    setAnchor(undefined);
    return;
  }
  const resolveTui = typeof tui === "function" ? tui : () => tui;
  setAnchor({ resolveTui, editor });
}

/** True while a selector (not the editor) occupies the editor slot. */
export function isSelectorOpen(): boolean {
  const anchor = getAnchor();
  if (!anchor) return false;
  const tui = anchor.resolveTui();
  if (!tui) return false;
  return locateEditor(tui, anchor.editor) === null;
}

/**
 * Rewrite tab/shift+tab to down/up while a selector is open. Returns the
 * onTerminalInput handler result contract: undefined = pass through.
 */
export function rewriteSelectorNavInput(data: string): { data: string } | undefined {
  if (!isSelectorOpen()) return undefined;
  if (matchesKey(data, "tab")) return { data: SELECT_DOWN };
  if (matchesKey(data, "shift+tab")) return { data: SELECT_UP };
  return undefined;
}

/**
 * Install the raw-input rewrite. Registered once per session_start;
 * onTerminalInput runs before focused-component dispatch and extension
 * shortcuts, so shift+tab also stops cycling the pi-permissions mode
 * while a selector is open.
 */
export function registerSelectorTabNav(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.onTerminalInput(rewriteSelectorNavInput);
  });
}
