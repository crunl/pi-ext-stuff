import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type LoadedSafetyConfig } from "../src/config.ts";
import type { PermissionModeRuntime } from "../src/mode-runtime.ts";
import {
  type ActivationRecord,
  createRegistrationScopedState,
  createReloadScopedState,
  createTurnScopedState,
} from "../src/register-state.ts";

/**
 * Each factory is exercised only through its own interface. These tests are
 * written against the lifetime invariants, not against the fields behind them:
 * nothing here can reach a closure variable, so an implementation that keeps the
 * invariant a different way still passes.
 */

function loadedConfig(source: LoadedSafetyConfig["source"] = "default"): LoadedSafetyConfig {
  return { config: DEFAULT_CONFIG, source };
}

function record(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    loaded: loadedConfig(),
    key: "key-a",
    baseSandboxConfig: undefined,
    ...overrides,
  };
}

const READY = { kind: "ready", profile: "workspace-write" } as const;

describe("reload-scoped state", () => {
  it("holds no activation before the first commit", () => {
    const state = createReloadScopedState();
    expect(state.activation()).toBeUndefined();
    expect(state.isLive("key-a")).toBe(false);
    expect(state.sandboxState()).toEqual({ kind: "pending" });
    expect(state.modeRuntime()).toBeUndefined();
  });

  it("publishes an activation atomically, never field by field", () => {
    const state = createReloadScopedState();
    const committed = record();
    state.commit(committed, READY);
    expect(state.activation()).toEqual(committed);
    expect(state.isLive("key-a")).toBe(true);
    expect(state.isLive("key-b")).toBe(false);
    expect(state.sandboxState()).toEqual({ kind: "ready", profile: "workspace-write" });
    // A key read hands back the whole record or nothing.
    expect(state.liveFor("key-a")).toEqual(committed);
    expect(state.liveFor("key-b")).toBeUndefined();
  });

  it("clears both failure latches on a commit", () => {
    const state = createReloadScopedState();
    state.recordConfigFailure(new Error("unreadable"));
    expect(state.configFailure()).toBeInstanceOf(Error);
    state.commit(record(), READY);
    expect(state.configFailure()).toBeUndefined();
  });

  it("latches a config failure until the next successful activation", () => {
    const state = createReloadScopedState();
    const failure = new Error("unreadable");
    state.recordConfigFailure(failure);
    expect(state.configFailure()).toBe(failure);
  });

  it("keeps an activation failure scoped to the key that failed", () => {
    const state = createReloadScopedState();
    const failure = new Error("backend down");
    state.rollback(undefined, "key-a", failure, { kind: "failed", error: "backend down" });
    expect(state.activationFailure("key-a")).toBe(failure);
    // A different key still gets its own attempt.
    expect(state.activationFailure("key-b")).toBeUndefined();
    expect(state.activation()).toBeUndefined();
  });

  it("restores the previous activation exactly on a rollback", () => {
    const state = createReloadScopedState();
    const previous = record({ key: "key-a" });
    state.commit(previous, READY);
    const failure = new Error("activation failed");
    state.rollback(previous, "key-b", failure, { kind: "ready", profile: "workspace-write" });
    expect(state.activation()).toEqual(previous);
    expect(state.isLive("key-a")).toBe(true);
    // The previous activation is live again, so nothing is latched.
    expect(state.activationFailure("key-b")).toBeUndefined();
  });

  it("reports the backend the rollback actually left, not the restored record's", () => {
    const state = createReloadScopedState();
    const previous = record({ key: "key-a" });
    state.commit(previous, READY);
    // The reload failed and its re-activation of the previous sandbox failed too.
    state.rollback(previous, "key-b", new Error("activation failed"), {
      kind: "failed",
      error: "rollback failed: backend gone",
    });
    // The config is live again, but the backend is not: readiness has to follow
    // the backend, or every later cache read answers for a dead sandbox.
    expect(state.isLive("key-a")).toBe(true);
    expect(state.sandboxState()).toEqual({
      kind: "failed",
      error: "rollback failed: backend gone",
    });
  });

  it("records how a failed first activation left the backend", () => {
    const state = createReloadScopedState();
    state.rollback(undefined, "key-a", new Error("down"), {
      kind: "failed",
      error: "rollback failed",
    });
    // No config is live, but the sandbox state still reports the failure so the
    // notice can say the previous sandbox could not be restored.
    expect(state.activation()).toBeUndefined();
    expect(state.sandboxState()).toEqual({ kind: "failed", error: "rollback failed" });
  });

  it("moves the sandbox pair under an unchanged config", () => {
    const state = createReloadScopedState();
    state.commit(record(), READY);
    state.publishSandbox({ kind: "disabled" }, undefined);
    expect(state.sandboxState()).toEqual({ kind: "disabled" });
    expect(state.baseSandboxConfig()).toBeUndefined();
    // The config itself did not move.
    expect(state.isLive("key-a")).toBe(true);
  });

  it("installs the mode runtime once and hands back the same instance", () => {
    const state = createReloadScopedState();
    const created = { mode: "auto" } as PermissionModeRuntime;
    const create = vi.fn(() => created);
    expect(state.ensureModeRuntime(create)).toBe(created);
    expect(state.ensureModeRuntime(create)).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    expect(state.modeRuntime()).toBe(created);
    // A replace is wholesale, not a mutation of the previous runtime.
    const replacement = { mode: "yolo" } as PermissionModeRuntime;
    state.installModeRuntime(replacement);
    expect(state.modeRuntime()).toBe(replacement);
  });
});

describe("turn-scoped state", () => {
  it("starts with nothing outstanding", () => {
    const state = createTurnScopedState();
    expect(state.pending()).toBe(false);
    expect(state.pendingAgainst("auto")).toBeUndefined();
  });

  it("reports the requested mode only while the flag is set", () => {
    const state = createTurnScopedState();
    state.request("yolo");
    expect(state.pending()).toBe(true);
    expect(state.pendingAgainst("auto")).toBe("yolo");
    // A request for the mode already applied is not something to show.
    expect(state.pendingAgainst("yolo")).toBeUndefined();
  });

  it("clears the flag and the value together", () => {
    const state = createTurnScopedState();
    state.request("yolo");
    state.clear();
    expect(state.pending()).toBe(false);
    expect(state.pendingAgainst("auto")).toBeUndefined();
    // A second clear is a no-op rather than an error.
    state.clear();
    expect(state.pending()).toBe(false);
  });

  it("drops the request at agent_start without leaving it readable", () => {
    const state = createTurnScopedState();
    state.request("yolo");
    // The documented exception: the flag alone is cleared, because the host is
    // discarding the turn the request belonged to.
    state.alignAtAgentStart();
    expect(state.pending()).toBe(false);
    expect(state.pendingAgainst("auto")).toBeUndefined();
    // The stale value must not resurface after a later request is cleared.
    state.request("auto");
    state.clear();
    expect(state.pendingAgainst("yolo")).toBeUndefined();
  });

  it("cannot expose a stale value once its flag is gone", () => {
    const state = createTurnScopedState();
    state.request("yolo");
    state.alignAtAgentStart();
    // Reading against every possible applied mode never leaks the dropped value.
    for (const applied of ["auto", "yolo", undefined] as const) {
      expect(state.pendingAgainst(applied)).toBeUndefined();
    }
  });
});

describe("registration-scoped state", () => {
  it("claims the shell-parser notice exactly once per registration", () => {
    const state = createRegistrationScopedState();
    expect(state.claimShellParserFailureNotice()).toBe(true);
    expect(state.claimShellParserFailureNotice()).toBe(false);
  });

  it("claims each reviewer fallback key exactly once", () => {
    const state = createRegistrationScopedState();
    expect(state.claimGuardianFallbackNotice("a")).toBe(true);
    expect(state.claimGuardianFallbackNotice("a")).toBe(false);
    expect(state.claimGuardianFallbackNotice("b")).toBe(true);
  });

  it("does not share notice memory between two registrations", () => {
    const first = createRegistrationScopedState();
    const second = createRegistrationScopedState();
    expect(first.claimGuardianFallbackNotice("a")).toBe(true);
    // A reload must show the fallback notice again rather than swallow it.
    expect(second.claimGuardianFallbackNotice("a")).toBe(true);
    expect(second.claimShellParserFailureNotice()).toBe(true);
  });
});
