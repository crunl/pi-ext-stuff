import { describe, expect, it } from "vitest";
import {
  BADGE_CAP_WIDTH,
  contrastTextFor,
  makeModeBadgeDecorator,
  parseTruecolor,
  PL_LEFT,
  PL_RIGHT,
} from "../src/badge.ts";

describe("parseTruecolor", () => {
  it("parses truecolor foreground and background sequences", () => {
    expect(parseTruecolor("\x1b[38;2;229;200;144m")).toEqual([229, 200, 144]);
    expect(parseTruecolor("\x1b[48;2;10;20;30m")).toEqual([10, 20, 30]);
  });

  it("returns null for non-truecolor sequences", () => {
    expect(parseTruecolor("\x1b[33m")).toBeNull();
    expect(parseTruecolor("\x1b[38;5;220m")).toBeNull();
    expect(parseTruecolor("")).toBeNull();
  });
});

describe("contrastTextFor", () => {
  it("uses black text on light backgrounds and white on dark", () => {
    // Catppuccin mocha red (light) -> black text
    expect(contrastTextFor([231, 130, 132])).toBe("\x1b[30m");
    // Catppuccin latte red (dark) -> white text
    expect(contrastTextFor([210, 15, 57])).toBe("\x1b[97m");
    // Threshold boundary
    expect(contrastTextFor([128, 128, 128])).toBe("\x1b[30m");
    expect(contrastTextFor([127, 127, 127])).toBe("\x1b[97m");
  });
});

describe("makeModeBadgeDecorator", () => {
  it("decorates as a powerline pill with the warning background", () => {
    const decorate = makeModeBadgeDecorator("\x1b[38;2;229;200;144m");
    expect(decorate("Auto")).toBe(
      "\x1b[38;2;229;200;144m" +
        PL_LEFT +
        "\x1b[39m" +
        "\x1b[48;2;229;200;144m\x1b[30mAuto\x1b[39m\x1b[49m" +
        "\x1b[38;2;229;200;144m" +
        PL_RIGHT +
        "\x1b[39m",
    );
  });

  it("decorates dark backgrounds with white text", () => {
    const decorate = makeModeBadgeDecorator("\x1b[38;2;210;15;57m");
    const out = decorate("YOLO");
    expect(out).toContain("\x1b[48;2;210;15;57m\x1b[97mYOLO\x1b[39m\x1b[49m");
    expect(out.startsWith("\x1b[38;2;210;15;57m" + PL_LEFT)).toBe(true);
    expect(out.endsWith(PL_RIGHT + "\x1b[39m")).toBe(true);
  });

  it("falls back to inverse video without truecolor data", () => {
    for (const ansi of [undefined, "\x1b[33m", "\x1b[38;5;220m"]) {
      const decorate = makeModeBadgeDecorator(ansi);
      expect(decorate("Auto")).toBe(`\x1b[7m${PL_LEFT}Auto${PL_RIGHT}\x1b[27m`);
    }
  });

  it("caps add two visible columns around the label", () => {
    expect(BADGE_CAP_WIDTH).toBe(2);
    expect(PL_LEFT).toHaveLength(1);
    expect(PL_RIGHT).toHaveLength(1);
  });
});
