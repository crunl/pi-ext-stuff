/**
 * user-message-bar - Crush-style left rail plus a content background band.
 *
 * Host shapes (both supported, detected at render time):
 * - Pi ≤0.99: `Box(outputPad, paddingY=1, userMessageBg)` around
 *   `Markdown(text, 0, 0)`. We unwrap the Box (drops its paddingY blank
 *   rows) and keep the Markdown child only.
 * - Pi 1.0.0+: the Box is gone (it kept a second full-width copy of every
 *   line); `Markdown(text, outputPad, paddingY=1)` carries its own padding
 *   rows and background. We keep it as-is but drop its own paddingY blank
 *   rows so the bar owns the only blank bands.
 *
 * In both cases the patch then:
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
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { isInteractiveTui } from "./ui-guard.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BAR = "▌";
// Built via string concat: a regex literal with \x1b trips noControlCharactersInRegex.
const SGR_PREFIX_RE = new RegExp(`^((?:${String.fromCharCode(0x1b)}\\[[0-9;]*m)*)( +)`);

type ThemeRef = () => Theme | undefined;

interface BgBox {
  setBgFn?(bgFn?: (text: string) => string): void;
}

interface PatchCarrier {
  render(this: UserMessageComponent, width: number): string[];
  invalidate?(this: UserMessageComponent): void;
  __userBarOriginal?: (this: UserMessageComponent, width: number) => string[];
  __userBarInvalidate?: (this: UserMessageComponent) => void;
  __userBarTheme?: ThemeRef;
}

interface BarCacheEntry {
  width: number;
  bar: string;
  band: string;
  theme: Theme | undefined;
  child: unknown;
  lines: string[];
}

/** Per-instance frame cache: user messages are immutable, so output varies
 * only with width, theme colors, and the (post-unwrap) Markdown child. */
const barCache = new WeakMap<object, BarCacheEntry>();

function clearBarCache(instance: object): void {
  barCache.delete(instance);
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

  if (typeof proto.invalidate === "function" && proto.__userBarInvalidate === undefined) {
    proto.__userBarInvalidate = proto.invalidate;
  }
  const originalInvalidate = proto.__userBarInvalidate;
  if (typeof originalInvalidate === "function") {
    proto.invalidate = function (this: UserMessageComponent): void {
      clearBarCache(this);
      originalInvalidate.call(this);
    };
  }

  proto.render = function (this: UserMessageComponent, width: number): string[] {
    const gutter = 1;
    try {
      const theme = proto.__userBarTheme?.();
      // Unwrap the Box chrome (bg + paddingY blank rows). The Box still owns
      // the Markdown child built by rebuild(); we keep that child only.
      // Discriminator: Box has setBgFn, Markdown does not. Runs once per
      // instance in practice — after the first unwrap the check fails fast.
      const children = (this as unknown as { children?: unknown[] }).children;
      const first = children?.[0] as (BgBox & { children?: unknown[] }) | undefined;
      if (first && typeof first.setBgFn === "function" && first.children?.[0]) {
        const markdown = first.children[0];
        (this as unknown as { clear(): void }).clear();
        (this as unknown as { addChild(c: unknown): void }).addChild(markdown);
        clearBarCache(this);
      }

      const bar = theme ? theme.fg("borderAccent", BAR) : BAR;
      // Probe of the band color: catches in-place theme mutations where the
      // theme object identity stays the same but colors change.
      const band = theme ? theme.bg("userMessageBg", "") : "";
      const child = (this as unknown as { children?: unknown[] }).children?.[0];
      const cached = barCache.get(this);
      if (
        cached &&
        cached.width === width &&
        cached.bar === bar &&
        cached.band === band &&
        cached.theme === theme &&
        cached.child === child
      ) {
        return cached.lines;
      }

      // Render content at reduced width so the bar does not steal wrap space.
      // Bypass the original OSC133 wrapper: we re-apply marks after the bar.
      const contentWidth = Math.max(1, width - gutter);
      const padChild = child as { paddingX?: unknown; paddingY?: unknown } | undefined;
      const readPad = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      const ownPad = readPad(padChild?.paddingY);
      const margin = readPad(padChild?.paddingX);
      let lines = Container.prototype.render.call(this, contentWidth);
      if (lines.length === 0) return lines;
      // Host 1.0.0+ renders Markdown with its own paddingY blank rows (the Box
      // that used to own them is gone). Drop them so the bar below owns the
      // only blank bands; keep everything else byte-for-byte.
      if (ownPad > 0) {
        const isBlankRow = (line: string) => stripTerminalSequences(line).trim() === "";
        let top = 0;
        while (top < ownPad && top < lines.length && isBlankRow(lines[top] ?? "")) top += 1;
        let bottom = 0;
        while (
          bottom < ownPad &&
          bottom < lines.length - top &&
          isBlankRow(lines[lines.length - 1 - bottom] ?? "")
        )
          bottom += 1;
        if (top > 0 || bottom > 0) lines = lines.slice(top, lines.length - bottom);
      }
      if (lines.length === 0) return lines;
      // The same Markdown also paints its own paddingX left margin. Strip
      // exactly that margin (spaces after any leading SGR codes) so content
      // hugs the bar like before; inner styling and indentation survive.
      if (margin > 0) {
        const unmargin = (_match: string, codes: string, spaces: string): string => {
          const drop = Math.min(margin, spaces.length);
          return `${codes}${spaces.slice(drop)}`;
        };
        lines = lines.map((line) => line.replace(SGR_PREFIX_RE, unmargin));
      }

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
      barCache.set(this, { width, bar, band, theme, child, lines: out });
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
  if (proto.__userBarInvalidate && typeof proto.invalidate === "function") {
    proto.invalidate = proto.__userBarInvalidate;
    proto.__userBarInvalidate = undefined;
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
