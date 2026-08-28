import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * frame - shared rounded-frame decoration for floating panels.
 *
 * The frame is open at the bottom: panels float directly above the editor,
 * whose own top border visually closes the frame:
 *
 *   ╭──────────────╮
 *   │ content      │
 *   ────────────────  <- editor top border
 */

/** Horizontal columns consumed by the frame: "│ " left + " │" right. */
export const FRAME_OVERHEAD = 4;

/** Pad one line with spaces to exactly `width` visible columns (ANSI-aware). */
export function padLineToWidth(line: string, width: number): string {
  const fill = Math.max(0, width - visibleWidth(line));
  return fill > 0 ? `${line}${" ".repeat(fill)}` : line;
}

/** Pad every line to exactly `width` visible columns. */
export function padToWidth(lines: string[], width: number): string[] {
  return lines.map((line) => padLineToWidth(line, width));
}

/**
 * Wrap panel lines with a rounded top border and left/right verticals.
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
