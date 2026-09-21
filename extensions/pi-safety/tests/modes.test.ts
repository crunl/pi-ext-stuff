import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, fingerprintConfig } from "../src/config.ts";
import { ModeController } from "../src/modes/controller.ts";
import {
  createPermissionSessionState,
  persistPermissionState,
  reducePermissionEntries,
  restorePermissionState,
} from "../src/state.ts";

describe("ModeController", () => {
  it("cycles between Auto and YOLO immediately", () => {
    const controller = new ModeController("auto");
    expect(controller.cycle()).toBe("yolo");
    expect(controller.cycle()).toBe("auto");
  });

  it("applies a transition immediately", () => {
    const controller = new ModeController("auto");
    expect(controller.request("yolo")).toBe("yolo");
    expect(controller.active).toBe("yolo");
    expect(controller.request("auto")).toBe("auto");
    expect(controller.active).toBe("auto");
  });
});

describe("permission session state", () => {
  it("persists state as a pi-safety-state entry", () => {
    const calls: Array<[string, unknown]> = [];
    const state = reducePermissionEntries([], DEFAULT_CONFIG);

    persistPermissionState({ appendEntry: (type, data) => calls.push([type, data]) }, state);

    expect(calls).toEqual([["pi-safety-state", state]]);
  });

  it("restores the last valid state entry, coercing legacy modes to auto", () => {
    const malformed: unknown[] = [];
    const first = {
      mode: "plan" as string,
      auto: { consecutiveDenials: 1, paused: false },
      sandboxProfile: "workspace-write" as const,
      configFingerprint: fingerprintConfig(DEFAULT_CONFIG),
    };
    const latest = {
      ...first,
      mode: "auto" as const,
      auto: { consecutiveDenials: 2, paused: true },
    };

    const state = reducePermissionEntries(
      [
        { type: "custom", customType: "pi-safety-state", data: first },
        { type: "custom", customType: "pi-safety-state", data: { mode: "invalid" } },
        { type: "custom", customType: "pi-safety-state", data: latest },
      ],
      DEFAULT_CONFIG,
      (entry) => malformed.push(entry),
    );

    expect(state).toEqual(latest);
    expect(malformed).toHaveLength(1);

    // A session persisted with a removed default/plan mode restores as auto.
    const legacyOnly = reducePermissionEntries(
      [{ type: "custom", customType: "pi-safety-state", data: first }],
      DEFAULT_CONFIG,
    );
    expect(legacyOnly.mode).toBe("auto");
    expect(legacyOnly.auto.consecutiveDenials).toBe(1);
  });

  it("restores a persisted YOLO session state", () => {
    const state = {
      ...createPermissionSessionState(DEFAULT_CONFIG),
      mode: "yolo" as const,
    };

    expect(
      reducePermissionEntries(
        [{ type: "custom", customType: "pi-safety-state", data: state }],
        DEFAULT_CONFIG,
      ),
    ).toEqual(state);
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
        [{ type: "custom", customType: "pi-safety-state", data: stale }],
        changed,
      ),
    ).toEqual(createPermissionSessionState(changed));
  });
});
