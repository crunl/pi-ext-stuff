import { describe, expect, it } from "vitest";
import {
  causeToResidual,
  ensureNonEmptyResiduals,
  hasResiduals,
  isResidualSignal,
  mapReviewSource,
  normalizeResidualSignals,
  RESIDUAL_SIGNALS,
  residualSignalsForReviewSource,
  residualsForPrompt,
} from "../src/permissions/residual.ts";
import type { ReviewCause } from "../src/permissions/risk.ts";
import { admissionPlanFromRiskDecision } from "../src/pi-approve-for-me-adapters.ts";
import type { RiskDecision } from "../src/risk-policy.ts";

describe("residual closed union", () => {
  it("exposes only the documented snake_case signals", () => {
    expect([...RESIDUAL_SIGNALS].sort()).toEqual(
      [
        "action_review",
        "capability_uncovered",
        "command_word_unproven",
        "env_context_unproven",
        "escalation",
        "heredoc_unproven",
        "host_admission_review",
        "inline_network_uncovered",
        "lex_incomplete",
        "manual_retry",
        "native_recovery",
        "network_uncovered",
        "nested_git_program",
        "other_explicit_review",
        "permission_amendment",
        "process_control",
        "program_reinterpreted",
        "remote_effect_unclassified",
        "risk_not_skip",
        "rule_ask",
        "rule_deny",
        "state_crosses_segments",
        "substitution_unproven",
        "wrapper_unreduced",
        "write_root_uncovered",
      ].sort(),
    );
    for (const signal of RESIDUAL_SIGNALS) expect(isResidualSignal(signal)).toBe(true);
    expect(isResidualSignal("skip_because_empty")).toBe(false);
    expect(isResidualSignal(1)).toBe(false);
  });

  // `risk_not_<x>` is the one signal that names a disposition value rather than a
  // cause, and it is therefore the one that can silently outlive a rename: the
  // tag is a hand-written literal while the value it negates comes from
  // `ApprovalDisposition`. When `LOW` became `Skip` the tag kept saying `low`
  // and the metrics stream reported a disposition that no longer existed. These
  // two assertions tie the tag to the value again — the second one fails to
  // compile if the vocabulary moves, which is the point.
  it("names the current auto-approve disposition in the negated risk signal", () => {
    const negated = RESIDUAL_SIGNALS.filter((signal) => signal.startsWith("risk_not_"));
    expect(negated).toEqual(["risk_not_skip"]);
  });

  it("produces the negated risk signal from the value it names", () => {
    expect(residualsForPrompt({ risk: "Skip" })).not.toContain("risk_not_skip");
    expect(residualsForPrompt({ risk: "NeedsApproval" })).toContain("risk_not_skip");
    expect(residualsForPrompt({ risk: "Forbidden" })).toContain("risk_not_skip");
  });
});

describe("static review cause co-stamp", () => {
  // Totality lives in the compiler: `causeToResidual` has no default case, so
  // a new `ReviewCause` member fails `check` until it is mapped here too.
  const allCauses = [
    "process_control",
    "env_context_unproven",
    "state_crosses_segments",
    "remote_effect_unclassified",
    "lex_incomplete",
    "wrapper_unreduced",
    "nested_git_program",
    "command_word_unproven",
    "program_reinterpreted",
    "substitution_unproven",
    "heredoc_unproven",
    "unproven_other",
  ] as const satisfies readonly ReviewCause[];

  it("maps every cause to a closed-vocabulary signal", () => {
    for (const cause of allCauses) expect(isResidualSignal(causeToResidual(cause))).toBe(true);
    // The defensive member must look like an unnamed stamp, not a new bucket.
    expect(causeToResidual("unproven_other")).toBe("other_explicit_review");
    expect(causeToResidual("substitution_unproven")).toBe("substitution_unproven");
  });

  it("co-stamps next to action_review without replacing a bucket", () => {
    expect(
      residualsForPrompt({
        risk: "NeedsApproval",
        actionReview: true,
        cause: "substitution_unproven",
      }),
    ).toEqual(["action_review", "substitution_unproven", "risk_not_skip"]);
    // Under escalation the cause rides along; escalation keeps its bucket.
    expect(
      residualsForPrompt({ risk: "NeedsApproval", escalation: true, cause: "process_control" }),
    ).toEqual(["escalation", "process_control", "risk_not_skip"]);
    // No cause, no change: the pre-cause arrays stay byte-identical.
    expect(residualsForPrompt({ risk: "NeedsApproval" })).toEqual(["risk_not_skip"]);
    expect(residualsForPrompt({ actionReview: true, risk: "NeedsApproval" })).toEqual([
      "action_review",
      "risk_not_skip",
    ]);
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

  it("stamps the most specific prompt facts known", () => {
    expect(residualsForPrompt({ ruleAsk: true, risk: "Skip" })).toEqual(["rule_ask"]);
    expect(residualsForPrompt({ escalation: true, risk: "Skip" })).toEqual(["escalation"]);
    expect(residualsForPrompt({ risk: "NeedsApproval" })).toEqual(["risk_not_skip"]);
    expect(
      residualsForPrompt({
        permissionAmendment: true,
        networkUncovered: true,
        risk: "NeedsApproval",
      }),
    ).toEqual(["permission_amendment", "network_uncovered", "risk_not_skip"]);
    expect(residualsForPrompt({ writeUncovered: true, risk: "NeedsApproval" })).toEqual([
      "write_root_uncovered",
      "risk_not_skip",
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
    const allow: RiskDecision = { action: "allow", risk: "Skip", reason: "Low-risk operation" };
    expect(admissionPlanFromRiskDecision(allow)).toEqual({ kind: "allow" });
  });

  it("passes stamped prompt residuals through the admission projection", () => {
    const prompt: RiskDecision = {
      action: "prompt",
      risk: "Skip",
      reason: "Approval required by permissions rule",
      summary: "npm test",
      residuals: ["rule_ask"],
    };
    expect(admissionPlanFromRiskDecision(prompt)).toEqual({
      kind: "review",
      review: "action",
      risk: "Skip",
      reason: "Approval required by permissions rule",
      summary: "npm test",
      residuals: ["rule_ask"],
    });
  });

  it("never turns a missing-residuals review into allow", () => {
    const unstamped: RiskDecision = {
      action: "prompt",
      risk: "NeedsApproval",
      reason: "The action needs review",
      summary: "custom tool",
    };
    const plan = admissionPlanFromRiskDecision(unstamped);
    expect(plan.kind).toBe("review");
    expect(plan).toMatchObject({ residuals: ["other_explicit_review"] });
  });
});
