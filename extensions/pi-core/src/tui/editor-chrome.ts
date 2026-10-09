/**
 * Editor chrome — the rounded box + permissions-mode badge on the editor's
 * top border, implemented as an official `CustomEditor` subclass installed
 * through `ctx.ui.setEditorComponent` (the host's own example pattern,
 * examples/extensions/border-status-editor.ts). No prototype patching:
 * `render()` post-processes `super.render()` output. The host wires
 * borderColor/paddingX/callbacks/action handlers into the subclass instance
 * itself (interactive-mode.js setCustomEditorComponent).
 *
 * The badge text and visibility come from pi-safety's structured
 * "pi-safety:mode" bus event: `severity` drives visibility and color,
 * `label` is display copy emitted atomically with the publisher's
 * setStatus call. The footer's generic status text does not drive the
 * badge.
 *
 * Factory semantics: replacement, matching the host's last-write-wins
 * setEditorComponent. The host resets the editor factory before re-emitting
 * session_start (resetExtensionUI), so no cross-session chain accumulates;
 * a later extension that sets its own factory simply wins, as with any
 * other consumer of this API.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { makeModeBadgeDecorator } from "../../../../packages/shared-tool-presentation/src/badge.ts";
import {
  isPermissionsModeEvent,
  type ModeSeverity,
  PermissionsModeState,
} from "../../../../packages/shared-tool-presentation/src/permissions-mode.ts";
import { buildTopBorder } from "./border-labels.ts";
import { BOX_MIN_WIDTH, boxEditorLines, isHorizontalBorder } from "./box-editor.ts";
import { isInteractiveTui } from "./ui-guard.ts";

export type PermissionsModeProvider = () =>
  | { label: string; severity: "warning" | "error" }
  | undefined;

export type BadgeFgProvider = (color: "warning" | "error") => string | undefined;

/**
 * Pure chrome orchestration over already-rendered editor lines: locate the
 * top/bottom borders (including scroll-indicator rows), splice the mode badge
 * into the top border, then wrap in a rounded box when `boxed`. Extracted from
 * the editor so it is testable under bare node without constructing an Editor.
 * Mutates nothing; returns new lines.
 */
export function chromeEditorLines(
  lines: readonly string[],
  innerWidth: number,
  boxed: boolean,
  mode: { label: string; severity: "warning" | "error" } | undefined,
  borderColor: (text: string) => string,
  getBadgeFgAnsi: BadgeFgProvider,
): string[] {
  if (lines.length === 0) return [...lines];
  const out = [...lines];

  // Locate border lines (including scroll indicators) BEFORE splicing: once
  // the badge is in, the top row is no longer a pure ─ run and
  // auto-detection would miss it.
  let topIdx = -1;
  let bottomIdx = -1;
  for (const [i, line] of out.entries()) {
    if (isHorizontalBorder(line)) {
      if (topIdx === -1) topIdx = i;
      bottomIdx = i;
    }
  }

  if (topIdx !== -1) {
    const top = buildTopBorder(innerWidth, mode?.label);
    if (top !== undefined) {
      const decorate = makeModeBadgeDecorator(mode ? getBadgeFgAnsi(mode.severity) : undefined);
      const badge = top.mode.length > 0 ? decorate(top.mode) : "";
      out[topIdx] = borderColor(top.pre) + badge + borderColor(top.post);
    }
  }

  if (!boxed || topIdx === -1 || bottomIdx === -1) return out;
  return boxEditorLines(out, innerWidth, borderColor, { topIdx, bottomIdx });
}

/**
 * CustomEditor subclass drawing the rounded box and splicing the
 * permissions-mode badge into the top border:
 *
 *   ╭──Auto──────────────────────────╮
 *   │ user input here…               │
 *   ╰────────────────────────────────╯
 *
 * Mode color: warning (yellow — "attention, not alarm") for Auto, error
 * (red — alarm) for YOLO. Falls back to inverse video without truecolor
 * theme data. Scroll-indicator borders ("─── ↓ 2 more ──") count as
 * borders, so a scrolled editor still closes its box. Narrow widths fall
 * back to the unboxed layout (badge only when it fits). Autocomplete rows
 * sit after the bottom border and stay unboxed.
 */
export class ModeBadgeEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly getPermissionsMode: PermissionsModeProvider,
    private readonly getBadgeFgAnsi: BadgeFgProvider,
  ) {
    super(tui, theme, keybindings);
  }

  render(width: number): string[] {
    const boxed = width >= BOX_MIN_WIDTH;
    const innerWidth = boxed ? width - 2 : width;
    const lines = super.render(innerWidth);
    return chromeEditorLines(
      lines,
      innerWidth,
      boxed,
      this.getPermissionsMode(),
      (text) => this.borderColor(text),
      this.getBadgeFgAnsi,
    );
  }
}

/**
 * Install the boxed editor chrome. Subscribes the badge to pi-safety's mode
 * bus once per registration and (re)installs the editor factory on every
 * session_start, so /resume and forks get a fresh subclass instance bound
 * to the live TUI.
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

    // Full Theme (with getFgAnsi) comes from the context — the factory's
    // `theme` param is pi-tui's EditorTheme subset and has no color
    // accessors.
    const theme = ctx.ui.theme as unknown as {
      getFgAnsi(color: string): string | undefined;
    };

    ctx.ui.setEditorComponent(
      (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
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
        return new ModeBadgeEditor(
          tui,
          editorTheme,
          keybindings,
          () => {
            const severity = permissionsMode.severity();
            const label = permissionsMode.get();
            if (severity === "none" || label === undefined) return undefined;
            return { label, severity: severity as Exclude<ModeSeverity, "none"> };
          },
          (color) => {
            try {
              return theme?.getFgAnsi(color);
            } catch {
              return undefined;
            }
          },
        );
      },
    );
  });
}
