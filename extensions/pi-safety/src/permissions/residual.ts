/** Closed residual-signal vocabulary for P0 skip-LLM fail-closed reviews. */
export const RESIDUAL_SIGNALS = [
  "rule_ask",
  "rule_deny",
  "risk_not_low",
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
] as const;

export type ResidualSignal = (typeof RESIDUAL_SIGNALS)[number];

export const FALLBACK_RESIDUAL: ResidualSignal = "other_explicit_review";

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
  risk: "LOW" | "REVIEW" | "HARD";
  writeUncovered?: boolean;
  networkUncovered?: boolean;
  permissionAmendment?: boolean;
  actionReview?: boolean;
  capabilityUncovered?: boolean;
  hostAdmissionReview?: boolean;
}): ResidualSignal[] {
  const residuals: ResidualSignal[] = [];
  if (input.ruleDeny) residuals.push("rule_deny");
  if (input.ruleAsk) residuals.push("rule_ask");
  if (input.permissionAmendment) residuals.push("permission_amendment");
  if (input.escalation) residuals.push("escalation");
  if (input.writeUncovered) residuals.push("write_root_uncovered");
  if (input.networkUncovered) residuals.push("network_uncovered");
  if (input.actionReview) residuals.push("action_review");
  if (input.hostAdmissionReview) residuals.push("host_admission_review");
  if (input.capabilityUncovered) residuals.push("capability_uncovered");
  if (input.risk !== "LOW") residuals.push("risk_not_low");
  return ensureNonEmptyResiduals(residuals);
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
