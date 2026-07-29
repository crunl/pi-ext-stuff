/**
 * markdown-code-frame - restyle fenced code blocks in assistant markdown.
 *
 * pi-tui's Markdown component hardcodes raw fence lines around code blocks:
 *
 *   ```ts        <- theme.codeBlockBorder("```" + lang)
 *     code...
 *   ```
 *
 * There is no official hook to change this (codeBlockBorder only colors the
 * text), so we patch Markdown.prototype.renderToken and take over the
 * "code" token branch, delegating every other token to the original:
 *
 *   ╭─ ts ─────────╮
 *   │ code...        │
 *   ╰────────────────╯
 *
 * Code is pre-wrapped to the frame's inner width and each row is padded
 * back out, so every emitted row is exactly `width` columns and survives
 * the outer Markdown.render() wrap pass (at contentWidth) untouched.
 *
 * Syntax highlighting is untouched: theme.highlightCode (when present)
 * still colors the code, we only replace the fence dressing.
 */
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface CodeToken {
  type: string;
  text: string;
  lang?: string;
}

interface MarkdownThemeInternals {
  codeBlockBorder(text: string): string;
  codeBlock(text: string): string;
  highlightCode?(code: string, lang?: string): string[];
}

interface MarkdownInternals {
  theme: MarkdownThemeInternals;
  renderToken(
    token: CodeToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ): string[];
}

/** Columns consumed by the frame: `│ ` left + ` │` right. */
const FRAME_OVERHEAD = 4;

type RenderToken = MarkdownInternals["renderToken"];

interface PatchCarrier extends MarkdownInternals {
  /** Pristine renderToken, stashed on the prototype so hot reloads can find it. */
  __codeFrameOriginal?: RenderToken;
}

/**
 * Patch Markdown.prototype.renderToken to frame code blocks. Re-entrant:
 * the pristine original is stashed on the prototype itself, so calling
 * again (e.g. after /reload re-evaluates this module while the host keeps
 * the same Markdown class) replaces the wrapper with the current version
 * instead of keeping a stale closure pinned.
 * Failures degrade to the original fence rendering: the wrapper only
 * replaces the "code" branch and falls back to the original on any error.
 */
export function applyMarkdownCodeFrame(): void {
  const proto = Markdown.prototype as unknown as PatchCarrier;
  if (typeof proto.renderToken !== "function") return;

  const original = proto.__codeFrameOriginal ?? proto.renderToken;
  proto.__codeFrameOriginal = original;
  proto.renderToken = function (
    this: MarkdownInternals,
    token: CodeToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ): string[] {
    if (token.type === "code") {
      try {
        return renderCodeFrame(this.theme, token, width, nextTokenType);
      } catch {
        // fall through to the original fence rendering
      }
    }
    return original.call(this, token, width, nextTokenType, styleContext);
  };
}

/** Undo the prototype patch (test helper). */
export function resetMarkdownCodeFrame(): void {
  const proto = Markdown.prototype as unknown as PatchCarrier;
  if (proto.__codeFrameOriginal) {
    proto.renderToken = proto.__codeFrameOriginal;
    proto.__codeFrameOriginal = undefined;
  }
}

function renderCodeFrame(
  theme: MarkdownThemeInternals,
  token: CodeToken,
  width: number,
  nextTokenType?: string,
): string[] {
  const innerWidth = Math.max(1, width - FRAME_OVERHEAD);
  const border = (text: string) => theme.codeBlockBorder(text);

  // Language label: first word only ("ts title=x" -> "ts").
  const lang = token.lang?.trim().split(/\s+/)[0] ?? "";
  const label = lang.length > 0 ? `─ ${lang} ` : "";
  const lines: string[] = [
    border(`╭${label}${"─".repeat(Math.max(0, innerWidth + 2 - label.length))}╮`),
  ];

  // Highlight first, then wrap each resulting line to the inner width and
  // pad it back out, so every row is exactly `width` columns and survives
  // the outer Markdown.render() wrap pass untouched.
  const contentLines = theme.highlightCode
    ? theme.highlightCode(token.text, token.lang)
    : token.text.split("\n").map((line) => theme.codeBlock(line));
  const left = border("│ ");
  const right = border(" │");
  for (const contentLine of contentLines) {
    const wrapped = wrapTextWithAnsi(contentLine, innerWidth);
    for (const row of wrapped.length > 0 ? wrapped : [""]) {
      const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(row)));
      lines.push(`${left}${row}${fill}${right}`);
    }
  }

  lines.push(border(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`));
  if (nextTokenType && nextTokenType !== "space") {
    lines.push(""); // spacing after the block, mirroring the original
  }
  return lines;
}

