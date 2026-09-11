import { describe, expect, it, vi } from "vitest";
import { PermissionSession } from "../src/permission-session.ts";

describe("PermissionSession turn lifecycle", () => {
  it("tracks snapshot currency through begin, finish, between, settle, and reset", () => {
    const session = new PermissionSession();
    const turnId = session.allocateTurnId();
    const snapshot = {
      turnId,
      mode: "auto" as const,
      config: {} as never,
      sandboxReady: true,
    };

    session.beginTurn(turnId);
    session.setExecutionSnapshot(snapshot);
    expect(session.getTurnPhase()).toBe("active");
    expect(session.isCurrentTurn(turnId)).toBe(true);
    expect(session.currentExecutionSnapshot()).toBe(snapshot);
    expect(session.finishTurn()).toBe(turnId);
    expect(session.getTurnPhase()).toBe("between");
    expect(session.getExecutionSnapshot()).toBeUndefined();
    expect(session.currentExecutionSnapshot()).toBeUndefined();

    session.settleBetween();
    expect(session.getTurnPhase()).toBe("idle");
    expect(session.finishTurn()).toBeUndefined();

    const nextTurn = session.allocateTurnId();
    session.beginTurn(nextTurn);
    session.setExecutionSnapshot({ ...snapshot, turnId: nextTurn });
    session.resetTurn();
    expect(session.getTurnPhase()).toBe("idle");
    expect(session.getExecutionSnapshot()).toBeUndefined();
    expect(session.isCurrentTurn(nextTurn)).toBe(false);
  });

  it("records and clears observed host lifecycle events", () => {
    const session = new PermissionSession();
    expect(session.hasObservedLifecycle()).toBe(false);
    session.markLifecycleEvent();
    expect(session.hasObservedLifecycle()).toBe(true);
    session.clearLifecycleEvents();
    expect(session.hasObservedLifecycle()).toBe(false);
  });
});

describe("PermissionSession mode-transition barriers", () => {
  it("settles, cancels, and replaces barriers without clearing a newer one", async () => {
    const session = new PermissionSession();
    const settled = session.createBarrier();
    expect(session.hasInFlightBarrier()).toBe(true);
    expect(session.getInFlightBarrier()).toBe(settled);
    session.settleBarrier(settled, true);
    await expect(settled.completion).resolves.toBe(true);
    expect(session.hasInFlightBarrier()).toBe(false);
    session.settleBarrier(settled, false);
    await expect(settled.completion).resolves.toBe(true);

    const cancelled = session.createBarrier();
    session.cancelInFlightBarrier();
    await expect(cancelled.completion).resolves.toBe(false);
    expect(session.hasInFlightBarrier()).toBe(false);

    const first = session.createBarrier();
    const replacement = session.createBarrier();
    session.clearInFlightIfCurrent(first);
    expect(session.getInFlightBarrier()).toBe(replacement);
    session.settleBarrier(first, true);
    await expect(first.completion).resolves.toBe(true);
    expect(session.getInFlightBarrier()).toBe(replacement);
    session.settleBarrier(replacement, false);
    await expect(replacement.completion).resolves.toBe(false);
    expect(session.hasInFlightBarrier()).toBe(true);
    session.cancelInFlightBarrier();
    expect(session.hasInFlightBarrier()).toBe(false);
  });
});

describe("PermissionSession mode mutation queue", () => {
  it("serializes operations in enqueue order", async () => {
    const session = new PermissionSession();
    let releaseFirst: (() => void) | undefined;
    const order: string[] = [];
    const first = session.runModeMutation(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return "first";
    });
    const second = session.runModeMutation(async () => {
      order.push("second");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("discards an operation whose generation became stale before execution", async () => {
    const session = new PermissionSession();
    const operation = vi.fn(async () => "must-not-run");
    const pending = session.runModeMutation(operation);
    session.bumpGeneration();

    await expect(pending).resolves.toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });
});
