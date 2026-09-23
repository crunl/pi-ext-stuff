import { describe, expect, it } from "vitest";

import {
  commandExitCode,
  completedIfCommandRan,
  runtimeDenialFromEvidence,
} from "../src/bash-outcome.ts";

describe("completedIfCommandRan", () => {
  const slot = (code: number | null | undefined) => ({ code });

  it("stays a failure when no exit code was captured (infrastructure error)", () => {
    expect(
      completedIfCommandRan(new Error("infra"), new Error("infra"), slot(undefined)),
    ).toBeUndefined();
  });

  it("stays a failure on exit 0 (post-exec infrastructure error)", () => {
    const status = new Error("boom\n\nCommand exited with code 0");
    expect(completedIfCommandRan(status, status, slot(0))).toBeUndefined();
  });

  it("returns the presented error when the status matches the captured exit code", () => {
    const status = new Error("boom\n\nCommand exited with code 2");
    const presented = new Error("boom\n\nCommand exited with code 2\n\nSRT diagnostic");
    expect(completedIfCommandRan(status, presented, slot(2))).toEqual({
      content: [{ type: "text", text: "boom\n\nCommand exited with code 2\n\nSRT diagnostic" }],
      details: { exitCode: 2 },
    });
  });

  it("stays a failure when the status is a later infrastructure error, not the exit code", () => {
    expect(
      completedIfCommandRan(new Error("some later failure"), new Error("x"), slot(2)),
    ).toBeUndefined();
  });

  it("handles a null exit code (no exit code reported)", () => {
    const status = new Error("boom\n\nCommand terminated without an exit code");
    expect(completedIfCommandRan(status, status, slot(null))).toEqual({
      content: [{ type: "text", text: "boom\n\nCommand terminated without an exit code" }],
      details: { exitCode: null },
    });
  });
});

describe("commandExitCode", () => {
  it("reads the status a completed command carries", () => {
    expect(commandExitCode({ exitCode: 2 })).toBe(2);
    expect(commandExitCode({ exitCode: 0 })).toBe(0);
    expect(commandExitCode({ exitCode: null })).toBeNull();
  });

  it("reports no status for pi's own success details or a missing result", () => {
    expect(commandExitCode({ truncation: undefined })).toBeUndefined();
    expect(commandExitCode(undefined)).toBeUndefined();
    expect(commandExitCode(null)).toBeUndefined();
    expect(commandExitCode({ exitCode: "2" })).toBeUndefined();
  });
});

describe("runtimeDenialFromEvidence", () => {
  const fsCapability = { kind: "filesystem", operation: "write", path: "/x" } as const;

  it("returns undefined when the evidence does not look like a sandbox denial", () => {
    expect(runtimeDenialFromEvidence("some unrelated error", fsCapability)).toBeUndefined();
  });

  it("returns undefined without a capability", () => {
    expect(runtimeDenialFromEvidence("Operation not permitted", undefined)).toBeUndefined();
  });

  it("returns undefined for a network denial (not replayable)", () => {
    expect(
      runtimeDenialFromEvidence("Operation not permitted", {
        kind: "network",
        host: "example.com",
      }),
    ).toBeUndefined();
  });

  it("classifies a filesystem write denial", () => {
    expect(runtimeDenialFromEvidence("EPERM original failure", fsCapability)).toEqual({
      kind: "capability-denied",
      request: fsCapability,
      detail:
        "Sandbox enforcement denied writing /x during execution\nOriginal error: EPERM original failure",
    });
  });
});
