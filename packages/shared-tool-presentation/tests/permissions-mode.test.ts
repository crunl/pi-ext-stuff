import { describe, expect, it } from "vitest";
import {
  isPermissionsModeEvent,
  PermissionsModeState,
} from "../src/permissions-mode.ts";

describe("isPermissionsModeEvent", () => {
  it("accepts structured mode events", () => {
    expect(
      isPermissionsModeEvent({ mode: "yolo", label: "Full bypass", severity: "error" }),
    ).toBe(true);
  });

  it("rejects events without severity or with an unknown severity", () => {
    expect(isPermissionsModeEvent({ mode: "yolo", label: "Full bypass" })).toBe(false);
    expect(
      isPermissionsModeEvent({ mode: "yolo", label: "Full bypass", severity: "fatal" }),
    ).toBe(false);
    expect(isPermissionsModeEvent(undefined)).toBe(false);
    expect(isPermissionsModeEvent("full bypass")).toBe(false);
  });
});

describe("PermissionsModeState", () => {
  it("starts hidden with severity none", () => {
    const state = new PermissionsModeState();
    expect(state.get()).toBeUndefined();
    expect(state.severity()).toBe("none");
    // A none event is not a state change.
    expect(
      state.applyEvent({ mode: "default", label: "default", severity: "none" }),
    ).toBe(false);
  });

  it("shows the label for its severity and hides on none", () => {
    const state = new PermissionsModeState();
    expect(
      state.applyEvent({ mode: "yolo", label: "Full bypass", severity: "error" }),
    ).toBe(true);
    expect(state.get()).toBe("Full bypass");
    expect(state.severity()).toBe("error");

    // Renamed label with same severity still renders — no string coupling.
    expect(
      state.applyEvent({ mode: "yolo", label: "renamed later", severity: "error" }),
    ).toBe(true);
    expect(state.get()).toBe("renamed later");
  });

  it("reports only distinct changes and resets once", () => {
    const state = new PermissionsModeState();
    const event = {
      mode: "auto",
      label: "approve for me",
      severity: "warning",
    } as const;
    expect(state.applyEvent(event)).toBe(true);
    expect(state.applyEvent(event)).toBe(false);
    expect(state.reset()).toBe(true);
    expect(state.reset()).toBe(false);
  });
});
