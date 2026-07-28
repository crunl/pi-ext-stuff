import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PermissionModeRuntime } from "../src/mode-runtime.ts";

describe("PermissionModeRuntime", () => {
  it("activates Auto, resets pause state, persists, and reports compact status", () => {
    const appendEntry = vi.fn();
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, appendEntry);
    runtime.applyAutoState({ consecutiveDenials: 3, paused: true });

    expect(runtime.activate("auto", { idle: true })).toBe("auto");
    expect(runtime.autoState).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
    expect(runtime.statusLabel).toBe("Auto");
    expect(appendEntry).toHaveBeenCalledWith(
      "pi-permissions-state",
      expect.objectContaining({ mode: "auto" }),
    );
  });

  it("blocks transitions while any review is active but permits parallel review IDs", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    expect(runtime.beginReview("call-1")).toBe(true);
    expect(runtime.beginReview("call-2")).toBe(true);
    expect(runtime.beginReview("call-1")).toBe(false);
    expect(() => runtime.activate("auto", { idle: true })).toThrow(/approval/i);
    runtime.endReview("call-1");
    runtime.endReview("call-2");
    expect(runtime.activate("auto", { idle: true })).toBe("auto");
  });

  it("serializes human dialogs", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    expect(runtime.beginHumanApproval()).toBe(true);
    expect(runtime.beginHumanApproval()).toBe(false);
    runtime.endHumanApproval();
    expect(runtime.beginHumanApproval()).toBe(true);
  });
});
