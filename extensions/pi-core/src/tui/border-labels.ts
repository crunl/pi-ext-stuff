/**
 * Pure border-label builders for the box-chrome editor.
 *
 * Imports only the side-effect-free badge constants (deep path, not
 * the package index) so this module stays free of pi package imports.
 */
import { BADGE_CAP_WIDTH } from "../../../../packages/shared-tool-presentation/src/badge.ts";
import { stripAnsi } from "./format-primitives.ts";

/**
 * Visible column count for our label alphabet (ASCII, box-drawing, Nerd
 * Font PUA). Counts Unicode code points — not UTF-16 units, so astral-plane
 * icons (surrogate pairs) are not overcounted.
 */
function displayLength(s: string): number {
  return [...stripAnsi(s)].length;
}

export interface TopBorderSegments {
  /** Border run before the badge ("──"); empty when there is no label. */
  pre: string;
  /**
   * Badge text ("Approve for me" / "Bypass permissions"), plain — caller
   * decorates. Empty when there is no label.
   */
  label: string;
  /** Border run after the badge. */
  post: string;
}

/**
 * Top border: mode badge on the left, plain remainder on the right.
 * `label` is display copy: the mode itself is `auto`/`yolo`, and only this
 * badge renders the display form. The caller decorates it with the two
 * powerline caps, so the returned segments are sized against the label
 * width + BADGE_CAP_WIDTH.
 * Returns undefined when there is no label or nothing fits.
 */
export function buildTopBorder(
  width: number,
  label: string | undefined,
): TopBorderSegments | undefined {
  const badgeText = label ?? "";
  const labelWidth = badgeText.length > 0 ? displayLength(badgeText) + BADGE_CAP_WIDTH : 0;
  const pre = labelWidth > 0 ? "──" : "";
  const leftWidth = pre.length + labelWidth;
  if (leftWidth === 0) return undefined;
  if (leftWidth > width) return undefined;
  return { pre, label: badgeText, post: "─".repeat(width - leftWidth) };
}
