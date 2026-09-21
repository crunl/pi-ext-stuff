/**
 * A deliberately small bridge to Pi's renderer API. The extension is loaded
 * directly from TypeScript, so this module uses the Component protocol rather
 * than importing a second copy of pi-tui.
 */
import { REVIEW_STATUS_ICON } from "./review-presenter.ts";

export interface ReviewComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface ReviewTheme {
  fg?(color: string, text: string): string;
}

export interface ReviewPartialResult {
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly [key: string]: unknown;
}

export interface ReviewStatusBridge {
  readonly onUpdate: ((result: ReviewPartialResult) => void) | undefined;
  readonly binding: {
    setReviewStatus(status: string | undefined): void;
    notify?(message: string, severity: "info" | "warning" | "error"): void;
  };
}

const REVIEW_DETAILS = Symbol("pi-permissions-review-details");
const REVIEW_COMPONENT = Symbol("pi-permissions-review-component");

interface DecoratedDetails {
  readonly [REVIEW_DETAILS]: true;
  readonly base: unknown;
  readonly status: string;
}

interface WrappedComponent extends ReviewComponent {
  readonly [REVIEW_COMPONENT]: true;
  readonly base: unknown;
}

function isDecoratedDetails(value: unknown): value is DecoratedDetails {
  return typeof value === "object" && value !== null && REVIEW_DETAILS in value;
}

function isWrappedComponent(value: unknown): value is WrappedComponent {
  return typeof value === "object" && value !== null && REVIEW_COMPONENT in value;
}

export function decorateReviewDetails(details: unknown, status: string): unknown {
  if (isDecoratedDetails(details)) {
    return Object.freeze({ ...details, status });
  }
  return Object.freeze({ [REVIEW_DETAILS]: true as const, base: details, status });
}

export function unwrapReviewDetails(details: unknown): unknown {
  return isDecoratedDetails(details) ? details.base : details;
}

export function reviewStatusFromDetails(details: unknown): string | undefined {
  return isDecoratedDetails(details) ? details.status : undefined;
}

export function unwrapReviewComponent(component: unknown): unknown {
  return isWrappedComponent(component) ? component.base : component;
}

function withoutReviewStatus(result: ReviewPartialResult): ReviewPartialResult {
  const details = unwrapReviewDetails(result.details);
  return details === result.details ? result : { ...result, details };
}

function withReviewStatus(result: ReviewPartialResult, status: string): ReviewPartialResult {
  return { ...result, details: decorateReviewDetails(result.details, status) };
}

function boundedWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/** Keep the transient row inside the TUI viewport without depending on pi-tui. */
function truncateLine(value: string, width: number): string {
  const limit = boundedWidth(width);
  if (limit === 0) return "";
  const codePoints = [...value];
  if (codePoints.length <= limit) return value;
  if (limit === 1) return codePoints[0] ?? "";
  return `${codePoints.slice(0, limit - 1).join("")}…`;
}

function wrapLine(value: string, width: number): string[] {
  const limit = boundedWidth(width);
  if (limit === 0) return [""];
  const codePoints = [...value];
  if (codePoints.length === 0) return [""];
  const lines: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += limit) {
    lines.push(codePoints.slice(offset, offset + limit).join(""));
  }
  return lines;
}

/**
 * Keeps the latest partial result as the row's base state. Status updates emit
 * only a transient partial projection; the final tool result is never tagged.
 */
export function createReviewStatusBridge(
  onUpdate: ((result: ReviewPartialResult) => void) | undefined,
  notify?: (message: string, severity: "info" | "warning" | "error") => void,
): ReviewStatusBridge {
  let latest: ReviewPartialResult | undefined;
  let status: string | undefined;

  const emit = (): void => {
    if (!onUpdate) return;
    const source = latest ?? { content: [] };
    try {
      onUpdate(status === undefined ? source : withReviewStatus(source, status));
    } catch {
      // Rendering is observational and must never change authorization.
    }
  };

  return {
    onUpdate:
      onUpdate === undefined
        ? undefined
        : (result) => {
            latest = withoutReviewStatus(result);
            emit();
          },
    binding: {
      setReviewStatus(next) {
        if (next === status) return;
        status = next;
        emit();
      },
      ...(notify === undefined ? {} : { notify }),
    },
  };
}

function overlayComponent(
  base: unknown,
  status: string,
  theme: ReviewTheme,
): ReviewComponent & WrappedComponent {
  const component = base as Partial<ReviewComponent> | undefined;
  const wrapped: ReviewComponent & WrappedComponent = {
    [REVIEW_COMPONENT]: true,
    base,
    render(width) {
      const lines = typeof component?.render === "function" ? component.render(width) : [];
      const coloredStatus = truncateLine(status, width);
      const colored = theme.fg?.("warning", coloredStatus) ?? coloredStatus;
      return [...lines, colored];
    },
    invalidate() {
      component?.invalidate?.();
    },
  };
  return wrapped;
}

export type ReviewRenderResult = (
  result: ReviewPartialResult,
  options: unknown,
  theme: ReviewTheme,
  context: { readonly lastComponent?: unknown; readonly [key: string]: unknown },
) => unknown;

/** Minimal fallback for an extension tool that does not have a base renderer. */
export const plainReviewResultRenderer: ReviewRenderResult = (result) => ({
  render(width: number) {
    return result.content.flatMap((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text.split("\n").flatMap((line) => wrapLine(line, width));
      }
      return [];
    });
  },
  invalidate() {},
});

export type ReviewRendererMode = "header-icon" | "overlay";

/**
 * Wrap one existing Pi renderResult without changing its base rendering.
 *
 * `"header-icon"`: stamp a permanent leading glyph badge on `context.state`
 * (consumed by pi-core `leadingParts`); never overlays a status row.
 * `"overlay"`: append a transient status row (tools without a Codex header).
 */
export function createReviewResultRenderer(
  baseRenderResult: ReviewRenderResult | undefined,
  mode: ReviewRendererMode,
): ReviewRenderResult {
  return (result, options, theme, context) => {
    const status = reviewStatusFromDetails(result.details);
    const baseResult = withoutReviewStatus(result);
    const baseContext = {
      ...context,
      lastComponent: unwrapReviewComponent(context.lastComponent),
    };
    if (mode === "header-icon" && status !== undefined) {
      const state = context.state as { leadingIconOverride?: string } | undefined;
      if (state) state.leadingIconOverride = REVIEW_STATUS_ICON;
    }
    const base = baseRenderResult?.(baseResult, options, theme, baseContext);
    if (mode === "header-icon" || status === undefined) return base;
    return overlayComponent(base, status, theme);
  };
}
