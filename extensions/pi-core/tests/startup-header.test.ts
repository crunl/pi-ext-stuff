import { existsSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  buildStartupHeaderLines,
  centerLine,
  getLogoAssetPath,
  lineHasInk,
  registerStartupHeader,
  renderLogoWithChafa,
  resolveChafaBin,
  shouldShowStartupHeader,
  trimInkLines,
} from "../src/tui/startup-header.ts";

describe("startup header", () => {
  it("centers plain lines within the terminal width", () => {
    expect(centerLine("ab", 10)).toBe("    ab");
    expect(centerLine("abcdefghij", 10)).toBe("abcdefghij");
  });

  it("trims blank ink-less rows from chafa output", () => {
    const red = "\x1b[38;2;200;0;0m█\x1b[0m";
    expect(trimInkLines(["   ", red, "\x1b[0m  ", ""])).toEqual([red]);
    expect(lineHasInk("   ")).toBe(false);
    expect(lineHasInk(red)).toBe(true);
  });

  it("is empty when there is no logo (no wordmark fallback)", () => {
    const lines = buildStartupHeaderLines(40, { logoLines: null });
    expect(lines).toEqual([]);
  });

  it("centers logo rows only — no pi / version text", () => {
    const lines = buildStartupHeaderLines(20, { logoLines: ["XXXX"] });
    expect(lines.some((l) => l.includes("XXXX"))).toBe(true);
    expect(lines.some((l) => /\bpi\b/i.test(l))).toBe(false);
    expect(lines.some((l) => /v\d/.test(l))).toBe(false);
    const logo = lines.find((l) => l.includes("XXXX"));
    expect(logo?.startsWith("  ")).toBe(true);
    expect(lines.every((l) => visibleWidth(l) <= 20)).toBe(true);
  });

  it("shows only on fresh-session reasons", () => {
    expect(shouldShowStartupHeader("startup")).toBe(true);
    expect(shouldShowStartupHeader("new")).toBe(true);
    expect(shouldShowStartupHeader("reload")).toBe(true);
    expect(shouldShowStartupHeader("resume")).toBe(false);
    expect(shouldShowStartupHeader("fork")).toBe(false);
  });

  it("ships a logo asset", () => {
    expect(existsSync(getLogoAssetPath())).toBe(true);
  });

  it("renders via chafa when available", () => {
    const bin = resolveChafaBin();
    if (!bin) {
      expect(renderLogoWithChafa({ bin: null })).toBeNull();
      return;
    }
    const rows = renderLogoWithChafa({ bin, cols: 32, rows: 12 });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(3);
    expect(rows!.some(lineHasInk)).toBe(true);
  });

  it("registers setHeader on tui session_start and clears on resume", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerStartupHeader({
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
    } as any);

    const setHeader = vi.fn();
    const ctx = { hasUI: true, mode: "tui", ui: { setHeader } };

    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    expect(setHeader).toHaveBeenCalledTimes(1);
    const factory = setHeader.mock.calls[0][0];
    if (typeof factory === "function") {
      const component = factory();
      const rendered = component.render(40);
      expect(rendered.some((l: string) => /\bpi\b/i.test(l))).toBe(false);
      expect(rendered.some((l: string) => /v\d/.test(l))).toBe(false);
    }

    setHeader.mockClear();
    handlers.get("session_start")?.({ reason: "resume" }, ctx);
    expect(setHeader).toHaveBeenCalledWith(undefined);
  });

  it("skips non-tui contexts", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    registerStartupHeader({
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
    } as any);
    const setHeader = vi.fn();
    handlers.get("session_start")?.(
      { reason: "startup" },
      { hasUI: true, mode: "rpc", ui: { setHeader } },
    );
    expect(setHeader).not.toHaveBeenCalled();
  });
});
