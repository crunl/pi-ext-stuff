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
    expect(runtime.statusLabel).toBe("approve for me");
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

  it("serializes human dialogs with cancellation-safe tokens", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    const first = runtime.beginHumanApproval();
    expect(first).toEqual(expect.any(Number));
    expect(runtime.beginHumanApproval()).toBeUndefined();

    runtime.cancelReviews();
    const second = runtime.beginHumanApproval();
    expect(second).toEqual(expect.any(Number));
    expect(second).not.toBe(first);

    runtime.endHumanApproval(first!);
    expect(runtime.beginHumanApproval()).toBeUndefined();
    runtime.endHumanApproval(second!);
    expect(runtime.beginHumanApproval()).toEqual(expect.any(Number));
  });

  it("cycles immediately while working", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.beginReview("active-review");

    expect(runtime.cycle()).toBe("auto");
    expect(runtime.cycle()).toBe("yolo");
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
      runtime.recordAutoReview("deny");
      runtime.recordAutoReview("approve");
    }
    expect(runtime.autoState.paused).toBe(false);

    expect(runtime.recordAutoReview("deny")).toEqual({
      consecutiveDenials: 1,
      paused: true,
    });
  });

  it("starts each agent turn with a fresh Auto rejection circuit", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.recordAutoReview("deny");
    runtime.recordAutoReview("deny");
    runtime.recordAutoReview("deny");
    expect(runtime.autoState.paused).toBe(true);

    runtime.beginAgentTurn();

    expect(runtime.autoState).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
  });

  it("preserves the Auto circuit breaker when an active turn cycles back to Auto", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.recordAutoReview("deny");
    runtime.recordAutoReview("deny");
    runtime.recordAutoReview("deny");

    runtime.activate("yolo", { preserveAutoTransientState: true });
    runtime.activate("default", { preserveAutoTransientState: true });
    runtime.activate("auto", { preserveAutoTransientState: true });

    expect(runtime.autoState).toEqual({ consecutiveDenials: 3, paused: true });

    runtime.beginAgentTurn();

    expect(runtime.autoState).toEqual({ consecutiveDenials: 0, paused: false });
  });

  it("preserves the rolling Auto denial window when an active turn returns to Auto", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    for (let index = 0; index < 9; index += 1) {
      runtime.recordAutoReview("deny");
      runtime.recordAutoReview("approve");
    }

    runtime.activate("yolo", { preserveAutoTransientState: true });
    runtime.activate("default", { preserveAutoTransientState: true });
    runtime.activate("auto", { preserveAutoTransientState: true });

    expect(runtime.recordAutoReview("deny")).toEqual({ consecutiveDenials: 1, paused: true });
  });

  it("resets consecutive denials after a non-denial reviewer failure", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    runtime.recordAutoReview("deny");
    runtime.recordAutoReview("deny");

    runtime.recordAutoNonDenial();

    expect(runtime.recordAutoReview("deny")).toEqual({
      consecutiveDenials: 1,
      paused: false,
    });
  });

  it("counts reviewer failures in the rolling fifty-review window", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.activate("auto");
    for (let index = 0; index < 9; index += 1) {
      runtime.recordAutoReview("deny");
      runtime.recordAutoNonDenial();
    }
    for (let index = 0; index < 50; index += 1) {
      runtime.recordAutoNonDenial();
    }

    expect(runtime.recordAutoReview("deny")).toEqual({
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
      configFingerprint: new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn()).snapshot()
        .configFingerprint,
    };
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.restore(
      [
        {
          type: "custom",
          customType: "pi-permissions-state",
          data: pendingState,
        },
      ],
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
    expect(runtime.statusLabel).toBe("default");
    expect(() => runtime.activate("plan")).toThrow("Plan mode is not implemented");
  });

  it("activates and reports YOLO without mutating Auto state", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.applyAutoState({ consecutiveDenials: 2, paused: true });

    expect(runtime.activate("yolo")).toBe("yolo");
    expect(runtime.statusLabel).toBe("full bypass");
    expect(runtime.autoState).toEqual({ consecutiveDenials: 2, paused: true });
  });
});
