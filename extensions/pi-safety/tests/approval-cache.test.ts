import { describe, expect, it, vi } from "vitest";
import {
  type ApproveForMeEngine,
  type CapabilityRequestInput,
  createApproveForMeEngine,
  type ExecutionAttempt,
  type GuardianDecision,
  type GuardianReviewInput,
  type Invocation,
  type RuntimeOutcome,
} from "../src/approve-for-me-engine.ts";

const basePolicy = {
  filesystem: {
    allowWrite: ["/workspace"],
    denyRead: ["/secret"],
    denyWrite: ["/secret"],
  },
  network: {
    allowedDomains: ["example.com"],
    deniedDomains: ["localhost"],
  },
};

function snapshot(overrides: Partial<Parameters<ApproveForMeEngine["beginTurn"]>[0]> = {}) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    mode: "auto" as const,
    cwd: "/workspace",
    configFingerprint: "config-1",
    baseSandboxPolicy: basePolicy,
    sandboxReady: true,
    transcript: [],
    ...overrides,
  };
}

function bash(
  executor: (attempt: ExecutionAttempt) => Promise<RuntimeOutcome<unknown>>,
  id: string,
  admission: Invocation<unknown>["admission"],
): Invocation<unknown> {
  return {
    ownership: "sandbox-owned",
    call: { id, tool: "bash", input: { command: "npm test" }, cwd: "/workspace" },
    admission,
    reviewContext: undefined,
    executor,
  };
}

function actionAdmission(): Invocation<unknown>["admission"] {
  return {
    kind: "review",
    requested: [],
    risk: "NeedsApproval",
    reason: "action review",
    review: "action",
  };
}

function createEngine(review: (request: GuardianReviewInput) => Promise<GuardianDecision>): {
  engine: ApproveForMeEngine;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(review);
  return { engine: createApproveForMeEngine({ guardian: { review: spy } }), spy };
}

function completed<T>(value: T): RuntimeOutcome<T> {
  return { kind: "completed", value };
}

describe("turn-scoped approval cache", () => {
  it("skips Guardian on an identical repeat in the same turn", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    const first = await turn.execute(
      bash(async () => completed("one"), "call-1", actionAdmission()),
    );
    expect(first).toMatchObject({ kind: "completed" });
    const second = await turn.execute(
      bash(async () => completed("two"), "call-2", actionAdmission()),
    );
    expect(second).toMatchObject({ kind: "completed", value: "two" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("never writes on Guardian deny", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    spy.mockResolvedValueOnce({ kind: "deny", rationale: "no" });
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(bash(async () => completed("x"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "blocked", error: { code: "review-denied" } });
    const second = await turn.execute(
      bash(async () => completed("y"), "call-2", actionAdmission()),
    );
    expect(second).toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never writes on failed execution", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(
        bash(
          async () => ({ kind: "failed", error: new Error("boom") }),
          "call-1",
          actionAdmission(),
        ),
      ),
    ).resolves.toMatchObject({ kind: "failed" });
    const second = await turn.execute(
      bash(async () => completed("y"), "call-2", actionAdmission()),
    );
    expect(second).toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("misses when the approved scope drifts", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    const scoped = (path: string): Invocation<unknown>["admission"] => ({
      kind: "review",
      requested: [{ kind: "filesystem", operation: "write", path }],
      risk: "NeedsApproval",
      reason: "capability review",
      review: "capability",
    });
    const first = await turn.execute(bash(async () => completed("one"), "call-1", scoped("/a")));
    expect(first).toMatchObject({ kind: "completed" });
    const second = await turn.execute(bash(async () => completed("two"), "call-2", scoped("/b")));
    expect(second).toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never lets an approved scope satisfy an action review", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    const scoped = (review: "action" | "capability"): Invocation<unknown>["admission"] => ({
      kind: "review",
      requested: [{ kind: "filesystem", operation: "write", path: "/a" }],
      risk: "NeedsApproval",
      reason: "review",
      review,
    });
    await expect(
      turn.execute(bash(async () => completed("one"), "call-1", scoped("capability"))),
    ).resolves.toMatchObject({ kind: "completed" });
    await expect(
      turn.execute(bash(async () => completed("two"), "call-2", scoped("action"))),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("misses in a new turn", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const first = engine.beginTurn(snapshot());
    await expect(
      first.execute(bash(async () => completed("one"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(bash(async () => completed("two"), "call-2", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clears on mode change", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(bash(async () => completed("one"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(engine.refreshTurnMode({ mode: "yolo" })).toBe(true);
    await expect(
      turn.execute(bash(async () => completed("unrestricted"), "call-2", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(engine.refreshTurnMode({ mode: "auto" })).toBe(true);
    await expect(
      turn.execute(bash(async () => completed("three"), "call-3", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    // Initial review + post-yolo review; the yolo execution itself reviews nothing.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clears on base policy change", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(bash(async () => completed("one"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(
      engine.refreshTurnMode({
        mode: "auto",
        baseSandboxPolicy: {
          ...basePolicy,
          filesystem: { ...basePolicy.filesystem, allowWrite: [] },
        },
      }),
    ).toBe(true);
    await expect(
      turn.execute(bash(async () => completed("two"), "call-2", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("clears when a turn amendment widens the lease", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(bash(async () => completed("one"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    const requested: CapabilityRequestInput[] = [
      { kind: "filesystem", operation: "write", path: "/outside/result.txt" },
    ];
    await expect(
      turn.execute({
        ownership: "permission-amendment",
        call: { id: "amend-1", tool: "bash", input: { command: "printf ok" }, cwd: "/workspace" },
        admission: { kind: "allow" },
        reviewContext: undefined,
        executor: async () => completed("amended"),
        intent: { kind: "permission-amendment", requested, reason: "Need generated output." },
      }),
    ).resolves.toMatchObject({ kind: "completed" });
    // Same action as the first call, but the turn lease has widened since.
    await expect(
      turn.execute(bash(async () => completed("two"), "call-3", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never hits while the circuit is open", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    const action = (id: string, command: string) => ({
      ownership: "sandbox-owned" as const,
      call: { id, tool: "bash", input: { command }, cwd: "/workspace" },
      admission: actionAdmission(),
      reviewContext: undefined,
      executor: async () => completed("x"),
    });
    await expect(turn.execute(action("call-1", "npm test"))).resolves.toMatchObject({
      kind: "completed",
    });
    spy.mockResolvedValue({ kind: "deny", rationale: "no" });
    for (const [id, command] of [
      ["call-2", "npm run a"],
      ["call-3", "npm run b"],
      ["call-4", "npm run c"],
    ] as const) {
      await expect(turn.execute(action(id, command))).resolves.toMatchObject({
        kind: "blocked",
        error: { code: "review-denied" },
      });
    }
    // Three consecutive denials open the circuit: the cached approval must not
    // bypass it.
    await expect(turn.execute(action("call-5", "npm test"))).resolves.toMatchObject({
      kind: "blocked",
      error: { code: "circuit-open" },
    });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("misses when residuals change", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    await expect(
      turn.execute(bash(async () => completed("one"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    await expect(
      turn.execute(
        bash(async () => completed("two"), "call-2", {
          kind: "review",
          requested: [],
          risk: "NeedsApproval",
          reason: "action review",
          review: "action",
          residuals: ["write_root_uncovered"],
        }),
      ),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never seeds the cache from yolo executions", async () => {
    const { engine, spy } = createEngine(async () => ({ kind: "approve", rationale: "ok" }));
    const turn = engine.beginTurn(snapshot());
    expect(engine.refreshTurnMode({ mode: "yolo" })).toBe(true);
    await expect(
      turn.execute(bash(async () => completed("unrestricted"), "call-1", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).not.toHaveBeenCalled();
    expect(engine.refreshTurnMode({ mode: "auto" })).toBe(true);
    await expect(
      turn.execute(bash(async () => completed("two"), "call-2", actionAdmission())),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(spy).toHaveBeenCalledOnce();
  });
});
