import { describe, expect, it } from "vitest";
import {
  buildGuardianMetricsRecord,
  formatGuardianMetricsSummary,
  summarizeGuardianMetrics,
} from "../src/guardian/metrics.ts";

function record(overrides: Record<string, unknown> = {}) {
  return buildGuardianMetricsRecord({
    reviewId: "review-1",
    terminalStatus: "approved",
    action: "shell",
    ownership: "sandbox-owned",
    sessionKind: "trunk_new",
    hadPriorReviewContext: false,
    durationMs: 100,
    ...overrides,
  });
}

describe("guardian metrics summary", () => {
  it("aggregates an empty file to zeros", () => {
    const summary = summarizeGuardianMetrics([]);
    expect(summary.total).toBe(0);
    expect(summary.byStatus).toEqual({});
    expect(summary.denialsByResidual).toEqual([]);
    expect(summary.triggersByResidual).toEqual([]);
    expect(summary.durationMs).toEqual({ p50: 0, p95: 0 });
    expect(summary.tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("counts by status and action with first-residual denial attribution", () => {
    const summary = summarizeGuardianMetrics([
      record({ reviewId: "r1", terminalStatus: "approved", action: "shell" }),
      record({
        reviewId: "r2",
        terminalStatus: "denied",
        action: "shell",
        outcome: "deny",
      }),
      record({
        reviewId: "r3",
        terminalStatus: "denied",
        action: "edit",
        outcome: "deny",
      }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byStatus).toEqual({ approved: 1, denied: 2 });
    expect(summary.byAction).toEqual({ shell: 2, edit: 1 });
    // buildGuardianMetricsRecord carries no residuals here: unattributed
    // denials aggregate under "unstamped", never silently dropped.
    expect(summary.denialsByResidual).toEqual([{ residual: "unstamped", denials: 2 }]);
  });

  it("ranks denial residuals and sums token usage", () => {
    const summary = summarizeGuardianMetrics([
      {
        ...record({ reviewId: "r1", terminalStatus: "denied" }),
        residual_signals: ["rule_ask", "risk_not_skip"],
      },
      {
        ...record({ reviewId: "r2", terminalStatus: "denied" }),
        residual_signals: ["escalation"],
      },
      {
        ...record({ reviewId: "r3", terminalStatus: "denied" }),
        residual_signals: ["rule_ask"],
      },
    ]);
    expect(summary.denialsByResidual).toEqual([
      { residual: "rule_ask", denials: 2 },
      { residual: "escalation", denials: 1 },
    ]);
    expect(summary.tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("computes duration percentiles deterministically", () => {
    const summary = summarizeGuardianMetrics(
      [10, 20, 30, 40].map((durationMs, index) => record({ reviewId: `r${index}`, durationMs })),
    );
    expect(summary.durationMs).toEqual({ p50: 20, p95: 40 });
  });

  it("ranks trigger residuals by first signal with the approved split", () => {
    const summary = summarizeGuardianMetrics([
      {
        ...record({ reviewId: "r1", terminalStatus: "approved" }),
        residual_signals: ["lex_incomplete", "risk_not_skip"],
      },
      {
        ...record({ reviewId: "r2", terminalStatus: "denied" }),
        residual_signals: ["lex_incomplete"],
      },
      record({ reviewId: "r3", terminalStatus: "denied" }),
    ]);
    // First signal is the trigger; risk_not_skip merely rode along in r1
    // and never ranks. High reviews + high approved marks pure friction.
    expect(summary.triggersByResidual).toEqual([
      { residual: "lex_incomplete", reviews: 2, approved: 1 },
      { residual: "unstamped", reviews: 1, approved: 0 },
    ]);
  });

  it("formats one bounded line per section with the reviews-only denominator note", () => {
    const summary = summarizeGuardianMetrics([
      record({ reviewId: "r1", terminalStatus: "approved", action: "shell" }),
      record({ reviewId: "r2", terminalStatus: "denied", action: "edit" }),
    ]);
    const text = formatGuardianMetricsSummary(summary);
    expect(text).toContain("reviews: 2");
    expect(text).toContain("Guardian reviews only");
    expect(text).toContain("approved=1 denied=1");
    expect(text).toContain("shell=1 edit=1");
    expect(text).toContain("unstamped=1");
    expect(text).toContain("triggers by residual:");
    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(7);
  });
});
