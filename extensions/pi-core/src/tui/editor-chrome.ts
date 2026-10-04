/**
 * Editor chrome installation — owns the editor's rounded box and the
 * permissions-mode badge, plus the autocomplete-above panel, in a single
 * editor factory (box inner, autocomplete outer).
 *
 * The badge text and visibility come from pi-safety's structured
 * "pi-safety:mode" bus event: `severity` drives visibility and color,
 * `label` is display copy emitted atomically with the publisher's
 * setStatus call. The footer's generic status text does not drive the
 * badge.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isPermissionsModeEvent,
  type ModeSeverity,
  PermissionsModeState,
} from "../../../../packages/shared-tool-presentation/src/permissions-mode.ts";
import { applyAutocompleteAbove } from "./autocomplete-above.ts";
import { applyBoxChrome } from "./model-editor.ts";
import { isInteractiveTui } from "./ui-guard.ts";

/**
 * Install the boxed editor chrome. Composes with an editor factory set
 * by an earlier extension; later extensions compose with ours the same
 * way (the marker prevents double-wrapping across session restarts).
 */
export function registerEditorChrome(pi: ExtensionAPI): void {
  const permissionsMode = new PermissionsModeState();
  let requestRender: (() => void) | undefined;

  pi.events.on("pi-safety:mode", (data) => {
    if (!isPermissionsModeEvent(data)) return;
    // State changes only; the publisher's setStatus already covers the
    // footer line, this repaint is for the editor badge.
    if (permissionsMode.applyEvent(data)) requestRender?.();
  });

  pi.on("session_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    const previous = ctx.ui.getEditorComponent();
    // The host resets the editor factory before re-emitting session_start,
    // but guard anyway: never wrap our own factory (would grow the closure
    // chain across resumes/forks if that reset ever changes).
    if ((previous as { __editorChrome?: boolean } | undefined)?.__editorChrome) {
      return;
    }

    // Full Theme (with getFgAnsi) comes from the context — the
    // factory's `theme` param is pi-tui's EditorTheme subset and
    // has no color accessors.
    const theme = ctx.ui.theme as unknown as {
      getFgAnsi(color: string): string | undefined;
    };

    const factory = (
      tui: Parameters<NonNullable<typeof previous>>[0],
      editorTheme: Parameters<NonNullable<typeof previous>>[1],
      keybindings: Parameters<NonNullable<typeof previous>>[2],
    ) => {
      // Coalesce burst mode events into one repaint.
      let renderQueued = false;
      requestRender = () => {
        if (renderQueued) return;
        renderQueued = true;
        queueMicrotask(() => {
          renderQueued = false;
          tui.requestRender();
        });
      };
      const editor = previous
        ? previous(tui, editorTheme, keybindings)
        : new CustomEditor(tui, editorTheme, keybindings);
      const withBox = applyBoxChrome(editor, {
        getPermissionsMode: () => {
          const severity = permissionsMode.severity();
          const label = permissionsMode.get();
          if (severity === "none" || label === undefined) return undefined;
          return { label, severity: severity as Exclude<ModeSeverity, "none"> };
        },
        getBadgeFgAnsi: (color) => {
          try {
            return theme?.getFgAnsi(color);
          } catch {
            return undefined;
          }
        },
      });
      // Autocomplete renders over the final boxed width, so the panel
      // aligns with the box instead of the inner content.
      return applyAutocompleteAbove(withBox, tui);
    };
    (factory as { __editorChrome?: boolean }).__editorChrome = true;
    ctx.ui.setEditorComponent(factory);
  });
}
