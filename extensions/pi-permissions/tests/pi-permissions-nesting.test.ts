import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type PiAction,
  type PiActionOutcome,
  PiPermissionsRuntime,
  type PiTurnSnapshot,
} from "../src/pi-permissions.ts";

function snapshot(turnId: string, allowWrite: string[] = ["/workspace"]): PiTurnSnapshot {
  return {
    sessionId: "session-1",
    turnId,
    mode: "auto",
    cwd: "/workspace",
    configFingerprint: "config-1",
    baseSandboxPolicy: {
      filesystem: { allowWrite, denyRead: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [] },
    },
    sandboxReady: true,
    transcript: [],
  };
}

function context(): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(async (_: string, choices: string[]) => choices[0]),
    },
  } as unknown as ExtensionContext;
}

function hostAction(
  runtime: PiPermissionsRuntime,
  id: string,
  deny?: (id: string) => boolean,
): PiAction<string> {
  void deny;
  return {
    captured: runtime.captureAction({
      id,
      tool: "mcp_test",
      input: { value: id },
      cwd: "/workspace",
    }),
    kind: "host",
    risk: {
      action: "prompt",
      risk: "REVIEW",
      reason: "The test action requires review.",
      summary: "test action",
    },
    reviewContext: undefined,
    execute: async (): Promise<PiActionOutcome<string>> => ({ kind: "completed", value: "ok" }),
  };
}

describe("PiPermissionsRuntime nested turns", () => {
  it("routes submit to the innermost turn and restores the parent on close", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
    });
    const ctx = context();
    runtime.beginTurn(snapshot("outer"), ctx);
    expect(runtime.hasNestedTurn()).toBe(false);

    runtime.beginNestedTurn(snapshot("child", ["/workspace/sub"]), ctx);
    expect(runtime.hasNestedTurn()).toBe(true);
    await expect(runtime.submit(hostAction(runtime, "child-1"))).resolves.toMatchObject({
      kind: "completed",
      value: "ok",
    });

    runtime.closeNestedTurn("child done");
    expect(runtime.hasNestedTurn()).toBe(false);
    await expect(runtime.submit(hostAction(runtime, "outer-2"))).resolves.toMatchObject({
      kind: "completed",
      value: "ok",
    });
    runtime.closeTurn();
  });

  it("keeps child denials invisible to the parent turn", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: {
        review: async (input: { call: { id: string } }) =>
          input.call.id === "child-denied"
            ? { kind: "deny" as const, rationale: "child says no" }
            : { kind: "approve" as const, rationale: "approved" },
      },
    });
    const ctx = context();
    const ui = ctx.ui as unknown as ExtensionUIContext;
    runtime.beginTurn(snapshot("outer"), ctx);
    runtime.beginNestedTurn(snapshot("child"), ctx);

    const outcome = await runtime.submit(hostAction(runtime, "child-denied"));
    expect(outcome.kind).toBe("blocked");
    expect(await runtime.recoverDeniedAction(ui)).toMatchObject({ kind: "armed" });

    runtime.closeNestedTurn("child done");
    expect(await runtime.recoverDeniedAction(ui)).toMatchObject({ kind: "empty" });
    runtime.closeTurn();
  });

  it("discards parked child levels on outer close and invalidate", () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
    });
    const ctx = context();
    runtime.beginTurn(snapshot("outer"), ctx);
    runtime.beginNestedTurn(snapshot("child"), ctx);
    expect(runtime.hasNestedTurn()).toBe(true);

    runtime.closeTurn("outer closed");
    expect(runtime.hasNestedTurn()).toBe(false);
    expect(runtime.hasActiveTurn()).toBe(false);

    runtime.beginTurn(snapshot("outer-2"), ctx);
    runtime.beginNestedTurn(snapshot("child-2"), ctx);
    runtime.invalidate("reset");
    expect(runtime.hasNestedTurn()).toBe(false);
    expect(runtime.hasActiveTurn()).toBe(false);
  });

  it("leaves the live turn untouched when closing with an empty stack", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
    });
    const ctx = context();
    runtime.beginTurn(snapshot("outer"), ctx);
    expect(runtime.hasNestedTurn()).toBe(false);

    // Defensive path (e.g. a session-only fallback nesting): must not tear
    // down the live outer turn.
    runtime.closeNestedTurn("spurious");
    expect(runtime.hasActiveTurn()).toBe(true);
    await expect(runtime.submit(hostAction(runtime, "outer-1"))).resolves.toMatchObject({
      kind: "completed",
      value: "ok",
    });
    runtime.closeTurn();
  });

  it("keeps the parent unparked when child Engine creation fails", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
    });
    const ctx = context();
    runtime.beginTurn(snapshot("outer"), ctx);
    (runtime as unknown as { createEngine: () => never }).createEngine = () => {
      throw new Error("child Engine creation failed");
    };

    expect(() => runtime.beginNestedTurn(snapshot("child"), ctx)).toThrow(
      "child Engine creation failed",
    );
    expect(runtime.hasNestedTurn()).toBe(false);
    await expect(runtime.submit(hostAction(runtime, "outer-after-failure"))).resolves.toMatchObject(
      {
        kind: "completed",
        value: "ok",
      },
    );
    runtime.closeTurn();
  });
});
