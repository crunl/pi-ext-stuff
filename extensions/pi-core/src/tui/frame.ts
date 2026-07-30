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
