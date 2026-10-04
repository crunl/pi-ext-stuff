/**
 * Box-chrome editor — decorates an editor with a rounded box whose
 * top border carries the permissions-mode badge:
 *
 *   ╭──Auto──────────────────────────╮
 *   │ user input here…               │
 *   ╰────────────────────────────────╯
 *
 * The footer owns model/effort display as powerline segments; the
 * bottom border stays a plain rule.
 *
 * The badge keeps the powerline half-circle pill, sitting in the top
 * border after the box corner. Mode color: warning (yellow — "attention,
 * not alarm") for Auto, error (red — alarm) for YOLO. Falls back to
 * inverse video without truecolor theme data.
 *
 * Renders the upstream Editor at width-2, splices the badge into the
 * inner top border, then wraps with boxEditorLines. Scroll-indicator
 * borders ("─── ↓ 2 more ──") count as borders, so a scrolled editor
 * still closes its box. Narrow widths fall back to the unboxed layout.
 *
 * Pattern follows examples/extensions/modal-editor.ts: subclass
 * CustomEditor, post-process super.render() output.
 */

import { makeModeBadgeDecorator } from "../../../../packages/shared-tool-presentation/src/badge.ts";
import { buildTopBorder } from "./border-labels.ts";
import { BOX_MIN_WIDTH, boxEditorLines, isHorizontalBorder } from "./box-editor.ts";

export type PermissionsModeProvider = () =>
  | { label: string; severity: "warning" | "error" }
  | undefined;

export interface BoxChromeProviders {
  getPermissionsMode?: PermissionsModeProvider;
  getBadgeFgAnsi?: (color: "warning" | "error") => string | undefined;
  isEnabled?: () => boolean;
}

export interface BorderColorable {
  borderColor?(text: string): string;
}

export interface RenderableEditor {
  render(width: number): string[];
}

const BOX_CHROME_APPLIED = Symbol.for("@x1a2h1/pi-core:box-chrome-applied");

/**
 * Decorates an existing editor instance in-place with box chrome.
 *
 * Wraps editor.render() rather than replacing the editor class,
 * preserving any other decorations applied by earlier extensions.
 */
export function applyBoxChrome<T extends RenderableEditor>(
  editor: T,
  providers: BoxChromeProviders = {},
): T {
  if ((editor as Record<symbol, unknown>)[BOX_CHROME_APPLIED]) {
    return editor;
  }
  (editor as Record<symbol, unknown>)[BOX_CHROME_APPLIED] = true;

  const originalRender = editor.render.bind(editor);
  const {
    getPermissionsMode = () => undefined,
    getBadgeFgAnsi = () => undefined,
    isEnabled = () => true,
  } = providers;

  editor.render = (width: number): string[] => {
    if (!isEnabled()) {
      return originalRender(width);
    }

    const boxed = width >= BOX_MIN_WIDTH;
    const innerWidth = boxed ? width - 2 : width;
    const lines = originalRender(innerWidth);
    if (lines.length === 0) return lines;

    const colorizeBorder = (text: string): string => {
      const borderFn = (editor as BorderColorable).borderColor;
      return typeof borderFn === "function" ? borderFn.call(editor, text) : text;
    };

    // Locate border lines (including scroll indicators).
    let topIdx = -1;
    let bottomIdx = -1;
    for (const [i, line] of lines.entries()) {
      if (isHorizontalBorder(line)) {
        if (topIdx === -1) topIdx = i;
        bottomIdx = i;
      }
    }

    // Top border: permissions-mode badge on the left.
    if (topIdx !== -1) {
      const mode = getPermissionsMode();
      const top = buildTopBorder(innerWidth, mode?.label);
      if (top !== undefined) {
        const decorate = makeModeBadgeDecorator(mode ? getBadgeFgAnsi(mode.severity) : undefined);
        const badge = top.mode.length > 0 ? decorate(top.mode) : "";
        lines[topIdx] = colorizeBorder(top.pre) + badge + colorizeBorder(top.post);
      }
    }

    if (!boxed) return lines;
    if (topIdx === -1 || bottomIdx === -1) return lines;

    return boxEditorLines(lines, innerWidth, colorizeBorder, {
      topIdx,
      bottomIdx,
    });
  };

  return editor;
}

export type CustomEditorLike = RenderableEditor & BorderColorable;
