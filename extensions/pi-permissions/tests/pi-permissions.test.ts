import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type PiAction,
  type PiActionOutcome,
  PiPermissionsRuntime,
  type PiTurnSnapshot,
  type RecoverDeniedActionResult,
} from "../src/pi-permissions.ts";

const baseSnapshot: PiTurnSnapshot = {
  sessionId: "session-1",
  turnId: "turn-1",
  mode: "auto",
  cwd: "/workspace",
  configFingerprint: "config-1",
  baseSandboxPolicy: {
    filesystem: { allowWrite: ["/workspace"], denyRead: [], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  },
  sandboxReady: true,
  transcript: [],
};

function testUi() {
  return {
    setStatus: vi.fn((_: string, __: string | undefined): void => undefined),
    notify: vi.fn((_: string, __: "info" | "warning" | "error"): void => undefined),
    markToolCall: vi.fn(),
    select: vi.fn(async (_: string, choices: string[]) => choices[0]),
  };
}

function context(ui: ReturnType<typeof testUi>): ExtensionContext {
  return { mode: "tui", hasUI: true, ui } as unknown as ExtensionContext;
}

function reviewedInvocation(
  runtime: PiPermissionsRuntime,
  id: string,
  result: PiActionOutcome<string> = { kind: "completed", value: "ok" },
): PiAction<string> {
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
    execute: async (): Promise<PiActionOutcome<string>> => result,
  };
}

describe("PiPermissionsRuntime facade", () => {
  it("owns the active turn and returns a typed block after close", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
    });
    const ui = testUi();

    const before = await runtime.submit(reviewedInvocation(runtime, "before"));
    expect(before).toMatchObject({ kind: "blocked", error: { code: "no-active-turn" } });

    runtime.beginTurn(baseSnapshot, context(ui));
    expect(runtime.hasActiveTurn()).toBe(true);
    await expect(runtime.submit(reviewedInvocation(runtime, "active"))).resolves.toMatchObject({
      kind: "completed",
      value: "ok",
    });

    runtime.closeTurn();
    expect(runtime.hasActiveTurn()).toBe(false);
    await expect(runtime.submit(reviewedInvocation(runtime, "after"))).resolves.toMatchObject({
      kind: "blocked",
      error: { code: "no-active-turn" },
    });
  });

  it("keeps reviewer event projection and TUI state inside the facade", async () => {
    const events: string[] = [];
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "approve" as const, rationale: "approved" }) },
      reviewEventSink: (event) => events.push(`${event.reviewId}:${event.status}`),
    });
    const ui = testUi();
    runtime.beginTurn(baseSnapshot, context(ui));

    await runtime.submit(reviewedInvocation(runtime, "evented"));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^review-\d+:reviewing$/);
    expect(events[1]).toMatch(/^review-\d+:approved$/);
    expect(ui.setStatus).not.toHaveBeenCalled();
    expect(ui.markToolCall).toHaveBeenCalledOnce();
    expect(ui.markToolCall).toHaveBeenCalledWith("evented", {
      icon: "\u{F105E}",
      color: "warning",
    });
    runtime.invalidate("test reset");
    expect(runtime.hasActiveTurn()).toBe(false);
  });

  it("binds supplemental host metadata into the canonical Engine call", async () => {
    const review = vi.fn(async (input: { call: { metadata?: unknown } }) => {
      expect(input.call.metadata).toEqual({
        metadata: { mcp: { serverName: "mail", toolName: "send", account: "work" } },
      });
      return { kind: "approve" as const, rationale: "approved" };
    });
    const runtime = new PiPermissionsRuntime({ guardian: { review } });
    runtime.beginTurn(baseSnapshot, context(testUi()));

    await expect(
      runtime.submit({
        captured: runtime.captureAction({
          id: "metadata-action",
          tool: "mcp.mail.send",
          input: { recipient: "user@example.com" },
          cwd: "/workspace",
          metadata: {
            metadata: { mcp: { serverName: "mail", toolName: "send", account: "work" } },
          },
        }),
        kind: "host",
        risk: {
          action: "prompt",
          risk: "REVIEW",
          reason: "The host action requires review.",
          summary: "send mail",
        },
        reviewContext: undefined,
        execute: async () => ({ kind: "completed", value: "metadata-bound" }),
      }),
    ).resolves.toEqual({ kind: "completed", value: "metadata-bound" });
    expect(review).toHaveBeenCalledOnce();
  });

  it("keeps the ingress snapshot when the host mutates input during review", async () => {
    let releaseReview: (decision: { kind: "approve"; rationale: string }) => void = () => undefined;
    const reviewGate = new Promise<{ kind: "approve"; rationale: string }>((resolve) => {
      releaseReview = resolve;
    });
    const review = vi.fn(async (input: { call: { input: unknown } }) => {
      expect(input.call.input).toEqual({ command: "printf safe" });
      return reviewGate;
    });
    const runtime = new PiPermissionsRuntime({ guardian: { review } });
    runtime.beginTurn(baseSnapshot, context(testUi()));

    const originalInput = { command: "printf safe" };
    const originalExecute = vi.fn(async (attempt: { call: { input: unknown } }) => {
      expect(attempt.call.input).toEqual({ command: "printf safe" });
      return { kind: "completed" as const, value: "safe" };
    });
    const replacementExecute = vi.fn(async () => ({
      kind: "completed" as const,
      value: "mutated executor",
    }));
    const action: PiAction<string, undefined, typeof originalInput> = {
      captured: runtime.captureAction({
        id: "canonical-action",
        tool: "bash",
        input: originalInput,
        cwd: "/workspace",
      }),
      kind: "sandbox",
      risk: {
        action: "prompt",
        risk: "REVIEW",
        reason: "The action requires review.",
        summary: "canonical action",
      },
      reviewContext: undefined,
      execute: originalExecute,
    };

    const result = runtime.submit(action);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    originalInput.command = "rm -rf /";
    (action as unknown as { execute: typeof action.execute }).execute = replacementExecute;
    releaseReview({ kind: "approve", rationale: "approved" });

    await expect(result).resolves.toEqual({ kind: "completed", value: "safe" });
    expect(originalExecute).toHaveBeenCalledOnce();
    expect(replacementExecute).not.toHaveBeenCalled();
  });

  it("arms an exact retry and returns only immutable dispatch data", async () => {
    const runtime = new PiPermissionsRuntime({
      guardian: { review: async () => ({ kind: "deny" as const, rationale: "not allowed" }) },
    });
    const ui = testUi();
    runtime.beginTurn(baseSnapshot, context(ui));

    const blocked = await runtime.submit(reviewedInvocation(runtime, "denied"));
    expect(blocked).toMatchObject({ kind: "blocked", error: { code: "review-denied" } });
    const recovery: RecoverDeniedActionResult = await runtime.recoverDeniedAction(
      ui as unknown as ExtensionUIContext,
    );

    expect(recovery.kind).toBe("armed");
    if (recovery.kind !== "armed") return;
    expect(recovery.dispatch).toMatchObject({
      denialId: expect.stringMatching(/^retry-/),
      tool: "mcp_test",
      serializedInput: JSON.stringify({ value: "denied" }),
      cwd: "/workspace",
      previousDenial: "not allowed",
    });
    expect(Object.isFrozen(recovery.dispatch)).toBe(true);
  });
});
