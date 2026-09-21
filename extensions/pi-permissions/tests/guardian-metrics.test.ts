import { describe, expect, it } from "vitest";
import {
  buildGuardianMetricsRecord,
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
      staticRisk: "REVIEW",
      reviewSource: "preview",
      residualSignals: ["rule_ask", "risk_not_low"],
      durationMs: 10,
    });
    expect(record.static_risk).toBe("REVIEW");
    expect(record.review_source).toBe("preview");
    expect(record.residual_signals).toEqual(["rule_ask", "risk_not_low"]);
    expect(Object.isFrozen(record.residual_signals)).toBe(true);
  });
});
