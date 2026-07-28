import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  fingerprintConfig,
  mergePermissionsConfig,
  validatePermissionsConfig,
} from "../src/config.ts";

describe("permissions config", () => {
  it("defaults to sandboxed default mode", () => {
    expect(DEFAULT_CONFIG.defaultMode).toBe("default");
    expect(DEFAULT_CONFIG.sandbox.enabled).toBe(true);
    expect(DEFAULT_CONFIG.sandbox.filesystem.allowWrite).toEqual([".", "/tmp"]);
  });

  it("does not let a project allow override a global deny", () => {
    const merged = mergePermissionsConfig(
      { ...DEFAULT_CONFIG, rules: [{ action: "deny", tool: "bash", pattern: "git push*" }] },
      { rules: [{ action: "allow", tool: "bash", pattern: "git push origin feature" }] },
    );
    expect(merged.rules[0]?.action).toBe("deny");
  });

  it("rejects an unknown mode", () => {
    expect(() => validatePermissionsConfig({ version: 1, defaultMode: "yolo" })).toThrow(/defaultMode/);
  });

  it("produces stable fingerprints", () => {
    expect(fingerprintConfig(DEFAULT_CONFIG)).toBe(fingerprintConfig(structuredClone(DEFAULT_CONFIG)));
  });
});
