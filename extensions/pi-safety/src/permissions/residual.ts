import type { ReviewCause } from "./risk.ts";

/** Closed residual-signal vocabulary for P0 skip-LLM fail-closed reviews. */
export const RESIDUAL_SIGNALS = [
  "rule_ask",
  "rule_deny",
  "risk_not_skip",
  "escalation",
  "write_root_uncovered",
  "network_uncovered",
  "action_review",
  "host_admission_review",
  "permission_amendment",
  "manual_retry",
  "native_recovery",
  "inline_network_uncovered",
  "capability_uncovered",
  "other_explicit_review",
  // Static review causes: which proof the static layer failed to make
  // (`ReviewCause` in ./risk.ts). They co-stamp `action_review`; they never
  // replace a bucket and never act as a skip credential. Appended as a block
  // so the pre-cause signals keep their exact history.
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
] as const;

export type ResidualSignal = (typeof RESIDUAL_SIGNALS)[number];

const FALLBACK_RESIDUAL: ResidualSignal = "other_explicit_review";

export function isResidualSignal(value: unknown): value is ResidualSignal {
  return typeof value === "string" && (RESIDUAL_SIGNALS as readonly string[]).includes(value);
}

export function hasResiduals(value: readonly ResidualSignal[] | null | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function ensureNonEmptyResiduals(
  residuals: readonly ResidualSignal[] | null | undefined,
  fallback: ResidualSignal = FALLBACK_RESIDUAL,
): ResidualSignal[] {
  if (Array.isArray(residuals) && residuals.length > 0) return [...residuals];
  return [fallback];
}

export function residualsForPrompt(input: {
  ruleAsk?: boolean;
  ruleDeny?: boolean;
  escalation?: boolean;
  risk: "Skip" | "NeedsApproval" | "Forbidden";
  writeUncovered?: boolean;
  networkUncovered?: boolean;
  permissionAmendment?: boolean;
  actionReview?: boolean;
  capabilityUncovered?: boolean;
  hostAdmissionReview?: boolean;
  /**
   * The static layer's failed proof, co-stamped next to `action_review`.
   * Orthogonal: it rides along under escalation too, and it never replaces
   * a bucket — re-bucketing would cut the `action_review` time series the
   * way the `risk_not_low` rename once cut `risk_not_skip`.
   */
  cause?: ReviewCause;
}): ResidualSignal[] {
  const residuals: ResidualSignal[] = [];
  if (input.ruleDeny) residuals.push("rule_deny");
  if (input.ruleAsk) residuals.push("rule_ask");
  if (input.permissionAmendment) residuals.push("permission_amendment");
  if (input.escalation) residuals.push("escalation");
  if (input.writeUncovered) residuals.push("write_root_uncovered");
  if (input.networkUncovered) residuals.push("network_uncovered");
  if (input.actionReview) residuals.push("action_review");
  if (input.cause !== undefined) residuals.push(causeToResidual(input.cause));
  if (input.hostAdmissionReview) residuals.push("host_admission_review");
  if (input.capabilityUncovered) residuals.push("capability_uncovered");
  if (input.risk !== "Skip") residuals.push("risk_not_skip");
  return ensureNonEmptyResiduals(residuals);
}

/**
 * Total mapping from a static review cause to the residual signal that
 * co-stamps it. `unproven_other` deliberately lands on `other_explicit_review`:
 * a cause no fold named must look exactly like a stamp no call site provided,
 * because both mean "this review reached the edge of the vocabulary".
 */
export function causeToResidual(cause: ReviewCause): ResidualSignal {
  switch (cause) {
    case "process_control":
      return "process_control";
    case "env_context_unproven":
      return "env_context_unproven";
    case "state_crosses_segments":
      return "state_crosses_segments";
    case "remote_effect_unclassified":
      return "remote_effect_unclassified";
    case "lex_incomplete":
      return "lex_incomplete";
    case "wrapper_unreduced":
      return "wrapper_unreduced";
    case "nested_git_program":
      return "nested_git_program";
    case "command_word_unproven":
      return "command_word_unproven";
    case "program_reinterpreted":
      return "program_reinterpreted";
    case "substitution_unproven":
      return "substitution_unproven";
    case "heredoc_unproven":
      return "heredoc_unproven";
    case "unproven_other":
      return "other_explicit_review";
  }
}

/**
 * Observational labels only — never a skip credential. Call sites should stamp
 * explicit residuals; this map is a metrics fallback when they did not.
 */
export function residualSignalsForReviewSource(source: string | undefined): ResidualSignal[] {
  switch (source) {
    case "manual-retry":
      return ["manual_retry"];
    case "permission-amendment":
      return ["permission_amendment"];
    // Network inline reviews retired; `inline` remains only for native recovery
    // fallbacks, which call sites should stamp explicitly.
    case "inline":
      return ["other_explicit_review"];
    default:
      return [FALLBACK_RESIDUAL];
  }
}

export function mapReviewSource(source: string | undefined): string {
  switch (source) {
    case "preview":
    case "inline":
    case "permission-amendment":
    case "manual-retry":
      return source;
    default:
      return "unknown";
  }
}

export function normalizeResidualSignals(value: unknown): ResidualSignal[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return false;
  const out: ResidualSignal[] = [];
  for (const item of value) {
    if (!isResidualSignal(item)) return false;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
