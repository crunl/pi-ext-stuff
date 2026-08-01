import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Incremental highlight preview for the write tool.
 *
 * The cache update logic (prefix-append incremental highlight, 50-line
 * prefix re-highlight) mirrors pi's built-in write rendering in
 * @earendil-works/pi-coding-agent (core/tools/write.ts, WriteCallRenderComponent).
 * It is duplicated rather than imported because the built-in implementation is
 * not part of the package's public API. If the built-in renderer ever exports
 * this machinery, replace this module's internals with that import.
 */

/** Rows of the preview shown while a write is streamed or expanded. */
const PREVIEW_LINE_LIMIT = 50;

export interface WriteHighlightCache {
  rawPath: string;
  lang: string | undefined;
  rawContent: string;
  normalizedLines: string[];
  highlightedLines: string[];
}

function highlightSingleLine(line: string, lang: string): string {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}

function rebuildWriteHighlightCache(
  rawPath: string,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  const normalized = fileContent.replace(/\r\n?/g, "\n");
  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang),
  };
}

/**
 * Re-highlight the first PREVIEW_LINE_LIMIT lines after an incremental append:
 * multi-line constructs (strings, comments) only resolve correctly once the
 * closing delimiter arrives, so the prefix needs a full pass. Same approach
 * as pi's built-in write rendering.
 */
function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
  const prefixCount = Math.min(PREVIEW_LINE_LIMIT, cache.normalizedLines.length);
  if (prefixCount === 0) return;
  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlightCode(prefixSource, cache.lang ?? "");
  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] =
      prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang ?? "");
  }
}

/**
 * Incremental highlight cache update: appends highlight only for the newly
 * streamed suffix when the content grew by prefix; rebuilds wholesale when
 * the path, language, or prefix changes.
 */
export function updateWriteHighlightCache(
  cache: WriteHighlightCache | undefined,
  rawPath: string,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  if (!cache) return rebuildWriteHighlightCache(rawPath, fileContent);
  if (cache.lang !== lang || cache.rawPath !== rawPath)
    return rebuildWriteHighlightCache(rawPath, fileContent);
  if (!fileContent.startsWith(cache.rawContent))
    return rebuildWriteHighlightCache(rawPath, fileContent);
  if (fileContent.length === cache.rawContent.length) return cache;

  const deltaRaw = fileContent.slice(cache.rawContent.length);
  cache.rawContent = fileContent;
  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }
  const segments = deltaRaw.replace(/\r\n?/g, "\n").split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  cache.normalizedLines[lastIndex] += segments[0];
  cache.highlightedLines[lastIndex] = highlightSingleLine(
    cache.normalizedLines[lastIndex],
    cache.lang,
  );
  for (let i = 1; i < segments.length; i++) {
    cache.normalizedLines.push(segments[i]);
    cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
  }
  refreshWriteHighlightPrefix(cache);
  return cache;
}

/**
 * Build the preview text: right-aligned dim line numbers, then the
 * syntax-highlighted line, capped at PREVIEW_LINE_LIMIT rows.
 */
export function renderWritePreviewText(
  cache: WriteHighlightCache | undefined,
  theme: Theme,
): string {
  if (!cache) return "";
  const lineCount = cache.normalizedLines.length;
  const limit = Math.min(PREVIEW_LINE_LIMIT, lineCount);
  const gutterWidth = String(lineCount).length;
  const lines: string[] = [];
  for (let i = 0; i < limit; i++) {
    const lineNumber = String(i + 1).padStart(gutterWidth);
    const gutter = theme.fg("dim", `${lineNumber} │ `);
    const code = cache.highlightedLines[i] ?? cache.normalizedLines[i] ?? "";
    lines.push(`${gutter}${code}`);
  }
  const remaining = lineCount - limit;
  if (remaining > 0) {
    lines.push(theme.fg("dim", `… ${remaining} more lines`));
  }
  return lines.join("\n");
}

/**
 * Preview component for the write tool. Carries the highlight cache so the
 * caller can persist it (e.g. into renderer state) for incremental updates.
 */
export class WritePreviewComponent extends Text {
  cache: WriteHighlightCache | undefined;

  constructor(cache: WriteHighlightCache | undefined, theme: Theme) {
    super(renderWritePreviewText(cache, theme), 0, 0);
    this.cache = cache;
  }
}

/**
 * Build the preview for a write call's arguments, updating the highlight
 * cache incrementally when the content grew by prefix. Shared by the
 * streamed (renderCallPreview) and settled (renderExpandedResult) paths.
 */
export function createWritePreviewFromArgs(
  args: Record<string, unknown>,
  cache: WriteHighlightCache | undefined,
  theme: Theme,
): WritePreviewComponent {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  const next = updateWriteHighlightCache(cache, path, content);
  return new WritePreviewComponent(next, theme);
}
