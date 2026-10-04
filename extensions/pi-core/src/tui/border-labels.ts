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
  /** Border run before the badge ("──"); empty when no mode. */
  pre: string;
  /** Badge text ("Auto"), plain — caller decorates. Empty when no mode. */
  mode: string;
  /** Border run after the badge. */
  post: string;
}

/**
 * Top border: mode badge on the left, plain remainder on the right.
 * `mode` is decorated by the caller with the two powerline caps, so the
 * returned segments are sized against the label width + BADGE_CAP_WIDTH.
 * Returns undefined when there is no mode or nothing fits.
 */
export function buildTopBorder(
  width: number,
  mode: string | undefined,
): TopBorderSegments | undefined {
  const label = mode ?? "";
  const labelWidth = label.length > 0 ? displayLength(label) + BADGE_CAP_WIDTH : 0;
  const pre = labelWidth > 0 ? "──" : "";
  const leftWidth = pre.length + labelWidth;
  if (leftWidth === 0) return undefined;
  if (leftWidth > width) return undefined;
  return { pre, mode: label, post: "─".repeat(width - leftWidth) };
}
