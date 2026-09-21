import { describe, expect, it } from "vitest";
import {
  assertNonEmptyResiduals,
  ensureNonEmptyResiduals,
  hasResiduals,
  isResidualSignal,
  mapReviewSource,
  normalizeResidualSignals,
  RESIDUAL_SIGNALS,
  residualSignalsForReviewSource,
  residualsForPrompt,
} from "../src/permissions/residual.ts";
import { admissionPlanFromRiskDecision } from "../src/pi-approve-for-me-adapters.ts";
import type { RiskDecision } from "../src/risk-policy.ts";

describe("residual closed union", () => {
  it("exposes only the documented snake_case signals", () => {
    expect([...RESIDUAL_SIGNALS].sort()).toEqual(
      [
        "action_review",
        "capability_uncovered",
        "escalation",
        "host_admission_review",
        "inline_network_uncovered",
        "manual_retry",
        "native_recovery",
        "network_uncovered",
        "other_explicit_review",
        "permission_amendment",
        "risk_not_low",
        "rule_ask",
        "rule_deny",
        "write_root_uncovered",
      ].sort(),
    );
    for (const signal of RESIDUAL_SIGNALS) expect(isResidualSignal(signal)).toBe(true);
    expect(isResidualSignal("skip_because_empty")).toBe(false);
    expect(isResidualSignal(1)).toBe(false);
  });
});

describe("residual helpers", () => {
  it("treats empty or missing residuals as absent", () => {
    expect(hasResiduals(undefined)).toBe(false);
    expect(hasResiduals([])).toBe(false);
    expect(hasResiduals(["rule_ask"])).toBe(true);
  });

  it("never maps missing residuals to an empty skip list", () => {
    expect(ensureNonEmptyResiduals(undefined)).toEqual(["other_explicit_review"]);
    expect(ensureNonEmptyResiduals([])).toEqual(["other_explicit_review"]);
    expect(ensureNonEmptyResiduals(["escalation"])).toEqual(["escalation"]);
  });

  it("assertNonEmptyResiduals rejects empty stamps", () => {
    expect(() => assertNonEmptyResiduals(undefined)).toThrow(/non-empty/);
    expect(() => assertNonEmptyResiduals([])).toThrow(/non-empty/);
    expect(assertNonEmptyResiduals(["rule_ask"])).toEqual(["rule_ask"]);
  });

  it("stamps the most specific prompt facts known", () => {
    expect(residualsForPrompt({ ruleAsk: true, risk: "LOW" })).toEqual(["rule_ask"]);
    expect(residualsForPrompt({ escalation: true, risk: "LOW" })).toEqual(["escalation"]);
    expect(residualsForPrompt({ risk: "REVIEW" })).toEqual(["risk_not_low"]);
    expect(
      residualsForPrompt({
        permissionAmendment: true,
        networkUncovered: true,
        risk: "REVIEW",
      }),
    ).toEqual(["permission_amendment", "network_uncovered", "risk_not_low"]);
    expect(residualsForPrompt({ writeUncovered: true, risk: "REVIEW" })).toEqual([
      "write_root_uncovered",
      "risk_not_low",
    ]);
  });

  it("maps Engine review sources for metrics only", () => {
    expect(residualSignalsForReviewSource("manual-retry")).toEqual(["manual_retry"]);
    expect(residualSignalsForReviewSource("permission-amendment")).toEqual([
      "permission_amendment",
    ]);
    expect(residualSignalsForReviewSource("preview")).toEqual(["other_explicit_review"]);
    expect(residualSignalsForReviewSource("inline")).toEqual(["other_explicit_review"]);
    expect(mapReviewSource("inline")).toBe("inline");
    expect(mapReviewSource("permission-amendment")).toBe("permission-amendment");
    expect(mapReviewSource(undefined)).toBe("unknown");
  });

  it("normalizeResidualSignals accepts closed members and rejects open strings", () => {
    expect(normalizeResidualSignals(undefined)).toBeUndefined();
    expect(normalizeResidualSignals([])).toBe(false);
    expect(normalizeResidualSignals(["rule_ask", "rule_ask", "escalation"])).toEqual([
      "rule_ask",
      "escalation",
    ]);
    expect(normalizeResidualSignals(["not_a_signal"])).toBe(false);
  });
});

describe("admission residual fail-closed projection", () => {
  it("allow has empty/absent residuals", () => {
    const allow: RiskDecision = { action: "allow", risk: "LOW", reason: "Low-risk operation" };
    expect(admissionPlanFromRiskDecision(allow)).toEqual({ kind: "allow" });
  });

  it("passes stamped prompt residuals through the admission projection", () => {
    const prompt: RiskDecision = {
      action: "prompt",
      risk: "LOW",
      reason: "Approval required by permissions rule",
      summary: "npm test",
      residuals: ["rule_ask"],
    };
    expect(admissionPlanFromRiskDecision(prompt)).toEqual({
      kind: "review",
      review: "action",
      risk: "LOW",
      reason: "Approval required by permissions rule",
      summary: "npm test",
      residuals: ["rule_ask"],
    });
  });

  it("never turns a missing-residuals review into allow", () => {
    const unstamped: RiskDecision = {
      action: "prompt",
      risk: "REVIEW",
      reason: "The action needs review",
      summary: "custom tool",
    };
    const plan = admissionPlanFromRiskDecision(unstamped);
    expect(plan.kind).toBe("review");
    expect(plan).toMatchObject({ residuals: ["other_explicit_review"] });
  });
});
