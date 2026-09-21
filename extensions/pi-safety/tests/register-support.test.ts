import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_TIMEOUT_SECONDS,
  nextMode,
  normalizeEscalatedBashTimeout,
  requiresSandbox,
} from "../src/register-support.ts";

describe("normalizeEscalatedBashTimeout", () => {
  it("defaults an unset timeout to the escalated host budget", () => {
    expect(normalizeEscalatedBashTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_BASH_TIMEOUT_SECONDS + 1])(
    "rejects invalid timeout %s",
    (timeout) => {
      expect(() => normalizeEscalatedBashTimeout(timeout)).toThrow(/Invalid timeout/);
    },
  );

  it("passes through a valid finite timeout", () => {
    expect(normalizeEscalatedBashTimeout(30)).toBe(30);
    expect(normalizeEscalatedBashTimeout(MAX_BASH_TIMEOUT_SECONDS)).toBe(MAX_BASH_TIMEOUT_SECONDS);
  });
});

describe("mode helpers", () => {
  it("cycles auto <-> yolo", () => {
    expect(nextMode("auto")).toBe("yolo");
    expect(nextMode("yolo")).toBe("auto");
  });

  it("requires a sandbox only outside yolo when sandbox is enabled", () => {
    expect(requiresSandbox("auto", DEFAULT_CONFIG)).toBe(true);
    expect(requiresSandbox("yolo", DEFAULT_CONFIG)).toBe(false);
    expect(
      requiresSandbox("auto", {
        ...DEFAULT_CONFIG,
        sandbox: { ...DEFAULT_CONFIG.sandbox, enabled: false },
      }),
    ).toBe(false);
  });
});
