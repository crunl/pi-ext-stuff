import { describe, expect, it } from "vitest";
import { recordAutoDecision } from "../src/modes/auto.ts";
import { ModeController } from "../src/modes/controller.ts";
import {
  createPermissionSessionState,
  persistPermissionState,
  reducePermissionEntries,
  restorePermissionState,
} from "../src/state.ts";
import { DEFAULT_CONFIG, fingerprintConfig } from "../src/config.ts";

describe("ModeController", () => {
  it("cycles only functional Default and Auto modes", () => {
    const controller = new ModeController("default");
    expect(controller.cycle({ idle: true })).toBe("auto");
    expect(controller.cycle({ idle: true })).toBe("default");
  });

  it("queues a transition while busy", () => {
    const controller = new ModeController("default");
    expect(controller.request("plan", { idle: false, approvalActive: false })).toEqual({
      active: "default",
      pending: "plan",
    });
    expect(controller.flushPending({ idle: true, approvalActive: false })).toBe("plan");
  });

  it("retains a pending transition when flushed while busy", () => {
    const controller = new ModeController("default");
    controller.request("plan", { idle: false, approvalActive: false });

    expect(controller.flushPending({ idle: false, approvalActive: false })).toBe("default");
    expect(controller.pending).toBe("plan");
  });

  it("retains a pending transition when flushed during approval", () => {
    const controller = new ModeController("default");
    controller.request("plan", { idle: false, approvalActive: false });

    expect(controller.flushPending({ idle: true, approvalActive: true })).toBe("default");
    expect(controller.pending).toBe("plan");
  });

  it("lets a second busy cycle cancel the pending transition", () => {
    const controller = new ModeController("default");

    expect(controller.cycle({ idle: false, approvalActive: true })).toEqual({
      active: "default",
      pending: "auto",
    });
    expect(controller.cycle({ idle: false, approvalActive: true })).toEqual({
      active: "default",
      pending: undefined,
    });
    expect(controller.pending).toBeUndefined();
  });

  it("does not change mode during approval", () => {
    const controller = new ModeController("auto");
    expect(() => controller.request("default", { idle: true, approvalActive: true })).toThrow(/approval/);
  });
});

describe("permission session state", () => {
  it("persists state as a pi-permissions-state entry", () => {
    const calls: Array<[string, unknown]> = [];
    const state = reducePermissionEntries([], DEFAULT_CONFIG);

    persistPermissionState({ appendEntry: (type, data) => calls.push([type, data]) }, state);

    expect(calls).toEqual([["pi-permissions-state", state]]);
  });

  it("restores the last valid state entry and reports malformed entries", () => {
    const malformed: unknown[] = [];
    const first = {
      mode: "plan" as const,
      auto: { consecutiveDenials: 1, paused: false },
      sandboxProfile: "workspace-write" as const,
      configFingerprint: fingerprintConfig(DEFAULT_CONFIG),
    };
    const latest = { ...first, mode: "auto" as const, auto: { consecutiveDenials: 2, paused: true } };

    const state = reducePermissionEntries(
      [
        { type: "custom", customType: "pi-permissions-state", data: first },
        { type: "custom", customType: "pi-permissions-state", data: { mode: "invalid" } },
        { type: "custom", customType: "pi-permissions-state", data: latest },
      ],
      DEFAULT_CONFIG,
      (entry) => malformed.push(entry),
    );

    expect(state).toEqual(latest);
    expect(malformed).toHaveLength(1);
  });

  it("discards persisted state from a different config fingerprint", () => {
    const changed = structuredClone(DEFAULT_CONFIG);
    changed.sandbox.profile = "read-only";
    const stale = {
      mode: "auto" as const,
      auto: { consecutiveDenials: 2, paused: true },
      sandboxProfile: "workspace-write" as const,
      configFingerprint: fingerprintConfig(DEFAULT_CONFIG),
    };

    expect(
      restorePermissionState(
        [{ type: "custom", customType: "pi-permissions-state", data: stale }],
        changed,
      ),
    ).toEqual(createPermissionSessionState(changed));
  });
});

describe("recordAutoDecision", () => {
  it("resets consecutive denials after approval", () => {
    expect(recordAutoDecision({ consecutiveDenials: 2, paused: true }, "approve", 3)).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
  });

  it("pauses on the third denial", () => {
    expect(recordAutoDecision({ consecutiveDenials: 2, paused: false }, "deny", 3)).toEqual({
      consecutiveDenials: 3,
      paused: true,
    });
  });
});
