import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PermissionModeRuntime } from "../src/mode-runtime.ts";

describe("PermissionModeRuntime", () => {
  it("activates Auto, resets pause state, persists, and reports compact status", () => {
    const appendEntry = vi.fn();
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, appendEntry);
    runtime.applyAutoState({ consecutiveDenials: 3, paused: true });

    expect(runtime.activate("auto")).toBe("auto");
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

  it("permits immediate transitions while preserving parallel active review IDs", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    expect(runtime.beginReview("call-1")).toBe(true);
    expect(runtime.beginReview("call-2")).toBe(true);
    expect(runtime.beginReview("call-1")).toBe(false);
    expect(runtime.activate("auto")).toBe("auto");
    runtime.endReview("call-1");
    runtime.endReview("call-2");
  });

  it("serializes human dialogs", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    expect(runtime.beginHumanApproval()).toBe(true);
    expect(runtime.beginHumanApproval()).toBe(false);
    runtime.endHumanApproval();
    expect(runtime.beginHumanApproval()).toBe(true);
  });

  it("cycles immediately while working", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.beginReview("active-review");

    expect(runtime.cycle()).toBe("auto");
    expect(runtime.cycle()).toBe("default");
  });

  it("switches from Auto to Default immediately while a review remains active", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.beginReview("active-review");

    expect(runtime.activate("default")).toBe("default");
    expect(runtime.mode).toBe("default");
    runtime.endReview("active-review");
  });

  it("pauses after ten denials in the rolling fifty-review window", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");

    for (let index = 0; index < 9; index += 1) {
      runtime.recordAutoReview("deny", 3);
      runtime.recordAutoReview("approve", 3);
    }
    expect(runtime.autoState.paused).toBe(false);

    expect(runtime.recordAutoReview("deny", 3)).toEqual({
      consecutiveDenials: 1,
      paused: true,
    });
  });

  it("starts each agent turn with a fresh Auto rejection circuit", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.recordAutoReview("deny", 3);
    runtime.recordAutoReview("deny", 3);
    runtime.recordAutoReview("deny", 3);
    expect(runtime.autoState.paused).toBe(true);

    runtime.beginAgentTurn();

    expect(runtime.autoState).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
  });

  it("resets consecutive denials after a non-denial reviewer failure", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.recordAutoReview("deny", 3);
    runtime.recordAutoReview("deny", 3);

    runtime.recordAutoNonDenial();

    expect(runtime.recordAutoReview("deny", 3)).toEqual({
      consecutiveDenials: 1,
      paused: false,
    });
  });

  it("counts reviewer failures in the rolling fifty-review window", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    for (let index = 0; index < 9; index += 1) {
      runtime.recordAutoReview("deny", 3);
      runtime.recordAutoNonDenial();
    }
    for (let index = 0; index < 50; index += 1) {
      runtime.recordAutoNonDenial();
    }

    expect(runtime.recordAutoReview("deny", 3)).toEqual({
      consecutiveDenials: 1,
      paused: false,
    });
  });

  it("discards a legacy persisted pending transition", () => {
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

    expect(runtime.mode).toBe("default");
    expect(runtime.snapshot()).not.toHaveProperty("pendingMode");
  });

  it("does not activate the unimplemented Plan mode from configuration or persisted state", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.defaultMode = "plan";
    const runtime = new PermissionModeRuntime(config, vi.fn());

    expect(runtime.mode).toBe("default");
    expect(runtime.statusLabel).toBe("Default");
    expect(() => runtime.activate("plan")).toThrow(
      "Plan mode is not implemented",
    );
  });
});
