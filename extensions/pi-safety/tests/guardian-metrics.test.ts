import { describe, expect, it } from "vitest";
import type { GuardianDecisionMetrics, ReviewEvent } from "../src/approve-for-me-engine.ts";
import {
  buildGuardianMetricsRecord,
  guardianMetricsRecordFromEvent,
  mapActionTag,
  mapFailureReason,
  mapTerminalStatus,
} from "../src/guardian/metrics.ts";

describe("guardian metrics mapping", () => {
  it.each([
    ["approved", "approved"],
    ["denied", "denied"],
    ["aborted", "aborted"],
    ["timed-out", "timed_out"],
    ["failed", "failed_closed"],
  ] as const)("maps terminal status %s → %s", (input, expected) => {
    expect(mapTerminalStatus(input)).toBe(expected);
  });

  it.each([
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["parse", "parse_error"],
    ["provider", "session_error"],
    ["unavailable", "session_error"],
    [undefined, "none"],
  ] as const)("maps failure reason %s → %s", (input, expected) => {
    expect(mapFailureReason(input)).toBe(expected);
  });

  it.each([
    ["bash", "shell"],
    ["write", "write"],
    ["edit", "edit"],
    ["request_permissions", "request_permissions"],
    ["webfetch", "host_tool"],
  ] as const)("maps action tag %s → %s", (input, expected) => {
    expect(mapActionTag(input)).toBe(expected);
  });

  it("builds a frozen record with enums and numbers only", () => {
    const record = buildGuardianMetricsRecord({
      reviewId: "review-1",
      terminalStatus: "approved",
      action: "shell",
      ownership: "sandbox-owned",
      sessionKind: "trunk_reused",
      hadPriorReviewContext: true,
      riskLevel: "low",
      userAuthorization: "medium",
      outcome: "allow",
      guardianModel: "gpt-5",
      durationMs: 1234.7,
      tokenUsage: { input: 100, output: 20 },
    });
    expect(record.schema).toBe(1);
    expect(record.terminal_status).toBe("approved");
    expect(record.failure_reason).toBe("none");
    expect(record.session_kind).toBe("trunk_reused");
    expect(record.had_prior_review_context).toBe(true);
    expect(record.duration_ms).toBe(1235);
    expect(record.token_usage.input).toBe(100);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("sanitizes model ids and defaults missing fields", () => {
    const record = buildGuardianMetricsRecord({
      reviewId: "review-2",
      terminalStatus: "failed_closed",
      action: "host_tool",
      ownership: "host-admission",
      sessionKind: "trunk_new",
      hadPriorReviewContext: false,
      durationMs: -5,
    });
    expect(record.guardian_model).toBe("none");
    expect(record.risk_level).toBe("none");
    expect(record.static_risk).toBe("none");
    expect(record.review_source).toBe("unknown");
    expect(record.residual_signals).toBeUndefined();
    expect(record.duration_ms).toBe(0);
  });

  it("keeps additive static_risk, review_source and residual_signals schema-compatible", () => {
    const record = buildGuardianMetricsRecord({
      reviewId: "review-3",
      terminalStatus: "approved",
      action: "shell",
      ownership: "sandbox-owned",
      sessionKind: "trunk_new",
      hadPriorReviewContext: false,
      riskLevel: "low",
      outcome: "approve",
      staticRisk: "NeedsApproval",
      reviewSource: "preview",
      residualSignals: ["rule_ask", "risk_not_skip"],
      durationMs: 10,
    });
    expect(record.static_risk).toBe("NeedsApproval");
    expect(record.review_source).toBe("preview");
    expect(record.residual_signals).toEqual(["rule_ask", "risk_not_skip"]);
    expect(Object.isFrozen(record.residual_signals)).toBe(true);
  });
});

/**
 * The event → record projection was inlined in the host adapter as 23 lines of
 * conditional spreads whose only purpose was to omit `undefined` values. It is
 * now a pure function next to `mapFailureReason`, and these cases exist because
 * the adapter version had no coverage at all — the whole sink was unasserted.
 */
describe("guardian metrics projection from a review event", () => {
  const call = { id: "call-1", tool: "bash", input: {}, cwd: "/repo" };

  const terminal = (
    metrics: GuardianDecisionMetrics & { durationMs: number },
    status: "approved" | "denied" | "aborted" | "timed-out" = "denied",
  ): ReviewEvent => ({
    status,
    reviewId: "review-e1",
    call,
    ownership: "sandbox-owned",
    rationale: "because",
    metrics,
  });

  it("returns nothing for an in-flight event", () => {
    const event: ReviewEvent = {
      status: "reviewing",
      reviewId: "review-e2",
      call,
      ownership: "sandbox-owned",
    };
    expect(guardianMetricsRecordFromEvent(event)).toBeUndefined();
  });

  it("returns nothing for a terminal event with no metrics", () => {
    const event: ReviewEvent = {
      status: "denied",
      reviewId: "review-e3",
      call,
      ownership: "sandbox-owned",
      rationale: "because",
    };
    expect(guardianMetricsRecordFromEvent(event)).toBeUndefined();
  });

  it("applies every default when the metrics carry only a duration", () => {
    const record = guardianMetricsRecordFromEvent(terminal({ durationMs: 7 }));
    expect(record).toBeDefined();
    expect(record?.risk_level).toBe("none");
    expect(record?.user_authorization).toBe("none");
    expect(record?.outcome).toBe("none");
    expect(record?.guardian_model).toBe("none");
    expect(record?.static_risk).toBe("none");
    expect(record?.review_source).toBe("unknown");
    expect(record?.failure_reason).toBe("none");
    expect(record?.session_kind).toBe("trunk_new");
    expect(record?.had_prior_review_context).toBe(false);
    expect(record?.token_usage.total).toBe(0);
    expect(record?.duration_ms).toBe(7);
  });

  // This is the branch the old inline cast relied on. `failureKind` crosses a
  // process seam as an arbitrary string, and the adapter used to launder it with
  // `as Parameters<typeof mapFailureReason>[0]`, which was safe only because
  // mapFailureReason ends in `default: return "none"` — a property no test
  // asserted. If that default ever changed, an unrecognised reviewer string
  // would have been written into the metrics log as a bogus reason.
  it.each([
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["parse", "parse_error"],
    ["provider", "session_error"],
    ["unavailable", "session_error"],
    ["a kind this build has never heard of", "none"],
    ["", "none"],
  ])("narrows failureKind %s to %s", (failureKind, expected) => {
    const record = guardianMetricsRecordFromEvent(terminal({ durationMs: 1, failureKind }));
    expect(record?.failure_reason).toBe(expected);
  });

  // `residual_signals` is the only optional member of the record, so it is the
  // one place where omission rather than a default is the contract.
  it("omits residual_signals when the reviewer sent none", () => {
    expect(guardianMetricsRecordFromEvent(terminal({ durationMs: 1 }))).not.toHaveProperty(
      "residual_signals",
    );
    expect(
      guardianMetricsRecordFromEvent(terminal({ durationMs: 1, residualSignals: [] })),
    ).not.toHaveProperty("residual_signals");
  });

  it("keeps residual signals when present", () => {
    const record = guardianMetricsRecordFromEvent(
      terminal({ durationMs: 1, residualSignals: ["risk_not_skip"] }),
    );
    expect(record?.residual_signals).toEqual(["risk_not_skip"]);
  });

  it("carries the session kind and prior-context flag through", () => {
    const record = guardianMetricsRecordFromEvent(
      terminal({ durationMs: 1, sessionKind: "ephemeral_forked", hadPriorReviewContext: true }),
    );
    expect(record?.session_kind).toBe("ephemeral_forked");
    expect(record?.had_prior_review_context).toBe(true);
  });

  it("maps the tool and the terminal status", () => {
    const record = guardianMetricsRecordFromEvent(
      terminal({ durationMs: 1 }, "timed-out") as ReviewEvent,
    );
    expect(record?.action).toBe("shell");
    expect(record?.terminal_status).toBe("timed_out");
  });
});
