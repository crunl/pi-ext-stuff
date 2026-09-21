/**
 * user-message-bar - Crush-style left rail plus a content background band.
 *
 * Pi paints user messages as a full-width ChatGPT-style background band
 * (`Box` + `userMessageBg` + paddingY blank rows). There is no public hook
 * for that chrome, so we patch `UserMessageComponent.prototype.render`:
 *   - unwrap the Box (drops its paddingY blank rows)
 *   - prefix every line with a 1-column accent bar
 *   - re-apply `userMessageBg` to the content columns only
 *   - restore one blank banded row above and below (min 3 rows for 1 line)
 *   - keep OSC 133 zone marks around the whole block (bar included)
 *
 * Geometry: the bar owns column 0 and content starts at column 1. With the
 * default `outputPad=1` that lines up with assistant text; `outputPad=0`
 * shifts user content one column right of the assistant edge (inherent to
 * keeping a 1-column bar).
 *
 *   ▌
 *   ▌ first line of the user message
 *   ▌ wrapped continuation
 *   ▌
 *     assistant reply (no bar, no band)
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { isInteractiveTui } from "./ui-guard.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BAR = "▌";

type ThemeRef = () => Theme | undefined;

interface BgBox {
  setBgFn?(bgFn?: (text: string) => string): void;
}

interface PatchCarrier {
  render(this: UserMessageComponent, width: number): string[];
  __userBarOriginal?: (this: UserMessageComponent, width: number) => string[];
  __userBarTheme?: ThemeRef;
}

/**
 * Patch `UserMessageComponent.render`. Re-entrant: the pristine original is
 * stashed on the prototype so `/reload` swaps in the current wrapper instead
 * of pinning a stale closure. Failures fall through to the original band
 * rendering (bg stays on, no bar).
 */
export function applyUserMessageBar(getTheme: ThemeRef): void {
  const proto = UserMessageComponent.prototype as unknown as PatchCarrier;
  if (typeof proto.render !== "function") return;

  const original = proto.__userBarOriginal ?? proto.render;
  proto.__userBarOriginal = original;
  proto.__userBarTheme = getTheme;

  proto.render = function (this: UserMessageComponent, width: number): string[] {
    const gutter = 1;
    try {
      const theme = proto.__userBarTheme?.();
      // Unwrap the Box chrome (bg + paddingY blank rows). The Box still owns
      // the Markdown child built by rebuild(); we keep that child only.
      // Discriminator: Box has setBgFn, Markdown does not.
      const children = (this as unknown as { children?: unknown[] }).children;
      const first = children?.[0] as (BgBox & { children?: unknown[] }) | undefined;
      if (first && typeof first.setBgFn === "function" && first.children?.[0]) {
        const markdown = first.children[0];
        (this as unknown as { clear(): void }).clear();
        (this as unknown as { addChild(c: unknown): void }).addChild(markdown);
      }

      // Render content at reduced width so the bar does not steal wrap space.
      // Bypass the original OSC133 wrapper: we re-apply marks after the bar.
      const contentWidth = Math.max(1, width - gutter);
      const lines = Container.prototype.render.call(this, contentWidth);
      if (lines.length === 0) return lines;

      const bar = theme ? theme.fg("borderAccent", BAR) : BAR;
      const bandRow = (line: string) => {
        // Pad content to the wrap width, then paint the band (mirrors Box.applyBg).
        const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
        const banded = theme ? theme.bg("userMessageBg", line + pad) : line + pad;
        return bar + banded;
      };
      // One blank banded row above and below → min 3 rows for a 1-line message.
      const out = [bandRow(""), ...lines.map(bandRow), bandRow("")];
      out[0] = OSC133_ZONE_START + out[0];
      out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
      return out;
    } catch {
      return original.call(this, width);
    }
  };
}

/** Undo the prototype patch (test helper / hot-reload escape hatch). */
export function resetUserMessageBar(): void {
  const proto = UserMessageComponent.prototype as unknown as PatchCarrier;
  if (proto.__userBarOriginal) {
    proto.render = proto.__userBarOriginal;
    proto.__userBarOriginal = undefined;
    proto.__userBarTheme = undefined;
  }
}

/** Install the Crush-style user rail for interactive TUI sessions. */
export function registerUserMessageBar(pi: ExtensionAPI): void {
  let theme: Theme | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!isInteractiveTui(ctx)) return;
    theme = ctx.ui.theme;
  });
  applyUserMessageBar(() => theme);
}
