/**
 * Box editor chrome: rounded corners + one-column vertical rails.
 *
 * Input lines are already laid out to `innerWidth` by the upstream Editor
 * (top border, content, bottom border, optional autocomplete). This wraps
 * them into a full box of width innerWidth+2:
 *
 *   ╭─…─╮
 *   │ … │
 *   ╰─…─╯
 *
 * Autocomplete rows sit after the bottom border and are left unboxed so
 * the dropdown does not inherit editor chrome.
 *
 * Must not import pi packages (tests run under bare node).
 */
import { stripAnsi } from "./format.ts";

export const BOX_MIN_WIDTH = 24;

/**
 * True for editor chrome lines: pure `─` runs, or scroll borders like
 * `─── ↑ 3 more ───`. Content never consists solely of those characters.
 */
function isHorizontalBorder(line: string): boolean {
	const plain = stripAnsi(line);
	if (plain.length === 0 || !plain.includes("─")) return false;
	return plain.replace(/[─\s↑↓0-9]/g, "").replace(/more/g, "") === "";
}

/**
 * Wrap editor lines in a box. `innerWidth` is the width the lines were
 * rendered at; result lines have visible width innerWidth+2.
 * `chrome` colors the corner/rail glyphs (defaults to identity).
 *
 * Pass `known` when the caller has already located the borders — required
 * once labels have been spliced in, because those lines are no longer
 * pure `─` runs and auto-detection would miss them.
 */
export function boxEditorLines(
	lines: readonly string[],
	innerWidth: number,
	chrome: (s: string) => string = (s) => s,
	known?: { topIdx: number; bottomIdx: number },
): string[] {
	if (lines.length === 0 || innerWidth <= 0) return [...lines];

	let topIdx = -1;
	let bottomIdx = -1;
	if (known) {
		topIdx = known.topIdx;
		bottomIdx = known.bottomIdx;
	} else {
		for (let i = 0; i < lines.length; i++) {
			if (isHorizontalBorder(lines[i]!)) {
				if (topIdx === -1) topIdx = i;
				bottomIdx = i;
			}
		}
	}
	// No chrome to hang corners on — leave untouched (e.g. empty render).
	if (topIdx < 0 || topIdx >= lines.length) return [...lines];
	if (bottomIdx < topIdx) bottomIdx = topIdx;

	const closed = bottomIdx > topIdx;
	return lines.map((line, i) => {
		if (i === topIdx) {
			const left = chrome("╭");
			const right = closed ? chrome("╮") : "";
			return `${left}${line}${right}`;
		}
		if (i === bottomIdx && closed) return `${chrome("╰")}${line}${chrome("╯")}`;
		// Content rows strictly between the borders get rails; rows after
		// the bottom border (autocomplete) stay open.
		if (i > topIdx && i < bottomIdx) return `${chrome("│")}${line}${chrome("│")}`;
		return line;
	});
}
