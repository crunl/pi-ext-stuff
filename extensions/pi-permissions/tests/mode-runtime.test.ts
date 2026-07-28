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

  it("uses the pending mode when cycling again while working", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.beginReview("active-review");

    expect(runtime.cycle({ idle: false })).toEqual({
      active: "default",
      pending: "auto",
    });
    expect(runtime.cycle({ idle: false })).toEqual({
      active: "default",
      pending: undefined,
    });
  });

  it("keeps Auto active until a working transition can settle", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto", { idle: true });
    runtime.beginReview("active-review");

    expect(runtime.activate("default", { idle: false })).toEqual({
      active: "auto",
      pending: "default",
    });
    expect(runtime.mode).toBe("auto");
    expect(runtime.flushPending({ idle: true })).toBe("auto");

    runtime.endReview("active-review");
    expect(runtime.flushPending({ idle: true })).toBe("default");
  });

  it("restores a persisted pending transition and flushes it when settled", () => {
    const pendingState = {
      mode: "default" as const,
      pendingMode: "auto" as const,
      auto: { consecutiveDenials: 0, paused: false },
      sandboxProfile: "workspace-write" as const,
      configFingerprint: new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn())
        .snapshot().configFingerprint,
    };
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.restore(
      [{
        type: "custom",
        customType: "pi-permissions-state",
        data: pendingState,
      }],
      DEFAULT_CONFIG,
    );

    expect(runtime.flushPending({ idle: true })).toBe("auto");
    expect(runtime.snapshot().pendingMode).toBeUndefined();
  });

  it("does not activate the unimplemented Plan mode from configuration or persisted state", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.defaultMode = "plan";
    const runtime = new PermissionModeRuntime(config, vi.fn());

    expect(runtime.mode).toBe("default");
    expect(runtime.statusLabel).toBe("Default");
    expect(() => runtime.activate("plan", { idle: true })).toThrow(
      "Plan mode is not implemented",
    );
  });
});
