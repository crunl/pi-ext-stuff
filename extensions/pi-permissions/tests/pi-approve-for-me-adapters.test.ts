import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityRequestInput, GuardianReviewInput } from "../src/approve-for-me-engine.ts";
import type {
  AutoReviewApprovalOverride,
  AutoReviewerContext,
  AutoReviewRequest,
  AutoReviewResult,
} from "../src/auto-review-request.ts";
import { type AutoReviewer, AutoReviewerFailure } from "../src/auto-reviewer.ts";
import {
  admissionPlanFromRiskDecision,
  createPiGuardianAdapter,
  type PiGuardianReviewContext,
} from "../src/pi-approve-for-me-adapters.ts";
import type { RiskDecision } from "../src/risk-policy.ts";
import type { SandboxPolicy } from "../src/sandbox.ts";

const basePolicy: SandboxPolicy = {
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

const event: ToolCallEvent = {
  type: "tool_call",
  toolCallId: "call-1",
  toolName: "bash",
  input: { command: "npm test" },
};

const autoReviewerContext = {
  modelRegistry: {
    find: vi.fn(),
    getApiKeyAndHeaders: vi.fn(),
  },
  guardianSession: {
    cwd: "/workspace",
    configFingerprint: "config-1",
  },
} as unknown as AutoReviewerContext;

function reviewResult(decision: AutoReviewResult["decision"] = "approve"): AutoReviewResult {
  return {
    decision,
    risk: decision === "approve" ? "low" : "high",
    userAuthorization: decision === "approve" ? "high" : "low",
    rationale: decision === "approve" ? "The action is authorized." : "The action is unsafe.",
  };
}

function createReviewer(result: AutoReviewResult = reviewResult()): {
  reviewer: AutoReviewer;
  review: ReturnType<typeof vi.fn<AutoReviewer["review"]>>;
} {
  const review = vi.fn<AutoReviewer["review"]>().mockResolvedValue(result);
  return {
    reviewer: {
      invalidateSession: vi.fn(),
      review,
    },
    review,
  };
}

function guardianContext(
  overrides: Partial<PiGuardianReviewContext> = {},
): PiGuardianReviewContext {
  return {
    event,
    transcript: [{ role: "user", content: "Run the tests." }],
    autoReviewerContext,
    sandboxProfile: "workspace-write",
    sandboxEnabled: true,
    baseSandboxPolicy: basePolicy,
    ...overrides,
  };
}

function reviewInput(
  overrides: Partial<GuardianReviewInput<PiGuardianReviewContext>> = {},
): GuardianReviewInput<PiGuardianReviewContext> {
  return {
    call: {
      id: "call-1",
      tool: "bash",
      input: { command: "npm test" },
      cwd: "/workspace",
    },
    ownership: "sandbox-owned",
    requested: [],
    source: "preview",
    baseline: { mode: "sandboxed", policy: basePolicy },
    effective: { mode: "sandboxed", policy: basePolicy },
    transcript: [{ role: "user", content: "Run the tests." }],
    context: guardianContext(),
    ...overrides,
  };
}

describe("admissionPlanFromRiskDecision", () => {
  it("maps allow to an allow plan", () => {
    const decision: RiskDecision = {
      action: "allow",
      risk: "LOW",
      reason: "Low-risk operation",
    };
    expect(admissionPlanFromRiskDecision(decision)).toEqual({ kind: "allow" });
  });

  it("maps block to a deny plan and preserves the reason", () => {
    const decision: RiskDecision = {
      action: "block",
      risk: "HARD",
      reason: "Protected path",
    };
    expect(admissionPlanFromRiskDecision(decision)).toEqual({
      kind: "deny",
      reason: "Protected path",
    });
  });

  it("maps requested network and filesystem capabilities to a capability review", () => {
    const decision: RiskDecision = {
      action: "prompt",
      risk: "REVIEW",
      reason: "Outside the baseline",
      summary: "npm test",
      networkHosts: ["registry.npmjs.org"],
      filesystemWriteRoots: ["/workspace/generated"],
    };
    expect(admissionPlanFromRiskDecision(decision)).toEqual({
      kind: "review",
      requested: [
        { kind: "network", host: "registry.npmjs.org" },
        { kind: "filesystem", operation: "write", path: "/workspace/generated" },
      ],
      review: "capability",
      risk: "REVIEW",
      reason: "Outside the baseline",
      summary: "npm test",
    });
  });

  it("maps a prompt without capabilities to an action review", () => {
    const decision: RiskDecision = {
      action: "prompt",
      risk: "REVIEW",
      reason: "The action needs review",
      summary: "custom tool",
    };
    expect(admissionPlanFromRiskDecision(decision)).toEqual({
      kind: "review",
      review: "action",
      risk: "REVIEW",
      reason: "The action needs review",
      summary: "custom tool",
    });
  });
});

describe("createPiGuardianAdapter", () => {
  it("rejects an event whose identity differs from the Engine call", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const input = reviewInput({
      context: guardianContext({
        event: { ...event, toolCallId: "different-call" },
      }),
    });

    await expect(adapter.review(input)).rejects.toThrow(/identity/);
    expect(review).not.toHaveBeenCalled();
  });

  it("rejects supplemental host metadata that differs from the Engine call", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const input = reviewInput({
      call: {
        id: "call-1",
        tool: "bash",
        input: { command: "npm test" },
        cwd: "/workspace",
        metadata: { account: "production" },
      },
      context: guardianContext({
        event: { ...event, account: "staging" } as unknown as ToolCallEvent,
      }),
    });

    await expect(adapter.review(input)).rejects.toThrow(/identity/);
    expect(review).not.toHaveBeenCalled();
  });

  it("passes effective turn, session, and one-shot policy data to Guardian", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const effectivePolicy: SandboxPolicy = {
      filesystem: {
        allowWrite: ["/workspace", "/workspace/turn", "/workspace/one-shot"],
        denyRead: ["/secret"],
        denyWrite: ["/secret"],
      },
      network: {
        allowedDomains: ["example.com", "session.example", "turn.example"],
        deniedDomains: ["localhost"],
      },
    };
    const requested: CapabilityRequestInput[] = [
      { kind: "network", host: "turn.example" },
      { kind: "filesystem", operation: "write", path: "/workspace/one-shot" },
    ];

    await adapter.review(
      reviewInput({
        requested,
        risk: "HARD",
        effective: { mode: "sandboxed", policy: effectivePolicy },
        reason: "Needs the generated output directory",
        summary: "npm test",
      }),
    );

    const request = review.mock.calls[0]?.[0] as AutoReviewRequest | undefined;
    expect(request).toBeDefined();
    expect(request?.permissionContext).toMatchObject({
      sandboxProfile: "workspace-write",
      sandboxEnforcesAction: true,
      filesystemWriteRoots: ["/workspace", "/workspace/turn", "/workspace/one-shot"],
      filesystemDenyRead: ["/secret"],
      filesystemDenyWrite: ["/secret"],
      requestedNetworkHosts: ["turn.example"],
      allowedNetworkHosts: ["example.com", "session.example", "turn.example"],
      deniedNetworkHosts: ["localhost"],
      staticRisk: "HARD",
      staticReason: "Needs the generated output directory",
    });
    expect(request?.untrustedAction.toolCallId).toBe("call-1");
  });

  it("does not present coding-agent sandbox roots as enforcement for a host tool", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const hostPolicy: SandboxPolicy = {
      ...basePolicy,
      filesystem: {
        ...basePolicy.filesystem,
        allowWrite: ["/workspace", "/host-admission-base"],
      },
    };
    await adapter.review(
      reviewInput({
        ownership: "host-admission",
        requested: [{ kind: "external-tool", provider: "mail", name: "send" }],
        baseline: { mode: "host-admitted" },
        effective: { mode: "host-admitted" },
        context: guardianContext({ baseSandboxPolicy: hostPolicy, sandboxEnabled: true }),
      }),
    );

    const request = review.mock.calls[0]?.[0] as AutoReviewRequest | undefined;
    expect(request?.permissionContext.filesystemWriteRoots).toEqual([]);
    expect(request?.permissionContext.sandboxEnforcesAction).toBe(false);
    expect(request?.permissionContext.allowedNetworkHosts).toEqual([]);
  });

  it("passes the Engine-generated manual retry override unchanged", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const approvalOverride: AutoReviewApprovalOverride = {
      denialId: "denial-1",
      actionFingerprint: "fingerprint-1",
    };
    const input = {
      ...reviewInput({ source: "manual-retry" }),
      approvalOverride,
    } as GuardianReviewInput<PiGuardianReviewContext> & {
      approvalOverride: AutoReviewApprovalOverride;
    };

    await adapter.review(input);

    const request = review.mock.calls[0]?.[0] as AutoReviewRequest | undefined;
    expect(request?.approvalOverride).toBe(approvalOverride);
  });

  it("passes the trusted reviewer context and signal through", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);
    const controller = new AbortController();

    await adapter.review(reviewInput(), controller.signal);

    expect(review.mock.calls[0]?.[1]).toBe(autoReviewerContext);
    expect(review.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it("uses the immutable action-admission transcript snapshot", async () => {
    const { reviewer, review } = createReviewer();
    const adapter = createPiGuardianAdapter(reviewer);

    await adapter.review(
      reviewInput({
        transcript: [{ role: "user", content: "Stale turn-start evidence." }],
        context: guardianContext({
          transcript: [{ role: "user", content: "Current action authorization." }],
        }),
      }),
    );

    const request = review.mock.calls[0]?.[0] as AutoReviewRequest | undefined;
    expect(request?.untrustedTranscript).toEqual([
      { role: "user", content: "Current action authorization." },
    ]);
  });

  it.each([
    ["approve" as const, "approve" as const],
    ["deny" as const, "deny" as const],
  ])("maps AutoReviewer %s to the Engine decision", async (decision, expected) => {
    const result = reviewResult(decision);
    const { reviewer } = createReviewer(result);
    const adapter = createPiGuardianAdapter(reviewer);

    await expect(adapter.review(reviewInput())).resolves.toEqual({
      kind: expected,
      rationale: result.rationale,
    });
  });

  it("reports the full AutoReviewResult to the host callback", async () => {
    const result = reviewResult("approve");
    const onResult = vi.fn<(value: AutoReviewResult) => void>();
    const { reviewer } = createReviewer(result);
    const adapter = createPiGuardianAdapter(reviewer);

    await adapter.review(reviewInput({ context: guardianContext({ onResult }) }));

    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("keeps the Guardian decision when the host result observer throws", async () => {
    const result = reviewResult("approve");
    const { reviewer } = createReviewer(result);
    const adapter = createPiGuardianAdapter(reviewer);

    await expect(
      adapter.review(
        reviewInput({
          context: guardianContext({
            onResult: () => {
              throw new Error("review UI unavailable");
            },
          }),
        }),
      ),
    ).resolves.toEqual({ kind: "approve", rationale: result.rationale });
  });

  it("maps reviewer failures into typed Guardian terminal outcomes", async () => {
    const error = new Error("review provider unavailable");
    const review = vi.fn<AutoReviewer["review"]>().mockRejectedValue(error);
    const reviewer: AutoReviewer = {
      invalidateSession: vi.fn(),
      review,
    };
    const adapter = createPiGuardianAdapter(reviewer);

    await expect(adapter.review(reviewInput())).resolves.toEqual({
      kind: "failed",
      reason: "review provider unavailable",
    });

    review.mockRejectedValueOnce(new AutoReviewerFailure("timeout", "review timed out"));
    await expect(adapter.review(reviewInput())).resolves.toEqual({ kind: "timed-out" });

    review.mockRejectedValueOnce(new AutoReviewerFailure("cancelled", "review cancelled"));
    await expect(adapter.review(reviewInput())).resolves.toEqual({ kind: "cancelled" });
  });
});
