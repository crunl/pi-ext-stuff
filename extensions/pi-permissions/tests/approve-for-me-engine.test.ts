import { describe, expect, it, vi } from "vitest";
import {
  type AdmissionPlan,
  type ApproveForMeEngine,
  type CapabilityRequest,
  type CapabilityRequestInput,
  createApproveForMeEngine,
  type ExecutionAttempt,
  type GuardianDecision,
  type GuardianReviewInput,
  type Invocation,
  type InvocationCall,
  matchesNetworkDomainPattern,
  type RetryHandle,
  type ReviewEvent,
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

function call(
  executor: (attempt: ExecutionAttempt) => Promise<RuntimeOutcome<unknown>>,
  overrides: Partial<Omit<Invocation<unknown>, "executor">> = {},
): Invocation<unknown> {
  return {
    ownership: "sandbox-owned",
    call: {
      id: "call-1",
      tool: "bash",
      input: { command: "printf ok" },
      cwd: "/workspace",
    },
    admission: { kind: "allow" },
    reviewContext: undefined,
    executor,
    ...overrides,
  };
}

function completed<T>(value: T): RuntimeOutcome<T> {
  return { kind: "completed", value };
}

function failed(error: unknown): RuntimeOutcome<unknown> {
  return { kind: "failed", error };
}

function denied(
  request: CapabilityRequest,
  retryability: "safe" | "uncertain" = "safe",
): RuntimeOutcome<unknown> {
  return { kind: "capability-denied", request, retryability };
}

function writeOutsidePreview(): CapabilityRequestInput[] {
  return [{ kind: "filesystem", operation: "write", path: "/outside/result.txt" }];
}

function reviewAdmission(
  requested: CapabilityRequestInput[] = writeOutsidePreview(),
): AdmissionPlan {
  return {
    kind: "review",
    risk: "REVIEW",
    requested,
    review: "capability",
    reason: "The operation needs a capability outside the baseline lease.",
  };
}

function createEngine(
  review: (request: GuardianReviewInput) => Promise<GuardianDecision>,
  options: Parameters<typeof createApproveForMeEngine>[0] = {},
): { engine: ApproveForMeEngine; review: ReturnType<typeof vi.fn> } {
  const reviewMock = vi.fn(review);
  return {
    engine: createApproveForMeEngine({
      guardian: { review: reviewMock },
      ...options,
    }),
    review: reviewMock,
  };
}

describe("ApproveForMeEngine public seam", () => {
  it("matches network patterns with SRT's exact, wildcard, and port semantics", () => {
    expect(matchesNetworkDomainPattern("example.com", "example.com", 443)).toBe(true);
    expect(matchesNetworkDomainPattern("example.com", "api.example.com", 443)).toBe(false);
    expect(matchesNetworkDomainPattern("*.example.com", "api.example.com", 443)).toBe(true);
    expect(matchesNetworkDomainPattern("*.example.com", "example.com", 443)).toBe(false);
    expect(matchesNetworkDomainPattern("example.com:443", "example.com", 443)).toBe(true);
    expect(matchesNetworkDomainPattern("example.com:443", "example.com", 80)).toBe(false);
    expect(matchesNetworkDomainPattern("[::1]", "::1", 443)).toBe(true);
    expect(matchesNetworkDomainPattern("[2001:0db8::1]:443", "2001:db8::1", 443)).toBe(true);
  });

  it("emits independently identified review lifecycles without letting observers block execution", async () => {
    const events: ReviewEvent[] = [];
    const engine = createApproveForMeEngine({
      guardian: {
        review: async () => ({ kind: "approve" as const, rationale: "approved" }),
      },
      onReviewEvent: (event) => {
        events.push(event);
        if (event.status === "reviewing") throw new Error("observer unavailable");
      },
    });
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async () => completed("ok"));

    const [first, second] = await Promise.all([
      turn.execute(
        call(execute, {
          call: {
            id: "call-a",
            tool: "bash",
            input: { command: "printf a" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        }),
      ),
      turn.execute(
        call(execute, {
          call: {
            id: "call-b",
            tool: "bash",
            input: { command: "printf b" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        }),
      ),
    ]);

    expect(first).toMatchObject({ kind: "completed", value: "ok" });
    expect(second).toMatchObject({ kind: "completed", value: "ok" });
    const reviewing = events.filter((event) => event.status === "reviewing");
    expect(reviewing).toHaveLength(2);
    expect(new Set(reviewing.map((event) => event.reviewId)).size).toBe(2);
    for (const event of reviewing) {
      expect(
        events.some(
          (candidate) => candidate.reviewId === event.reviewId && candidate.status === "approved",
        ),
      ).toBe(true);
    }
  });

  it("runs a baseline call through the sandbox without reviewing it", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async (attempt) => {
      expect(attempt.ordinal).toBe(0);
      expect(attempt.lease.mode).toBe("sandboxed");
      expect(attempt.lease.policy?.filesystem.allowWrite).toEqual(["/workspace"]);
      return completed("ok");
    });

    await expect(turn.execute(call(execute))).resolves.toEqual({ kind: "completed", value: "ok" });
    expect(execute).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "approval",
      guardian: async () => ({ kind: "approve" as const, rationale: "endpoint approved" }),
      expectedCode: undefined,
    },
    {
      label: "denial",
      guardian: async () => ({ kind: "deny" as const, rationale: "endpoint denied" }),
      expectedCode: "review-denied",
    },
    {
      label: "review timeout",
      guardian: async () => ({ kind: "timed-out" as const }),
      expectedCode: "review-timeout",
    },
  ])(
    "caches the inline reviewer terminal decision for one execution ($label)",
    async ({ guardian, expectedCode }) => {
      const { engine, review } = createEngine(guardian);
      const turn = engine.beginTurn(snapshot());
      const executor = vi.fn(async (attempt) => {
        const request = {
          call: attempt.call,
          capability: { kind: "network" as const, host: "api.other.org", port: 443 },
        };
        const first = await turn.authorizeCapability(request);
        const second = await turn.authorizeCapability(request);
        expect(second).toEqual(first);
        if (expectedCode === undefined) expect(first).toMatchObject({ kind: "allow" });
        else expect(first).toMatchObject({ kind: "deny", error: { code: expectedCode } });
        return completed("command continued");
      });

      await expect(turn.execute(call(executor))).resolves.toEqual({
        kind: "completed",
        value: "command continued",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledOnce();
    },
  );

  it("allows an exact local address from the static policy without reviewer escalation", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(
      snapshot({
        baseSandboxPolicy: {
          ...basePolicy,
          network: { allowedDomains: ["127.0.0.1"], deniedDomains: [] },
        },
      }),
    );
    const executor = vi.fn(async (attempt) =>
      (
        await turn.authorizeCapability({
          call: attempt.call,
          capability: { kind: "network", host: "127.0.0.1", port: 8080 },
        })
      ).kind === "allow"
        ? completed("local")
        : failed("local authorization unexpectedly denied"),
    );

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "local",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("lets allowLocalBinding send a private DNS capability through normal review", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "local target approved",
    }));
    const turn = engine.beginTurn(
      snapshot({
        baseSandboxPolicy: {
          ...basePolicy,
          network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
        },
      }),
    );
    const executor = vi.fn(async (attempt) => {
      const decision = await turn.authorizeCapability({
        call: attempt.call,
        capability: { kind: "network", host: "router.internal", port: 80 },
      });
      return decision.kind === "allow"
        ? completed("reviewed local")
        : failed(decision.error.reason);
    });

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "reviewed local",
    });
    expect(review).toHaveBeenCalledOnce();
  });

  it("keeps explicit network denies ahead of local-binding and static allows", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(
      snapshot({
        baseSandboxPolicy: {
          ...basePolicy,
          network: {
            allowedDomains: ["127.0.0.1"],
            deniedDomains: ["127.0.0.1"],
            allowLocalBinding: true,
          },
        },
      }),
    );
    const executor = vi.fn(async (attempt) => {
      const decision = await turn.authorizeCapability({
        call: attempt.call,
        capability: { kind: "network", host: "127.0.0.1", port: 8080 },
      });
      return decision.kind === "deny" ? completed(decision.error.code) : failed("must deny");
    });

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "policy-denied",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("does not treat a wildcard as an exact local exception", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(
      snapshot({
        baseSandboxPolicy: {
          ...basePolicy,
          network: { allowedDomains: ["*"], deniedDomains: [] },
        },
      }),
    );
    const executor = vi.fn(async (attempt) => {
      const decision = await turn.authorizeCapability({
        call: attempt.call,
        capability: { kind: "network", host: "127.0.0.1", port: 8080 },
      });
      return decision.kind === "deny" ? completed(decision.error.code) : failed("must deny");
    });

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "policy-denied",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("rejects an untrusted absolute executable in a typed Git plan", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("must not run"));

    const result = await turn.execute(
      call(executor, {
        admission: {
          kind: "allow",
          execution: {
            kind: "git-init",
            executable: "/tmp/evil",
            args: ["init"],
            cwd: "/workspace",
          },
        },
      }),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("policy-denied");
    expect(executor).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("releases only an exact grantable protected deny for an approved write", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "The Git mutation is explicitly approved.",
    }));
    const gitPolicy = {
      filesystem: {
        allowWrite: ["/workspace"],
        denyRead: [],
        denyWrite: ["/workspace/.git", "/workspace/.agents"],
        grantableDenyWrite: ["/workspace/.git"],
      },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const turn = engine.beginTurn(snapshot({ baseSandboxPolicy: gitPolicy }));
    const execute = vi.fn(async (attempt) => {
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/workspace/.git");
      expect(attempt.lease.policy?.filesystem.denyWrite).not.toContain("/workspace/.git");
      expect(attempt.lease.policy?.filesystem.denyWrite).toContain("/workspace/.agents");
      expect(attempt.lease.policy?.filesystem.grantableDenyWrite).toEqual([]);
      return completed("committed");
    });

    await expect(
      turn.execute(
        call(execute, {
          admission: reviewAdmission([
            { kind: "filesystem", operation: "write", path: "/workspace/.git" },
          ]),
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "committed" });
    expect(review).toHaveBeenCalledOnce();
  });

  it("does not let an approved broad root or hard protected path unlock nested denies", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "Reviewed for the protected-path test.",
    }));
    const policy = {
      filesystem: {
        allowWrite: [],
        denyRead: [],
        denyWrite: ["/workspace/project/.git", "/workspace/project/.agents"],
        grantableDenyWrite: ["/workspace/project/.git"],
      },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const turn = engine.beginTurn(
      snapshot({ cwd: "/workspace/project", baseSandboxPolicy: policy }),
    );
    const broad = vi.fn(async (attempt) => {
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/workspace");
      expect(attempt.lease.policy?.filesystem.denyWrite).toContain("/workspace/project/.git");
      expect(attempt.lease.policy?.filesystem.grantableDenyWrite).toContain(
        "/workspace/project/.git",
      );
      return completed("broad");
    });
    await expect(
      turn.execute(
        call(broad, {
          call: {
            id: "broad-root",
            tool: "bash",
            input: { command: "write workspace" },
            cwd: "/workspace/project",
          },
          admission: reviewAdmission([
            { kind: "filesystem", operation: "write", path: "/workspace" },
          ]),
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "broad" });

    const hard = vi.fn(async (attempt) => {
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/workspace/project/.agents");
      expect(attempt.lease.policy?.filesystem.denyWrite).toContain("/workspace/project/.agents");
      expect(attempt.lease.policy?.filesystem.grantableDenyWrite).toContain(
        "/workspace/project/.git",
      );
      return completed("hard");
    });
    await expect(
      turn.execute(
        call(hard, {
          call: {
            id: "hard-protected",
            tool: "bash",
            input: { command: "write agents" },
            cwd: "/workspace/project",
          },
          admission: reviewAdmission([
            { kind: "filesystem", operation: "write", path: "/workspace/project/.agents" },
          ]),
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "hard" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("passes an opaque review context to Guardian without changing its identity", async () => {
    const reviewContext = { requestId: "request-1", source: "pi-host" };
    const review = vi.fn(async (input: GuardianReviewInput<typeof reviewContext>) => {
      expect(input.context).toBe(reviewContext);
      return { kind: "approve" as const, rationale: "Context is trusted by the host." };
    });
    const engine = createApproveForMeEngine<typeof reviewContext>({
      guardian: { review },
    });
    const turn = engine.beginTurn(snapshot());
    const request: Invocation<unknown, typeof reviewContext> = {
      ownership: "sandbox-owned",
      call: {
        id: "context-call",
        tool: "bash",
        input: { command: "printf context" },
        cwd: "/workspace",
      },
      admission: reviewAdmission(),
      reviewContext,
      executor: vi.fn(async () => completed("context")),
    };

    await expect(turn.execute(request)).resolves.toEqual({
      kind: "completed",
      value: "context",
    });
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0]?.[0].context).toBe(reviewContext);
  });

  it("adds an Engine-generated approval marker only to an exact manual retry", async () => {
    const reviewContext = { approvalOverride: { denialId: "forged", actionFingerprint: "forged" } };
    let firstHandle: RetryHandle | undefined;
    const review = vi.fn(async (input: GuardianReviewInput<typeof reviewContext>) => {
      if (input.source === "preview") {
        expect(input.approvalOverride).toBeUndefined();
        expect(input.context).toBe(reviewContext);
        return { kind: "deny" as const, rationale: "The first review is denied." };
      }
      expect(input.source).toBe("manual-retry");
      expect(input.context).toBe(reviewContext);
      expect(input.approvalOverride?.denialId).toBe(firstHandle?.token);
      expect(input.approvalOverride?.actionFingerprint).toEqual(expect.any(String));
      return { kind: "approve" as const, rationale: "The exact retry is approved." };
    });
    const engine = createApproveForMeEngine<typeof reviewContext>({
      guardian: { review },
    });
    const turn = engine.beginTurn(snapshot());
    const first = await turn.execute({
      ownership: "sandbox-owned",
      call: {
        id: "override-call-1",
        tool: "bash",
        input: { command: "printf override" },
        cwd: "/workspace",
      },
      admission: reviewAdmission(),
      reviewContext,
      executor: vi.fn(async () => completed("never")),
    });
    expect(first.kind).toBe("blocked");
    firstHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(firstHandle).toBeDefined();
    expect(engine.armRetry(firstHandle as RetryHandle)).toBe(true);

    await expect(
      turn.execute({
        ownership: "sandbox-owned",
        call: {
          id: "override-call-2",
          tool: "bash",
          input: { command: "printf override" },
          cwd: "/workspace",
        },
        admission: reviewAdmission(),
        reviewContext,
        executor: vi.fn(async () => completed("retried")),
      }),
    ).resolves.toEqual({ kind: "completed", value: "retried" });
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[0]?.[0]).not.toHaveProperty("approvalOverride");
    expect(review.mock.calls[1]?.[0].approvalOverride).toEqual({
      denialId: firstHandle?.token,
      actionFingerprint: expect.any(String),
    });
  });

  it("keeps an armed retry when the current admission capability scope changes", async () => {
    const reviewed: Array<{
      source: GuardianReviewInput["source"];
      requested: readonly CapabilityRequest[];
    }> = [];
    const { engine } = createEngine(async (input) => {
      reviewed.push({ source: input.source, requested: input.requested });
      if (reviewed.length === 1) {
        return { kind: "deny", rationale: "The original scope is denied." };
      }
      return { kind: "approve", rationale: "This review is approved." };
    });
    const turn = engine.beginTurn(snapshot());
    const originalAdmission = reviewAdmission([
      { kind: "filesystem", operation: "write", path: "/outside/original.txt" },
    ]);
    const first = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: originalAdmission },
      ),
    );
    const retryHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("different scope")),
          {
            call: {
              id: "different-scope",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            admission: reviewAdmission([
              { kind: "filesystem", operation: "write", path: "/outside/different.txt" },
            ]),
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "different scope" });
    expect(reviewed[1]).toEqual({
      source: "preview",
      requested: [{ kind: "filesystem", operation: "write", path: "/outside/different.txt" }],
    });

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("exact scope")),
          {
            call: {
              id: "exact-scope",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            admission: originalAdmission,
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "exact scope" });
    expect(reviewed[2]).toEqual({
      source: "manual-retry",
      requested: [{ kind: "filesystem", operation: "write", path: "/outside/original.txt" }],
    });
    expect(engine.listDenials()).toEqual([]);
  });

  it("emits auto state snapshots for turn reset, decisions, and circuit pause", async () => {
    const states: Array<{
      consecutiveDenials: number;
      recentDenials: number;
      paused: boolean;
    }> = [];
    let reviewCount = 0;
    const { engine, review } = createEngine(
      async () => {
        reviewCount += 1;
        return reviewCount === 2
          ? { kind: "approve", rationale: "Approved on the second review." }
          : { kind: "deny", rationale: "Denied for the state test." };
      },
      {
        maxConsecutiveDenials: 3,
        onAutoStateChange: (state) => states.push(state),
      },
    );
    const turn = engine.beginTurn(snapshot());
    for (let index = 0; index < 5; index += 1) {
      const result = await turn.execute(
        call(
          vi.fn(async () => completed(`state-${index}`)),
          {
            call: {
              id: `state-${index}`,
              tool: "bash",
              input: { command: `printf state-${index}` },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      );
      expect(result.kind).toBe(index === 1 ? "completed" : "blocked");
    }
    turn.close();
    engine.beginTurn(snapshot({ turnId: "turn-2" }));

    expect(review).toHaveBeenCalledTimes(5);
    expect(states).toEqual([
      { consecutiveDenials: 0, recentDenials: 0, paused: false },
      { consecutiveDenials: 1, recentDenials: 1, paused: false },
      { consecutiveDenials: 0, recentDenials: 1, paused: false },
      { consecutiveDenials: 1, recentDenials: 2, paused: false },
      { consecutiveDenials: 2, recentDenials: 3, paused: false },
      { consecutiveDenials: 3, recentDenials: 4, paused: true },
      { consecutiveDenials: 0, recentDenials: 0, paused: false },
    ]);
  });

  it("resets consecutive denials after a completed timeout", async () => {
    let reviewCount = 0;
    const { engine, review } = createEngine(async () => {
      reviewCount += 1;
      if (reviewCount === 2) return { kind: "timed-out" };
      return { kind: "deny", rationale: `Denied ${reviewCount}.` };
    });
    const turn = engine.beginTurn(snapshot());
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(
        await turn.execute(
          call(
            vi.fn(async () => completed("never")),
            {
              call: {
                id: `timeout-reset-${index}`,
                tool: "bash",
                input: { command: `printf timeout-reset-${index}` },
                cwd: "/workspace",
              },
              admission: reviewAdmission(),
            },
          ),
        ),
      );
    }

    expect(
      results.map((result) => (result.kind === "blocked" ? result.error.code : result.kind)),
    ).toEqual(["review-denied", "review-timeout", "review-denied"]);
    expect(review).toHaveBeenCalledTimes(3);
  });

  it("reviews a declared capability before execution and grants only that call", async () => {
    const { engine, review } = createEngine(async (request) => {
      expect(request.source).toBe("preview");
      expect(request.reason).toBe("The operation needs an output path.");
      expect(request.summary).toBe("Write the generated result.");
      expect(request.requested).toEqual([
        { kind: "filesystem", operation: "write", path: "/outside/result.txt" },
      ]);
      return { kind: "approve", rationale: "The requested output is expected." };
    });
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async (attempt) => {
      expect(attempt.ordinal).toBe(0);
      expect(attempt.lease.policy?.filesystem.allowWrite).toEqual([
        "/workspace",
        "/outside/result.txt",
      ]);
      return completed("ok");
    });

    await expect(
      turn.execute(
        call(execute, {
          admission: {
            kind: "review",
            risk: "REVIEW",
            requested: writeOutsidePreview(),
            review: "capability",
            reason: "The operation needs an output path.",
            summary: "Write the generated result.",
          },
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "ok" });
    expect(review).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("hard-blocks an admission deny without Guardian or enforcement", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("must not run"));
    const result = await turn.execute(
      call(executor, { admission: { kind: "deny", reason: "The action is forbidden." } }),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("policy-denied");
    expect(review).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("reviews an action even when it requests no capabilities", async () => {
    const { engine, review } = createEngine(async (request) => {
      expect(request.source).toBe("preview");
      expect(request.requested).toEqual([]);
      expect(request.reason).toBe("Confirm the action itself.");
      expect(request.summary).toBe("A no-capability action");
      return { kind: "approve", rationale: "confirmed" };
    });
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("action"));
    const result = await turn.execute(
      call(executor, {
        admission: {
          kind: "review",
          risk: "REVIEW",
          review: "action",
          reason: "Confirm the action itself.",
          summary: "A no-capability action",
        },
      }),
    );

    expect(result).toEqual({ kind: "completed", value: "action" });
    expect(review).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
  });

  it("preserves hard deny rules while applying an approved one-shot grant", async () => {
    const sources: string[] = [];
    const { engine, review } = createEngine(async (request) => {
      sources.push(request.source);
      return { kind: "approve", rationale: "reviewed" };
    });
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async (attempt) => {
      expect(attempt.lease.policy?.filesystem.denyRead).toEqual(["/secret"]);
      expect(attempt.lease.policy?.filesystem.denyWrite).toEqual(["/secret"]);
      return denied({ kind: "filesystem", operation: "write", path: "/secret/result.txt" });
    });

    const result = await turn.execute(
      call(execute, {
        admission: reviewAdmission([
          { kind: "filesystem", operation: "write", path: "/secret/result.txt" },
        ]),
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("retry-denied");
    expect(sources).toEqual(["preview", "runtime"]);
    expect(review).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not replay a reviewed command after a mid-execution network denial", async () => {
    const sources: string[] = [];
    const { engine, review } = createEngine(async (request) => {
      sources.push(request.source);
      return { kind: "approve", rationale: "reviewed" };
    });
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn().mockImplementationOnce(async (attempt) => {
      expect(attempt.ordinal).toBe(0);
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/outside/result.txt");
      return denied({ kind: "network", host: "api.other.org" });
    });

    const result = await turn.execute(
      call(execute, {
        admission: reviewAdmission([
          { kind: "filesystem", operation: "write", path: "/outside/result.txt" },
        ]),
      }),
    );
    expect(result).toMatchObject({
      kind: "blocked",
      error: { code: "runtime-denied", reason: expect.stringContaining("before") },
    });
    expect(sources).toEqual(["preview"]);
    expect(review).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks a denied preview without invoking the executor", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "deny",
      rationale: "Not needed.",
    }));
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async () => completed("must not run"));

    const result = await turn.execute(call(execute, { admission: reviewAdmission() }));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.error.code).toBe("review-denied");
      expect(result.retryHandle).toBeDefined();
    }
    expect(execute).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
  });

  it("deep-clones denied call input for notices and exact retries", async () => {
    const { engine, review } = createEngine(async (input) => {
      if (input.source === "manual-retry") {
        expect(input.call.input).toEqual({
          command: "printf clone",
          nested: { value: "stable" },
        });
        return { kind: "approve", rationale: "The exact input is approved." };
      }
      return { kind: "deny", rationale: "Retry after inspecting the original input." };
    });
    const first = engine.beginTurn(snapshot());
    const originalInput = {
      command: "printf clone",
      nested: { value: "stable" },
    };
    const deniedResult = await first.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "clone-call-1",
            tool: "bash",
            input: originalInput,
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(deniedResult.kind).toBe("blocked");
    const retryHandle = deniedResult.kind === "blocked" ? deniedResult.retryHandle : undefined;
    expect(retryHandle).toBeDefined();

    originalInput.command = "mutated after denial";
    originalInput.nested.value = "mutated";
    const notices = engine.listDenials();
    const notice = notices[0];
    expect(notice?.call.input).toEqual({
      command: "printf clone",
      nested: { value: "stable" },
    });
    if (notice) {
      (notice.call.input as { command: string }).command = "mutated notice";
    }
    expect(engine.listDenials()[0]?.call.input).toEqual({
      command: "printf clone",
      nested: { value: "stable" },
    });

    first.close();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);
    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("retried")),
          {
            call: {
              id: "clone-call-2",
              tool: "bash",
              input: {
                command: "printf clone",
                nested: { value: "stable" },
              },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "retried" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("fails closed when reviewed invocation metadata is not cloneable", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not be reached",
    }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("must not run"));
    const result = await turn.execute(
      call(executor, {
        call: {
          id: "uncloneable-metadata",
          tool: "bash",
          input: { command: "printf metadata" },
          cwd: "/workspace",
          metadata: { callback: () => undefined },
        },
        admission: reviewAdmission(),
      }),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("review-unavailable");
    expect(executor).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("reviews a safe runtime denial and retries the exact invocation once", async () => {
    const { engine, review } = createEngine(async (request) => {
      expect(request.source).toBe("runtime");
      expect(request.retryability).toBe("safe");
      return { kind: "approve", rationale: "The command needs this output path." };
    });
    const turn = engine.beginTurn(snapshot());
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        denied({ kind: "filesystem", operation: "write", path: "/outside/result.txt" }),
      )
      .mockImplementationOnce(async (attempt) => {
        expect(attempt.ordinal).toBe(1);
        expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/outside/result.txt");
        return completed("retried");
      });

    await expect(turn.execute(call(execute))).resolves.toEqual({
      kind: "completed",
      value: "retried",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledOnce();
  });

  it("fails closed on an uncertain runtime denial and does not replay it", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const turn = engine.beginTurn(snapshot());
    const execute = vi.fn(async () =>
      denied({ kind: "filesystem", operation: "write", path: "/outside/result.txt" }, "uncertain"),
    );

    const result = await turn.execute(call(execute));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("retry-uncertain");
    expect(execute).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it("leaves an armed retry untouched when a mismatched call executes", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "deny", rationale: "No." }));
    const turn = engine.beginTurn(snapshot());
    const first = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: reviewAdmission() },
      ),
    );
    expect(first.kind).toBe("blocked");
    const retryHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    const mismatchExecutor = vi.fn(async () => completed("mismatch ran"));
    const mismatch = await turn.execute(
      call(mismatchExecutor, {
        call: {
          id: "call-1",
          tool: "bash",
          input: { command: "printf different" },
          cwd: "/workspace",
        },
      }),
    );
    expect(mismatch).toEqual({ kind: "completed", value: "mismatch ran" });
    expect(mismatchExecutor).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();

    const exactAfterMismatch = await turn.execute(
      call(
        vi.fn(async () => completed("must remain blocked")),
        {
          call: {
            id: "call-2",
            tool: "bash",
            input: { command: "printf ok" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(exactAfterMismatch.kind).toBe("blocked");
    if (exactAfterMismatch.kind === "blocked") {
      expect(exactAfterMismatch.error.code).toBe("review-denied");
    }
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("does not consume an armed retry when MCP metadata changes", async () => {
    const originalMetadata = {
      mcp: { server: "mail", method: "send", requestId: "request-1" },
    };
    const changedMetadata = {
      mcp: { server: "mail", method: "send", requestId: "request-2" },
    };
    const { engine, review } = createEngine(async (request) => {
      if (request.source === "preview") {
        return { kind: "deny", rationale: "The first metadata-bound action is denied." };
      }
      expect(request.source).toBe("manual-retry");
      return { kind: "approve", rationale: "The exact metadata-bound retry is approved." };
    });
    const turn = engine.beginTurn(snapshot());
    const first = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "metadata-call-1",
            tool: "mcp.send",
            input: { message: "hello" },
            cwd: "/workspace",
            metadata: originalMetadata,
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(first.kind).toBe("blocked");
    const retryHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    const notice = engine.listDenials()[0];
    expect(notice?.call.metadata).toEqual(originalMetadata);
    expect(notice?.call.metadata).not.toBe(originalMetadata);
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("metadata mismatch ran")),
          {
            call: {
              id: "metadata-call-2",
              tool: "mcp.send",
              input: { message: "hello" },
              cwd: "/workspace",
              metadata: changedMetadata,
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "metadata mismatch ran" });
    expect(review).toHaveBeenCalledOnce();

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("metadata retried")),
          {
            call: {
              id: "metadata-call-3",
              tool: "mcp.send",
              input: { message: "hello" },
              cwd: "/workspace",
              metadata: originalMetadata,
            },
            admission: reviewAdmission(),
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "metadata retried" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("allows an exact manual retry with a new tool-call id", async () => {
    const { engine, review } = createEngine(async (request) => {
      if (request.source === "preview") return { kind: "deny", rationale: "Try again manually." };
      expect(request.source).toBe("manual-retry");
      return { kind: "approve", rationale: "The exact retry is acceptable." };
    });
    const turn = engine.beginTurn(snapshot());
    const first = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: reviewAdmission() },
      ),
    );
    const retryHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    const retried = await turn.execute(
      call(
        vi.fn(async () => completed("retried")),
        {
          call: {
            id: "call-2",
            tool: "bash",
            input: { command: "printf ok" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(retried).toEqual({ kind: "completed", value: "retried" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("keeps an exact retry armed when the structured execution plan changes", async () => {
    const sources: GuardianReviewInput["source"][] = [];
    const { engine, review } = createEngine(async (request) => {
      sources.push(request.source);
      if (sources.length === 1) {
        return { kind: "deny", rationale: "Review the exact Git initialization plan." };
      }
      return { kind: "approve", rationale: "This exact plan is acceptable." };
    });
    const turn = engine.beginTurn(snapshot());
    const originalAdmission: AdmissionPlan = {
      kind: "review",
      risk: "REVIEW",
      requested: writeOutsidePreview(),
      review: "capability",
      reason: "The operation needs a capability outside the baseline lease.",
      execution: {
        kind: "git-init",
        executable: "/usr/bin/git",
        args: ["init"],
        cwd: "/workspace",
      },
    };
    const first = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: originalAdmission },
      ),
    );
    const retryHandle = first.kind === "blocked" ? first.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("different plan")),
          {
            call: {
              id: "different-plan",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            admission: {
              kind: "review",
              risk: "REVIEW",
              requested: writeOutsidePreview(),
              review: "capability",
              reason: "The operation needs a capability outside the baseline lease.",
              execution: {
                kind: "git-init",
                executable: "/usr/bin/git",
                args: ["init", "."],
                cwd: "/workspace",
              },
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "different plan" });

    await expect(
      turn.execute(
        call(
          vi.fn(async () => completed("exact plan")),
          {
            call: {
              id: "exact-plan",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            admission: originalAdmission,
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "exact plan" });

    expect(sources).toEqual(["preview", "preview", "manual-retry"]);
    expect(review).toHaveBeenCalledTimes(3);
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(false);
  });

  it("arms a denied action after turn close and retries it in the next turn", async () => {
    const { engine, review } = createEngine(async (request) => {
      if (request.source === "preview") {
        return { kind: "deny", rationale: "Retry this action manually." };
      }
      expect(request.source).toBe("manual-retry");
      expect(request.approvalOverride?.denialId).toBeDefined();
      return { kind: "approve", rationale: "The exact next-turn retry is approved." };
    });
    const first = engine.beginTurn(snapshot({ turnId: "turn-1" }));
    const firstResult = await first.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "old-call-id",
            tool: "bash",
            input: { command: "printf cross-turn" },
            cwd: "/workspace",
            metadata: { source: "same-action" },
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(firstResult.kind).toBe("blocked");
    const retryHandle = firstResult.kind === "blocked" ? firstResult.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    first.close();

    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);
    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("retried-next-turn")),
          {
            call: {
              id: "new-call-id",
              tool: "bash",
              input: { command: "printf cross-turn" },
              cwd: "/workspace",
              metadata: { source: "same-action" },
            },
            admission: reviewAdmission(),
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "retried-next-turn" });
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]?.[0].source).toBe("manual-retry");
  });

  it("keeps an armed retry through a next-turn mismatch and then consumes the exact action", async () => {
    const { engine, review } = createEngine(async (request) => {
      if (request.source === "preview") return { kind: "deny", rationale: "Try manually." };
      expect(request.source).toBe("manual-retry");
      return { kind: "approve", rationale: "Exact action approved." };
    });
    const first = engine.beginTurn(snapshot({ turnId: "turn-1" }));
    const deniedResult = await first.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: reviewAdmission() },
      ),
    );
    const retryHandle = deniedResult.kind === "blocked" ? deniedResult.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    first.close();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    const mismatchExecutor = vi.fn(async () => completed("mismatch"));
    await expect(
      second.execute(
        call(mismatchExecutor, {
          call: {
            id: "mismatch-call",
            tool: "bash",
            input: { command: "printf changed" },
            cwd: "/workspace",
          },
          admission: { kind: "allow" },
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "mismatch" });
    expect(mismatchExecutor).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();

    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("exact")),
          {
            call: {
              id: "new-exact-call",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "exact" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("clears an unarmed and armed retry on engine invalidation", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "deny",
      rationale: "No retry after invalidation.",
    }));
    const first = engine.beginTurn(snapshot());
    const deniedResult = await first.execute(
      call(
        vi.fn(async () => completed("never")),
        { admission: reviewAdmission() },
      ),
    );
    const retryHandle = deniedResult.kind === "blocked" ? deniedResult.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    first.close();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    engine.invalidate("session changed");
    expect(engine.listDenials()).toHaveLength(0);
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(false);

    const next = engine.beginTurn(snapshot({ sessionId: "session-2", turnId: "turn-2" }));
    const result = await next.execute(
      call(
        vi.fn(async () => completed("next")),
        { admission: reviewAdmission() },
      ),
    );
    expect(result.kind).toBe("blocked");
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("keeps only the ten most recent denial notices and retry records", async () => {
    const { engine, review } = createEngine(
      async () => ({ kind: "deny", rationale: "Bounded denial." }),
      { maxConsecutiveDenials: 100, maxWindowDenials: 100 },
    );
    const turn = engine.beginTurn(snapshot());
    let firstHandle: RetryHandle | undefined;
    for (let index = 0; index < 12; index += 1) {
      const result = await turn.execute(
        call(
          vi.fn(async () => completed("must not run")),
          {
            call: {
              id: `bounded-${index}`,
              tool: "bash",
              input: { command: `printf bounded-${index}` },
              cwd: "/workspace",
            },
            admission: {
              kind: "review",
              risk: "REVIEW",
              requested: writeOutsidePreview(),
              review: "capability",
              reason: "The operation needs an output path.",
              summary: "Bounded denial notice.",
            },
          },
        ),
      );
      expect(result.kind).toBe("blocked");
      if (index === 0 && result.kind === "blocked") firstHandle = result.retryHandle;
    }

    const notices = engine.listDenials();
    expect(review).toHaveBeenCalledTimes(12);
    expect(notices).toHaveLength(10);
    expect(notices.map((notice) => notice.call.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `bounded-${index + 2}`),
    );
    const oldest = notices[0];
    expect(oldest).toBeDefined();
    if (oldest !== undefined) {
      expect(oldest.summary).toBe("Bounded denial notice.");
      expect(oldest.rationale).toBe("Bounded denial.");
      expect(oldest.handle.__brand).toBe("pi-permissions-retry-handle");
      expect(engine.armRetry(oldest.handle)).toBe(true);
    }
    expect(firstHandle).toBeDefined();
    expect(engine.armRetry(firstHandle as RetryHandle)).toBe(false);
  });

  it("keeps only explicit permission amendments in the sticky world across turns", async () => {
    const { engine, review } = createEngine(async (request) => {
      expect(request.source).toBe("permission-amendment");
      return { kind: "approve", rationale: "Explicitly requested." };
    });
    const first = engine.beginTurn(snapshot());
    const amendmentExecutor = vi.fn(async (attempt) => {
      expect(attempt.ordinal).toBe(0);
      return completed("granted");
    });
    await expect(
      first.execute(
        call(amendmentExecutor, {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
            reason: "Need generated output.",
          },
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "granted" });
    first.close();

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    const later = vi.fn(async (attempt) => {
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/outside/result.txt");
      return completed("later");
    });
    await expect(second.execute(call(later, { admission: reviewAdmission() }))).resolves.toEqual({
      kind: "completed",
      value: "later",
    });
    expect(review).toHaveBeenCalledOnce();
  });

  it("applies exact grantable deny semantics to session amendments", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "The explicit session amendment is approved.",
    }));
    const policy = {
      filesystem: {
        allowWrite: [],
        denyRead: [],
        denyWrite: ["/workspace/.git", "/workspace/.agents"],
        grantableDenyWrite: ["/workspace/.git"],
      },
      network: { allowedDomains: [], deniedDomains: [] },
    };
    const first = engine.beginTurn(snapshot({ baseSandboxPolicy: policy, cwd: "/workspace" }));
    await expect(
      first.execute(
        call(
          vi.fn(async (attempt) => {
            expect(attempt.lease.policy?.filesystem.allowWrite).toEqual([
              "/workspace/.git",
              "/workspace/.agents",
            ]);
            expect(attempt.lease.policy?.filesystem.denyWrite).toEqual(["/workspace/.agents"]);
            expect(attempt.lease.policy?.filesystem.grantableDenyWrite).toEqual([]);
            return completed("amended");
          }),
          {
            ownership: "permission-amendment",
            intent: {
              kind: "permission-amendment",
              requested: [
                { kind: "filesystem", operation: "write", path: "/workspace/.git" },
                { kind: "filesystem", operation: "write", path: "/workspace/.agents" },
              ],
              scope: "session",
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "amended" });
    first.close();

    const second = engine.beginTurn(
      snapshot({ turnId: "turn-2", baseSandboxPolicy: policy, cwd: "/workspace" }),
    );
    await expect(
      second.execute(
        call(
          vi.fn(async (attempt) => {
            expect(attempt.lease.policy?.filesystem.allowWrite).toEqual([
              "/workspace/.git",
              "/workspace/.agents",
            ]);
            expect(attempt.lease.policy?.filesystem.denyWrite).toEqual(["/workspace/.agents"]);
            return completed("carried");
          }),
          { admission: { kind: "allow" } },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "carried" });
    expect(review).toHaveBeenCalledOnce();
  });

  it("re-reviews an exact permission amendment retry and leaves mismatches armed", async () => {
    let reviewCount = 0;
    const { engine, review } = createEngine(async (input) => {
      if (reviewCount === 0) {
        expect(input.source).toBe("permission-amendment");
        reviewCount += 1;
        return { kind: "deny", rationale: "Amendment needs another look." };
      }
      if (reviewCount === 1) {
        expect(input.source).toBe("permission-amendment");
        reviewCount += 1;
        return { kind: "approve", rationale: "Mismatched amendment is approved." };
      }
      expect(input.source).toBe("manual-retry");
      expect(input.approvalOverride?.denialId).toBe("retry-1");
      reviewCount += 1;
      return { kind: "approve", rationale: "Exact amendment is approved." };
    });
    const first = engine.beginTurn(snapshot());
    const deniedResult = await first.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
          },
        },
      ),
    );
    expect(deniedResult.kind).toBe("blocked");
    const retryHandle = deniedResult.kind === "blocked" ? deniedResult.retryHandle : undefined;
    expect(retryHandle).toBeDefined();
    first.close();
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(true);

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("mismatch")),
          {
            call: {
              id: "mismatch-amendment",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            ownership: "permission-amendment",
            intent: {
              kind: "permission-amendment",
              requested: [{ kind: "filesystem", operation: "write", path: "/outside/other.txt" }],
              scope: "session",
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "mismatch" });

    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("exact")),
          {
            call: {
              id: "exact-amendment",
              tool: "bash",
              input: { command: "printf ok" },
              cwd: "/workspace",
            },
            ownership: "permission-amendment",
            intent: {
              kind: "permission-amendment",
              requested: writeOutsidePreview(),
              scope: "session",
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "exact" });
    expect(review).toHaveBeenCalledTimes(3);
    expect(engine.listDenials()).toEqual([]);
    expect(engine.armRetry(retryHandle as RetryHandle)).toBe(false);
  });

  it("skips capability review for session-covered requests but still reviews actions", async () => {
    const { engine, review } = createEngine(async (request) => {
      if (request.source === "permission-amendment") {
        return { kind: "approve", rationale: "Explicitly requested." };
      }
      expect(request.source).toBe("preview");
      expect(request.requested).toEqual([
        { kind: "filesystem", operation: "write", path: "/outside/result.txt" },
      ]);
      return { kind: "approve", rationale: "The action is confirmed." };
    });
    const first = engine.beginTurn(snapshot());
    await first.execute(
      call(
        vi.fn(async () => completed("granted")),
        {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
          },
        },
      ),
    );
    first.close();

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("covered")),
          { admission: reviewAdmission() },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "covered" });
    expect(review).toHaveBeenCalledOnce();

    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("action")),
          {
            admission: {
              kind: "review",
              risk: "REVIEW",
              requested: writeOutsidePreview(),
              review: "action",
              reason: "Confirm this covered action.",
            },
          },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "action" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("clears sticky permissions on session/config invalidation", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "yes" }));
    const first = engine.beginTurn(snapshot());
    await first.execute(
      call(
        vi.fn(async () => completed("granted")),
        {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
            reason: "Need it.",
          },
        },
      ),
    );
    first.close();
    engine.invalidate("config changed");
    const second = engine.beginTurn(snapshot({ turnId: "turn-2", configFingerprint: "config-2" }));
    await second.execute(
      call(
        vi.fn(async () => completed("ok")),
        { admission: reviewAdmission() },
      ),
    );
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("does not make an ordinary approval sticky across turns", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "yes" }));
    const first = engine.beginTurn(snapshot());
    await expect(
      first.execute(
        call(
          vi.fn(async () => completed("first")),
          { admission: reviewAdmission() },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "first" });
    first.close();

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("second")),
          { admission: reviewAdmission() },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "second" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("commits an explicit amendment only after its executor succeeds", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "yes" }));
    const first = engine.beginTurn(snapshot());
    const amendmentResult = await first.execute(
      call(
        vi.fn(async () => failed(new Error("ack failed"))),
        {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
          },
        },
      ),
    );
    expect(amendmentResult.kind).toBe("failed");
    first.close();

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    await expect(
      second.execute(
        call(
          vi.fn(async () => completed("second")),
          { admission: reviewAdmission() },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "second" });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("admits a generic host tool only from an exact preview", async () => {
    const { engine, review } = createEngine(async (request) => {
      expect(request.ownership).toBe("host-admission");
      return { kind: "approve", rationale: "The external operation is requested." };
    });
    const turn = engine.beginTurn(snapshot({ baseSandboxPolicy: undefined, sandboxReady: false }));
    const executor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("host-admitted");
      return completed("host result");
    });
    await expect(
      turn.execute(
        call(executor, {
          ownership: "host-admission",
          admission: reviewAdmission([{ kind: "external-tool", provider: "mail", name: "send" }]),
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "host result" });
    expect(review).toHaveBeenCalledOnce();
  });

  it("reviews and retries an exact host-admission external-tool denial once", async () => {
    const requested = { kind: "external-tool" as const, provider: "mail", name: "send" };
    const { engine, review } = createEngine(async (input) => {
      expect(input.ownership).toBe("host-admission");
      expect(input.source).toBe("runtime");
      expect(input.requested).toEqual([requested]);
      return { kind: "approve", rationale: "The exact external operation is approved." };
    });
    const turn = engine.beginTurn(snapshot({ baseSandboxPolicy: undefined, sandboxReady: false }));
    const executor = vi
      .fn()
      .mockResolvedValueOnce(denied(requested))
      .mockImplementationOnce(async (attempt) => {
        expect(attempt.ordinal).toBe(1);
        expect(attempt.lease.mode).toBe("host-admitted");
        return completed("retried host operation");
      });

    await expect(
      turn.execute(
        call(executor, {
          ownership: "host-admission",
          call: {
            id: "host-runtime-retry",
            tool: "mcp.mail.send",
            input: { recipient: "user@example.com" },
            cwd: "/workspace",
          },
          admission: { kind: "allow", requested: [requested] },
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "retried host operation" });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledOnce();
  });

  it("bypasses Guardian and sandbox in yolo mode", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "deny", rationale: "unused" }));
    const turn = engine.beginTurn(snapshot({ mode: "yolo", baseSandboxPolicy: undefined }));
    const executor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("unrestricted");
      expect(attempt.lease.policy).toBeUndefined();
      return completed("yolo");
    });
    await expect(turn.execute(call(executor, { admission: reviewAdmission() }))).resolves.toEqual({
      kind: "completed",
      value: "yolo",
    });
    expect(executor).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
  });

  it("executes in yolo mode despite a denying policy", async () => {
    const policy = vi.fn(async () => ({ kind: "deny" as const, reason: "blocked by policy" }));
    const { engine, review } = createEngine(
      async () => ({ kind: "deny", rationale: "must not review" }),
      { policy: { check: policy } },
    );
    const turn = engine.beginTurn(snapshot({ mode: "yolo", baseSandboxPolicy: undefined }));
    const executor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("unrestricted");
      return completed("allowed");
    });

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "allowed",
    });
    expect(policy).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("allows a yolo host-admission call without a preview", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "deny",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(
      snapshot({ mode: "yolo", baseSandboxPolicy: undefined, sandboxReady: false }),
    );
    const executor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("unrestricted");
      return completed("host result");
    });

    await expect(turn.execute(call(executor, { ownership: "host-admission" }))).resolves.toEqual({
      kind: "completed",
      value: "host result",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("does not persist a yolo permission amendment when returning to auto", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "yes" }));
    const yolo = engine.beginTurn(snapshot({ mode: "yolo", baseSandboxPolicy: undefined }));
    const yoloExecutor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("unrestricted");
      return completed("ack");
    });
    await expect(
      yolo.execute(
        call(yoloExecutor, {
          ownership: "permission-amendment",
          intent: {
            kind: "permission-amendment",
            requested: writeOutsidePreview(),
            scope: "session",
          },
        }),
      ),
    ).resolves.toEqual({ kind: "completed", value: "ack" });
    yolo.close();

    const auto = engine.beginTurn(snapshot({ turnId: "auto-after-yolo" }));
    await expect(
      auto.execute(
        call(
          vi.fn(async () => completed("auto")),
          { admission: reviewAdmission() },
        ),
      ),
    ).resolves.toEqual({ kind: "completed", value: "auto" });
    expect(review).toHaveBeenCalledOnce();
  });

  it("rejects an aborted call before invoking its executor", async () => {
    const { engine } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const turn = engine.beginTurn(snapshot());
    const controller = new AbortController();
    controller.abort();
    const executor = vi.fn(async () => completed("never"));

    const result = await turn.execute(call(executor, { signal: controller.signal }));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("aborted");
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps the turn snapshot immutable after beginTurn", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const input: Parameters<ApproveForMeEngine["beginTurn"]>[0] = snapshot();
    const turn = engine.beginTurn(input);
    input.mode = "yolo";
    input.cwd = "/other";
    input.configFingerprint = "mutated";
    const executor = vi.fn(async (attempt) => {
      expect(attempt.lease.mode).toBe("sandboxed");
      return completed("stable");
    });

    await expect(turn.execute(call(executor))).resolves.toEqual({
      kind: "completed",
      value: "stable",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("uses one canonical action snapshot across policy, review, and execution", async () => {
    let releasePolicy: (decision: { kind: "allow" }) => void = () => undefined;
    const policyGate = new Promise<{ kind: "allow" }>((resolve) => {
      releasePolicy = resolve;
    });
    const policy = vi.fn(
      async (input: { call: InvocationCall; requested: readonly CapabilityRequest[] }) => {
        (input.call.input as { command: string }).command = "mutated by policy";
        (input.requested as CapabilityRequest[])[0] = {
          kind: "filesystem",
          operation: "write",
          path: "/outside/policy-mutated.txt",
        };
        return policyGate;
      },
    );
    const review = vi.fn(async (input: GuardianReviewInput) => {
      expect(input.call.input).toEqual({ command: "printf safe" });
      expect(input.requested).toEqual([
        { kind: "filesystem", operation: "write", path: "/outside/original.txt" },
      ]);
      (input.call.input as { command: string }).command = "mutated by Guardian";
      (input.requested as CapabilityRequest[])[0] = {
        kind: "filesystem",
        operation: "write",
        path: "/outside/guardian-mutated.txt",
      };
      return { kind: "approve" as const, rationale: "The canonical action is approved." };
    });
    const engine = createApproveForMeEngine({ guardian: { review }, policy: { check: policy } });
    const turn = engine.beginTurn(snapshot());
    const mutableInput = { command: "printf safe" };
    const mutableRequested: CapabilityRequestInput[] = [
      { kind: "filesystem", operation: "write", path: "/outside/original.txt" },
    ];
    const mutableAdmission: Extract<AdmissionPlan, { kind: "review" }> = {
      kind: "review",
      risk: "REVIEW",
      requested: mutableRequested,
      review: "capability",
      reason: "The operation needs a capability outside the baseline lease.",
    };
    const executor = vi.fn(async (attempt: ExecutionAttempt) => {
      expect(attempt.call.input).toEqual({ command: "printf safe" });
      expect(attempt.lease.policy?.filesystem.allowWrite).toContain("/outside/original.txt");
      return completed("canonical");
    });

    const result = turn.execute(
      call(executor, {
        call: {
          id: "canonical-action",
          tool: "bash",
          input: mutableInput,
          cwd: "/workspace",
        },
        admission: mutableAdmission,
      }),
    );
    await vi.waitFor(() => expect(policy).toHaveBeenCalledOnce());
    mutableInput.command = "printf destructive";
    mutableRequested[0] = {
      kind: "filesystem",
      operation: "write",
      path: "/outside/changed.txt",
    };
    releasePolicy({ kind: "allow" });

    await expect(result).resolves.toEqual({ kind: "completed", value: "canonical" });
    expect(review).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rejects an executor completion that arrives after invalidation", async () => {
    let release: (value: RuntimeOutcome<unknown>) => void = () => undefined;
    const pending = new Promise<RuntimeOutcome<unknown>>((resolve) => {
      release = resolve;
    });
    const { engine } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(() => pending);
    const resultPromise = turn.execute(call(executor));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    engine.invalidate("session changed");
    release(completed("too late"));

    const result = await resultPromise;
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("stale-invocation");
  });

  it("retains in-flight ownership across invalidation until the old executor settles", async () => {
    let release: (value: RuntimeOutcome<unknown>) => void = () => undefined;
    const pending = new Promise<RuntimeOutcome<unknown>>((resolve) => {
      release = resolve;
    });
    const { engine } = createEngine(async () => ({ kind: "approve", rationale: "unused" }));
    const first = engine.beginTurn(snapshot());
    const executor = vi.fn(() => pending);
    const firstPromise = first.execute(call(executor));
    await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
    engine.invalidate("session changed");

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    const concurrent = await second.execute(call(vi.fn(async () => completed("must wait"))));
    expect(concurrent.kind).toBe("blocked");
    if (concurrent.kind === "blocked") expect(concurrent.error.code).toBe("concurrent-invocation");

    release(completed("too late"));
    await expect(firstPromise).resolves.toMatchObject({
      kind: "blocked",
      error: { code: "stale-invocation" },
    });
    await expect(
      second.execute(call(vi.fn(async () => completed("after release")))),
    ).resolves.toEqual({
      kind: "completed",
      value: "after release",
    });
  });

  it("invalidates a late Guardian result and never executes a stale grant", async () => {
    let release!: (value: { kind: "approve"; rationale: string }) => void;
    const pending = new Promise<{ kind: "approve"; rationale: string }>((resolve) => {
      release = resolve;
    });
    const { engine } = createEngine(async () => pending);
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("never"));
    const resultPromise = turn.execute(call(executor, { admission: reviewAdmission() }));
    engine.invalidate("session changed");
    release({ kind: "approve", rationale: "too late" });

    const result = await resultPromise;
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("stale-invocation");
    expect(executor).not.toHaveBeenCalled();
  });

  it("opens the denial circuit after three Guardian denials", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "deny", rationale: "No." }));
    const turn = engine.beginTurn(snapshot());
    for (let index = 0; index < 3; index += 1) {
      const result = await turn.execute(
        call(
          vi.fn(async () => completed("never")),
          {
            call: {
              id: `call-${index}`,
              tool: "bash",
              input: { command: `printf ${index}` },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      );
      expect(result.kind).toBe("blocked");
    }
    const fourth = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "call-4",
            tool: "bash",
            input: { command: "printf 4" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(fourth.kind).toBe("blocked");
    if (fourth.kind === "blocked") expect(fourth.error.code).toBe("circuit-open");
    expect(review).toHaveBeenCalledTimes(3);
  });

  it("resets the denial breaker for each turn while retaining session identity", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "deny", rationale: "No." }));
    const first = engine.beginTurn(snapshot());
    for (let index = 0; index < 3; index += 1) {
      const result = await first.execute(
        call(
          vi.fn(async () => completed("never")),
          {
            call: {
              id: `breaker-${index}`,
              tool: "bash",
              input: { command: `printf ${index}` },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      );
      expect(result.kind).toBe("blocked");
    }
    first.close();

    const second = engine.beginTurn(snapshot({ turnId: "turn-2" }));
    const result = await second.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "breaker-next-turn",
            tool: "bash",
            input: { command: "printf next" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("review-denied");
    expect(review).toHaveBeenCalledTimes(4);
  });

  it("opens the denial breaker after ten denials in a fifty-call window", async () => {
    const { engine, review } = createEngine(async () => ({ kind: "deny", rationale: "No." }), {
      maxConsecutiveDenials: 50,
      denialWindowSize: 50,
      maxWindowDenials: 10,
    });
    const turn = engine.beginTurn(snapshot());
    for (let index = 0; index < 10; index += 1) {
      const result = await turn.execute(
        call(
          vi.fn(async () => completed("never")),
          {
            call: {
              id: `window-${index}`,
              tool: "bash",
              input: { command: `printf ${index}` },
              cwd: "/workspace",
            },
            admission: reviewAdmission(),
          },
        ),
      );
      expect(result.kind).toBe("blocked");
    }
    const eleventh = await turn.execute(
      call(
        vi.fn(async () => completed("never")),
        {
          call: {
            id: "window-eleventh",
            tool: "bash",
            input: { command: "printf 11" },
            cwd: "/workspace",
          },
          admission: reviewAdmission(),
        },
      ),
    );
    expect(eleventh.kind).toBe("blocked");
    if (eleventh.kind === "blocked") expect(eleventh.error.code).toBe("circuit-open");
    expect(review).toHaveBeenCalledTimes(10);
  });

  it("fails closed for sandbox network constraints that SandboxPolicy cannot express", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "must not review",
    }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("must not run"));
    const result = await turn.execute(
      call(executor, {
        admission: reviewAdmission([
          { kind: "network", host: "example.com", port: 443, protocol: "https" },
        ]),
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("enforcement-unavailable");
    expect(review).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("applies hard runtime policy before Guardian review", async () => {
    const policy = vi.fn(
      async (request: { phase: "preview" | "runtime" | "permission-amendment" }) =>
        request.phase === "runtime"
          ? { kind: "deny" as const, reason: "runtime capability is forbidden" }
          : { kind: "allow" as const },
    );
    const { engine, review } = createEngine(
      async () => ({ kind: "approve", rationale: "must not review" }),
      { policy: { check: policy } },
    );
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () =>
      denied({ kind: "filesystem", operation: "write", path: "/outside/result.txt" }),
    );
    const result = await turn.execute(call(executor));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("policy-denied");
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ phase: "runtime" }));
    expect(review).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledOnce();
  });

  it("returns policy-error when the hard policy adapter throws", async () => {
    const policy = vi.fn(
      async (request: { phase: "preview" | "runtime" | "permission-amendment" }) => {
        if (request.phase === "runtime") throw new Error("policy unavailable");
        return { kind: "allow" as const };
      },
    );
    const { engine, review } = createEngine(
      async () => ({ kind: "approve", rationale: "must not review" }),
      { policy: { check: policy } },
    );
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () =>
      denied({ kind: "filesystem", operation: "write", path: "/outside/result.txt" }),
    );
    const result = await turn.execute(call(executor));
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("policy-error");
    expect(review).not.toHaveBeenCalled();
  });

  it("allows only one in-flight owner for a call id", async () => {
    let releaseReview: (value: { kind: "approve"; rationale: string }) => void = () => undefined;
    const pendingReview = new Promise<{ kind: "approve"; rationale: string }>((resolve) => {
      releaseReview = resolve;
    });
    const { engine, review } = createEngine(async () => pendingReview);
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => completed("ok"));
    const firstPromise = turn.execute(call(executor, { admission: reviewAdmission() }));
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());

    const second = await turn.execute(call(executor, { admission: reviewAdmission() }));
    expect(second.kind).toBe("blocked");
    if (second.kind === "blocked") expect(second.error.code).toBe("concurrent-invocation");
    releaseReview({ kind: "approve", rationale: "one owner" });
    await expect(firstPromise).resolves.toEqual({ kind: "completed", value: "ok" });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("fails closed when sandbox-owned process or credential enforcement is unavailable", async () => {
    const unsupported: CapabilityRequest[] = [
      { kind: "process", executable: "git" },
      { kind: "credential", name: "TOKEN" },
    ];
    for (const request of unsupported) {
      const { engine, review } = createEngine(async () => ({
        kind: "approve",
        rationale: "must not run",
      }));
      const turn = engine.beginTurn(snapshot());
      const executor = vi.fn(async () => completed("must not run"));
      const result = await turn.execute(call(executor, { admission: reviewAdmission([request]) }));
      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.error.code).toBe("enforcement-unavailable");
      expect(review).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
    }
  });

  it("fails closed on unsupported runtime capabilities before runtime review", async () => {
    const cases: Array<{
      ownership: Invocation<unknown>["ownership"];
      request: CapabilityRequest;
      admission: AdmissionPlan;
    }> = [
      {
        ownership: "sandbox-owned",
        request: { kind: "external-tool", provider: "mail", name: "send" },
        admission: { kind: "allow" },
      },
      {
        ownership: "sandbox-owned",
        request: { kind: "network", host: "example.com", port: 443 },
        admission: { kind: "allow" },
      },
      {
        ownership: "host-admission",
        request: { kind: "filesystem", operation: "write", path: "/outside/result.txt" },
        admission: {
          kind: "allow",
          requested: [{ kind: "external-tool", provider: "mail", name: "send" }],
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { engine, review } = createEngine(async () => ({
        kind: "approve",
        rationale: "must not review runtime capability",
      }));
      const turn = engine.beginTurn(snapshot());
      const executor = vi.fn(async () => denied(testCase.request));
      const result = await turn.execute(
        call(executor, {
          ownership: testCase.ownership,
          admission: testCase.admission,
          call: {
            id: `unsupported-runtime-${index}`,
            tool: "test",
            input: { index },
            cwd: "/workspace",
          },
        }),
      );

      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.error.code).toBe(
          testCase.request.kind === "network" ? "runtime-denied" : "enforcement-unavailable",
        );
        expect(result.error.request).toEqual(testCase.request);
      }
      expect(executor).toHaveBeenCalledOnce();
      expect(review).not.toHaveBeenCalled();
    }
  });

  it("fails closed on an unsupported permission-amendment runtime denial", async () => {
    const { engine, review } = createEngine(async () => ({
      kind: "approve",
      rationale: "approve the declared amendment",
    }));
    const turn = engine.beginTurn(snapshot());
    const executor = vi.fn(async () => denied({ kind: "process", executable: "git" }));
    const result = await turn.execute(
      call(executor, {
        ownership: "permission-amendment",
        intent: {
          kind: "permission-amendment",
          requested: writeOutsidePreview(),
          scope: "turn",
        },
      }),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") expect(result.error.code).toBe("enforcement-unavailable");
    expect(executor).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  });
});
