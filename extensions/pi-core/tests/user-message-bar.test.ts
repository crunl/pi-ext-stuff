import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyUserMessageBar, resetUserMessageBar } from "../src/tui/user-message-bar.ts";

const C_ON = "\x1b[36m";
const C_OFF = "\x1b[39m";
const BG_ON = "\x1b[48;5;236m";
const BG_OFF = "\x1b[49m";

const mockTheme = {
  fg: (_color: string, text: string) => `${C_ON}${text}${C_OFF}`,
  bg: (color: string, text: string) =>
    color === "userMessageBg" ? `${BG_ON}${text}${BG_OFF}` : text,
} as unknown as Theme;

const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07";
const OSC133_FINAL = "\x1b]133;C\x07";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const OSC133_RE = new RegExp(`${ESC}\\]133;[ABC]${BEL}`, "g");

/** Strip SGR colors and OSC 133 zone marks. */
function plain(line: string): string {
  return line.replace(SGR_RE, "").replace(OSC133_RE, "").trimEnd();
}

function renderUser(text: string, width = 40, outputPad = 1): string[] {
  const component = new UserMessageComponent(text, getMarkdownTheme(), outputPad);
  return component.render(width);
}

describe("applyUserMessageBar", () => {
  beforeAll(() => {
    // UserMessageComponent's markdown color callback reads the host theme
    // singleton; initialize it once for the suite.
    initTheme("dark", false);
  });

  afterEach(() => {
    resetUserMessageBar();
  });

  it("prefixes an accent bar, bands content, and keeps a min of 3 rows", () => {
    applyUserMessageBar(() => mockTheme);
    const lines = renderUser("hello world");

    // blank band + content + blank band
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(plain(line).startsWith("▌")).toBe(true);
    }
    // Content sits right after the 1-column bar (aligned with assistant pad=1).
    expect(plain(lines[1])).toBe("▌hello world");
    // Bar stays accent-colored; every row carries the background band.
    for (const line of lines) {
      expect(line).toContain(`${C_ON}▌${C_OFF}`);
      expect(line).toContain(BG_ON);
    }
  });

  it("wraps long lines under the same bar gutter", () => {
    applyUserMessageBar(() => mockTheme);
    const long = `${"word ".repeat(20).trim()}`;
    const lines = renderUser(long, 30);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const text = plain(line);
      if (text.length === 0) continue;
      expect(text.startsWith("▌")).toBe(true);
      // bar (1) + content ≤ 30
      expect(text.length).toBeLessThanOrEqual(30);
    }
  });

  it("colors the bar via theme.fg borderAccent and keeps OSC 133 around the block", () => {
    applyUserMessageBar(() => mockTheme);
    const lines = renderUser("hi");

    // min 3 rows: top pad, content, bottom pad
    expect(lines.length).toBe(3);
    expect(lines[0].startsWith(OSC133_START)).toBe(true);
    expect(plain(lines[1]).startsWith("▌hi")).toBe(true);
    expect(lines[1]).toContain(`${C_ON}▌${C_OFF}`);
    expect(lines[2]).toContain(OSC133_END);
    expect(lines[2]).toContain(OSC133_FINAL);

    // Multi-line: first row opens the zone, last row closes it.
    const wrapped = renderUser("word ".repeat(20).trim(), 30);
    expect(wrapped.length).toBeGreaterThan(3);
    expect(wrapped[0].startsWith(OSC133_START)).toBe(true);
    expect(wrapped[wrapped.length - 1]).toContain(OSC133_END);
  });

  it("falls back to an uncolored bar when no theme is available", () => {
    applyUserMessageBar(() => undefined);
    const lines = renderUser("hi");
    expect(lines.length).toBe(3);
    expect(plain(lines[1])).toBe("▌hi");
    expect(lines[1]).not.toContain(C_ON);
  });

  it("restores the original band rendering after reset", () => {
    applyUserMessageBar(() => mockTheme);
    const barred = renderUser("hi");
    expect(plain(barred[0]).startsWith("▌")).toBe(true);

    resetUserMessageBar();
    const restored = renderUser("hi");
    expect(restored.some((line) => plain(line).startsWith("▌"))).toBe(false);
    expect(restored.some((line) => plain(line).includes("hi"))).toBe(true);
  });

  it("is re-entrant: a second apply replaces the wrapper instead of nesting", () => {
    applyUserMessageBar(() => mockTheme);
    applyUserMessageBar(() => mockTheme);
    const lines = renderUser("hi");
    const bars = plain(lines[0]).match(/▌/g) ?? [];
    expect(bars.length).toBe(1);
  });
});
