import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PermissionModeRuntime } from "../src/mode-runtime.ts";
import { nextMode } from "../src/register-support.ts";

function stateEntry(
  mode: "auto" | "yolo" | (string & {}),
  configFingerprint: string,
  auto = { consecutiveDenials: 0, paused: false },
): unknown {
  return {
    type: "custom",
    customType: "pi-safety-state",
    data: {
      mode,
      auto,
      sandboxProfile: "workspace-write",
      configFingerprint,
    },
  };
}

describe("PermissionModeRuntime", () => {
  it("starts in Auto with a fresh persisted state shape", () => {
    const appendEntry = vi.fn();
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, appendEntry);

    expect(runtime.mode).toBe("auto");
    expect(runtime.autoState).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
    expect(runtime.statusLabel).toBe("Approve for me");
    expect(runtime.statusSeverity).toBe("warning");
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("maps Engine Auto state without persisting recentDenials", () => {
    const appendEntry = vi.fn();
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, appendEntry);

    runtime.applyAutoState({ consecutiveDenials: 2, paused: true, recentDenials: 7 });

    expect(runtime.autoState).toEqual({
      consecutiveDenials: 2,
      paused: true,
    });
    const persisted = appendEntry.mock.calls.at(-1)?.[1];
    expect(persisted).toEqual(
      expect.objectContaining({
        auto: { consecutiveDenials: 2, paused: true },
      }),
    );
    if (typeof persisted !== "object" || persisted === null || !("auto" in persisted)) {
      throw new Error("mode state was not persisted");
    }
    const auto = persisted.auto;
    expect(typeof auto).toBe("object");
    expect(auto).not.toHaveProperty("recentDenials");
  });

  it("resets Engine breaker state at the beginning of a new turn", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.applyAutoState({ consecutiveDenials: 3, paused: true, recentDenials: 10 });

    runtime.beginAgentTurn();

    expect(runtime.autoState).toEqual({
      consecutiveDenials: 0,
      paused: false,
    });
  });

  it("resets Auto state on activate unless the active turn asks to preserve it", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    runtime.applyAutoState({ consecutiveDenials: 3, paused: true });

    expect(runtime.activate("auto")).toBe("auto");
    expect(runtime.autoState).toEqual({ consecutiveDenials: 0, paused: false });

    runtime.applyAutoState({ consecutiveDenials: 2, paused: true });
    expect(runtime.activate("yolo", { preserveAutoTransientState: true })).toBe("yolo");
    expect(runtime.activate("auto", { preserveAutoTransientState: true })).toBe("auto");
    expect(runtime.autoState).toEqual({ consecutiveDenials: 2, paused: true });
  });

  it("toggles modes via activate while preserving persistence and resetting Auto on return", () => {
    // Production toggles via nextMode()+activate (the runtime.cycle shortcut
    // is gone): same observable contract — yolo keeps transient Auto state,
    // returning to auto without preservation resets it.
    const appendEntry = vi.fn();
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, appendEntry);
    runtime.applyAutoState({ consecutiveDenials: 1, paused: false });

    expect(runtime.activate(nextMode(runtime.mode))).toBe("yolo");
    expect(runtime.statusLabel).toBe("Bypass permissions");
    expect(runtime.statusSeverity).toBe("error");
    expect(runtime.activate(nextMode(runtime.mode))).toBe("auto");
    expect(runtime.autoState).toEqual({ consecutiveDenials: 0, paused: false });
    expect(appendEntry).toHaveBeenLastCalledWith(
      "pi-safety-state",
      expect.objectContaining({ mode: "auto" }),
    );
  });

  it("restores the persisted mode and state without a pendingMode field", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    const configFingerprint = runtime.snapshot().configFingerprint;

    runtime.restore(
      [
        stateEntry("yolo", configFingerprint, {
          consecutiveDenials: 2,
          paused: true,
        }),
      ],
      DEFAULT_CONFIG,
    );

    expect(runtime.mode).toBe("yolo");
    expect(runtime.autoState).toEqual({
      consecutiveDenials: 2,
      paused: true,
    });
    expect(runtime.snapshot()).not.toHaveProperty("pendingMode");
  });

  it("coerces an unsupported persisted mode to auto during restore", () => {
    const runtime = new PermissionModeRuntime(DEFAULT_CONFIG, vi.fn());
    const configFingerprint = runtime.snapshot().configFingerprint;

    runtime.restore([stateEntry("unsupported", configFingerprint)], DEFAULT_CONFIG);

    expect(runtime.mode).toBe("auto");
  });
});
