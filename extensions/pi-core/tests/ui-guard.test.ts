import { describe, expect, it } from "vitest";
import { isInteractiveTui } from "../src/tui/ui-guard.ts";

describe("isInteractiveTui", () => {
  it("is true only when the host has UI and runs in tui mode", () => {
    expect(isInteractiveTui({ hasUI: true, mode: "tui" })).toBe(true);
  });

  it("rejects RPC and headless contexts even when dialogs are available", () => {
    expect(isInteractiveTui({ hasUI: true, mode: "rpc" })).toBe(false);
    expect(isInteractiveTui({ hasUI: false, mode: "tui" })).toBe(false);
  });
});
