/**
 * selector-float - float pi's built-in selector panels (/settings, ...)
 * above the editor slot instead of replacing the editor inline.
 *
 * Plan B ("only intercept rendering"): the host's showSelector() flow is
 * untouched — the selector is still mounted into the editorContainer and
 * keeps keyboard focus there. We patch the container's render(): while an
 * allowlisted selector occupies it, the container renders empty and the
 * selector's lines are fed to an EditorFloatPanel (rounded frame, floating
 * above the footer). Focus, done()-restore, and every selector's internal
 * logic run exactly as before; only WHERE the panel paints changes.
 *
 * Degradation: if floating placement is unavailable (short session, no
 * room, missing internals) the container renders the selector inline —
 * the unpatched behavior.
 *
 * Rollout: selectors are floated per allowlist (constructor names) so each
 * one can be verified on a real terminal before being added.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { EditorFloatPanel, type FloatingTui, locateEditor } from "./editor-float-panel.ts";
import { FRAME_OVERHEAD, frameLines } from "./frame.ts";

/** Selector component constructor names cleared for floating. */
const FLOAT_ALLOWLIST = new Set(["SettingsSelectorComponent"]);

/** Horizontal inset matching the editor's paddingX. */
const PANEL_INSET = 1;

interface RenderableComponent {
  render(width: number): string[];
  invalidate?(): void;
}

interface PatchableContainer extends RenderableComponent {
  children?: unknown[];
  __selectorFloat?: boolean;
}

/** Border color used for the selector frame (theme dim fallback: identity). */
type ColorFn = (text: string) => string;

function isAllowlistedSelector(component: unknown): component is RenderableComponent {
  if (!component || typeof (component as RenderableComponent).render !== "function") return false;
  const name = (component as object).constructor?.name;
  return typeof name === "string" && FLOAT_ALLOWLIST.has(name);
}

/**
 * Patch the editorContainer hosting `editor` so allowlisted selectors float.
 * Called from applyAutocompleteAbove once the editor is mounted (the
 * container can only be located while the editor sits inside it).
 * Idempotent per container.
 */
export function installSelectorFloat(
  tui: FloatingTui | undefined,
  editor: unknown,
  borderColor?: () => ColorFn,
): boolean {
  const location = tui ? locateEditor(tui, editor) : null;
  if (!location || !("childIndex" in location)) return false;

  const container = (tui?.children as PatchableContainer[] | undefined)?.[location.childIndex];
  if (!container || typeof container.render !== "function") return false;
  if (container === editor) return false; // editor mounted bare: nothing to patch
  if (container.__selectorFloat) return true;
  container.__selectorFloat = true;

  const originalRender = container.render.bind(container);
  const panel = new EditorFloatPanel(tui, container);

  container.render = (width: number): string[] => {
    const occupant = container.children?.[0];
    if (!isAllowlistedSelector(occupant) || occupant === editor) {
      panel.hide();
      return originalRender(width);
    }

    // Selector open: render its lines for the floating panel.
    const contentWidth = Math.max(1, width - PANEL_INSET * 2);
    const innerWidth = Math.max(1, contentWidth - FRAME_OVERHEAD);
    let rawLines: string[];
    try {
      rawLines = occupant.render(innerWidth);
    } catch {
      panel.hide();
      return originalRender(width);
    }
    const color = borderColor?.() ?? ((text: string) => text);
    const framed = frameLines(padLines(rawLines, innerWidth), contentWidth, color);

    const floated = panel.show(framed, {
      editorHeight: 0, // container collapses while the selector floats
      col: PANEL_INSET,
      width: contentWidth,
    });
    if (floated) return [];

    // Inline fallback: unpatched behavior (selector in the editor slot).
    return originalRender(width);
  };

  return true;
}

function padLines(lines: string[], innerWidth: number): string[] {
  return lines.map((line) => {
    const fill = Math.max(0, innerWidth - visibleWidth(line));
    return fill > 0 ? `${line}${" ".repeat(fill)}` : line;
  });
}
