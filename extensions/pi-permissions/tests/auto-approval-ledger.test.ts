import { describe, expect, it } from "vitest";
import { AutoApprovalLedger } from "../src/auto-approval-ledger.ts";

function denial(index: number) {
  return {
    tool: "bash",
    input: { command: `rm -rf build-${index}` },
    cwd: "/workspace",
    configFingerprint: "config-a",
    actionFingerprint: `action-${index}`,
    summary: `rm -rf build-${index}`,
    rationale: `Denied ${index}`,
  };
}

describe("Auto approval ledger", () => {
  it("keeps only the ten newest denials", () => {
    const ledger = new AutoApprovalLedger();

    for (let index = 1; index <= 11; index += 1) {
      ledger.recordDenial(denial(index));
    }

    expect(ledger.listDenials()).toHaveLength(10);
    expect(ledger.listDenials()[0]).toMatchObject({
      id: "denial-2",
      actionFingerprint: "action-2",
    });
    expect(ledger.listDenials().at(-1)).toMatchObject({
      id: "denial-11",
      actionFingerprint: "action-11",
    });
  });

  it("consumes an approved denial only for one exact retry", () => {
    const ledger = new AutoApprovalLedger();
    const recorded = ledger.recordDenial(denial(1));

    expect(ledger.approveDenial(recorded.id)).toMatchObject(recorded);
    expect(ledger.takeOverride({
      actionFingerprint: "different-action",
      cwd: "/workspace",
      configFingerprint: "config-a",
    })).toBeUndefined();
    expect(ledger.takeOverride({
      actionFingerprint: "action-1",
      cwd: "/workspace",
      configFingerprint: "config-a",
    })).toEqual({
      denialId: recorded.id,
      actionFingerprint: "action-1",
    });
    expect(ledger.takeOverride({
      actionFingerprint: "action-1",
      cwd: "/workspace",
      configFingerprint: "config-a",
    })).toBeUndefined();
  });

  it("clears denials and pending overrides with the permission context", () => {
    const ledger = new AutoApprovalLedger();
    const recorded = ledger.recordDenial(denial(1));
    ledger.approveDenial(recorded.id);

    ledger.clear();

    expect(ledger.listDenials()).toEqual([]);
    expect(ledger.takeOverride({
      actionFingerprint: "action-1",
      cwd: "/workspace",
      configFingerprint: "config-a",
    })).toBeUndefined();
  });
});
