import { describe, expect, it } from "vitest";
import { PermissionSession } from "../src/permission-session.ts";

describe("PermissionSession nested turns (subagent)", () => {
  it("keeps the outer turn alive across one nested agent", () => {
    const session = new PermissionSession();
    const outer = session.allocateTurnId();
    session.beginTurn(outer);
    expect(session.getTurnDepth()).toBe(1);

    expect(session.beginNestedTurn()).toBe(true);
    expect(session.getTurnDepth()).toBe(2);

    expect(session.finishNestedTurn()).toBeUndefined();
    expect(session.getTurnPhase()).toBe("active");
    expect(session.getTurnDepth()).toBe(1);

    expect(session.finishNestedTurn()).toBe(outer);
    expect(session.getTurnPhase()).toBe("between");
  });

  it("supports three levels and resets cleanly", () => {
    const session = new PermissionSession();
    const outer = session.allocateTurnId();
    session.beginTurn(outer);
    session.beginNestedTurn();
    session.beginNestedTurn();
    expect(session.getTurnDepth()).toBe(3);

    expect(session.finishNestedTurn()).toBeUndefined();
    expect(session.finishNestedTurn()).toBeUndefined();
    expect(session.finishNestedTurn()).toBe(outer);

    session.settleBetween();
    expect(session.getTurnPhase()).toBe("idle");
    session.beginTurn(session.allocateTurnId());
    session.resetTurn();
    expect(session.getTurnDepth()).toBe(0);
  });

  it("saturates nesting at the depth cap", () => {
    const session = new PermissionSession();
    session.beginTurn(session.allocateTurnId());
    for (let i = 1; i < PermissionSession.maxNestedTurnDepth; i += 1) {
      expect(session.beginNestedTurn()).toBe(true);
    }
    expect(session.getTurnDepth()).toBe(PermissionSession.maxNestedTurnDepth);
    expect(session.beginNestedTurn()).toBe(false);
    expect(session.getTurnDepth()).toBe(PermissionSession.maxNestedTurnDepth);
  });

  it("pairs end+settled without double finish", () => {
    const session = new PermissionSession();
    const outer = session.allocateTurnId();
    session.beginTurn(outer);
    session.beginNestedTurn();

    expect(session.takeEndAwaitingSettle()).toBe(false);
    session.noteEndAwaitingSettle();
    expect(session.takeEndAwaitingSettle()).toBe(true);
    expect(session.takeEndAwaitingSettle()).toBe(false);
    expect(session.getTurnPhase()).toBe("active");
  });

  it("clears end/settled pairing on begin and reset", () => {
    const session = new PermissionSession();
    session.beginTurn(session.allocateTurnId());
    session.noteEndAwaitingSettle();
    session.beginTurn(session.allocateTurnId());
    expect(session.takeEndAwaitingSettle()).toBe(false);

    session.noteEndAwaitingSettle();
    session.resetTurn();
    expect(session.takeEndAwaitingSettle()).toBe(false);
  });

  it("refuses nesting when idle", () => {
    const session = new PermissionSession();
    expect(session.beginNestedTurn()).toBe(false);
    expect(session.finishNestedTurn()).toBeUndefined();
  });
});

describe("PermissionSession nested delegation context", () => {
  const outerSnapshot = (turnId: number) => ({
    turnId,
    mode: "auto" as const,
    config: {} as never,
    sandboxReady: true,
  });

  it("pushes and pops nested snapshots with the turn depth", () => {
    const session = new PermissionSession();
    const outer = session.allocateTurnId();
    session.beginTurn(outer);
    session.setExecutionSnapshot(outerSnapshot(outer));
    const childSnapshot = outerSnapshot(99);
    const envelope = { writeRoots: ["/proj"], networkHosts: [] as string[] };

    expect(session.beginNestedTurn({ snapshot: childSnapshot, envelope })).toBe(true);
    expect(session.currentExecutionSnapshot()).toBe(childSnapshot);
    expect(session.activeDelegationCeiling()).toBe(envelope);

    expect(session.finishNestedTurn()).toBeUndefined();
    expect(session.getTurnDepth()).toBe(1);
    expect(session.activeDelegationCeiling()).toBeUndefined();
    expect(session.finishNestedTurn()).toBe(outer);
  });

  it("records the audit chain and clears it on new turns", () => {
    const session = new PermissionSession();
    session.beginTurn(session.allocateTurnId());
    const envelope = { writeRoots: [] as string[], networkHosts: [] as string[] };
    session.beginNestedTurn({
      envelope,
      audit: { parentSessionId: "s", parentTurnId: 1, childTurnId: 2, envelope },
    });
    expect(session.delegationAuditTrail()).toHaveLength(1);
    expect(session.delegationAuditTrail()[0]?.childTurnId).toBe(2);

    session.beginTurn(session.allocateTurnId());
    expect(session.delegationAuditTrail()).toHaveLength(0);
    expect(session.activeDelegationCeiling()).toBeUndefined();
  });
});
