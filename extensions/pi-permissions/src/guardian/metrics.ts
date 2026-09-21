import type { AutoReviewerFailureKind } from "./errors.ts";

/** Codex-aligned terminal_status vocabulary. */
export type GuardianTerminalStatus =
  | "approved"
  | "denied"
  | "aborted"
  | "timed_out"
  | "failed_closed";

/** Codex-aligned failure_reason vocabulary. */
export type GuardianFailureReason =
  | "timeout"
  | "cancelled"
  | "session_error"
  | "parse_error"
  | "none";

export type GuardianSessionKind = "trunk_new" | "trunk_reused" | "ephemeral_forked";

export type GuardianActionTag =
  | "shell"
  | "write"
  | "edit"
  | "apply_patch"
  | "request_permissions"
  | "host_tool";

export type GuardianRequestSource = "main_turn" | "delegated_subagent";

export type GuardianOwnership = "sandbox-owned" | "host-admission" | "permission-amendment";

/** One JSONL record per review terminal state. Enums and numbers only. */
export interface GuardianMetricsRecord {
  readonly schema: 1;
  readonly reviewId: string;
  readonly timestamp: string;
  readonly terminal_status: GuardianTerminalStatus;
  readonly failure_reason: GuardianFailureReason;
  readonly action: GuardianActionTag;
  readonly approval_request_source: GuardianRequestSource;
  readonly ownership: GuardianOwnership;
  readonly session_kind: GuardianSessionKind;
  readonly had_prior_review_context: boolean;
  readonly risk_level: string;
  readonly user_authorization: string;
  readonly outcome: string;
  readonly guardian_model: string;
  readonly guardian_reasoning_effort: string;
  readonly static_risk: string;
  readonly review_source: string;
  readonly residual_signals?: readonly string[];
  readonly duration_ms: number;
  readonly token_usage: {
    readonly input: number;
    readonly output: number;
    readonly cache_read: number;
    readonly cache_write: number;
    readonly reasoning: number;
    readonly total: number;
  };
}

export function mapTerminalStatus(
  status: "approved" | "denied" | "aborted" | "timed-out" | "failed",
): GuardianTerminalStatus {
  switch (status) {
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "aborted":
      return "aborted";
    case "timed-out":
      return "timed_out";
    case "failed":
      return "failed_closed";
  }
}

export function mapFailureReason(kind: AutoReviewerFailureKind | undefined): GuardianFailureReason {
  switch (kind) {
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "parse":
      return "parse_error";
    case "provider":
    case "unavailable":
      return "session_error";
    default:
      return "none";
  }
}

export function mapActionTag(tool: string): GuardianActionTag {
  const lower = tool.toLowerCase();
  if (lower === "bash" || lower === "shell") return "shell";
  if (lower === "write") return "write";
  if (lower === "edit") return "edit";
  if (lower === "apply_patch") return "apply_patch";
  if (lower === "request_permissions") return "request_permissions";
  return "host_tool";
}

/** Low-cardinality sanitize; Codex sanitize_metric_tag_value equivalent. */
export function sanitizeMetricTag(value: string | undefined): string {
  if (!value) return "none";
  const cleaned = value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : "none";
}

export function buildGuardianMetricsRecord(input: {
  reviewId: string;
  terminalStatus: GuardianTerminalStatus;
  failureReason?: GuardianFailureReason;
  action: GuardianActionTag;
  requestSource?: GuardianRequestSource;
  ownership: GuardianOwnership;
  sessionKind: GuardianSessionKind;
  hadPriorReviewContext: boolean;
  riskLevel?: string;
  userAuthorization?: string;
  outcome?: string;
  guardianModel?: string;
  guardianReasoningEffort?: string;
  staticRisk?: string;
  reviewSource?: string;
  residualSignals?: readonly string[];
  durationMs: number;
  tokenUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
  };
}): GuardianMetricsRecord {
  const usage = input.tokenUsage ?? {};
  const residualSignals = (input.residualSignals ?? [])
    .map((tag) => sanitizeMetricTag(tag))
    .filter((tag) => tag !== "none");
  return Object.freeze({
    schema: 1 as const,
    reviewId: input.reviewId,
    timestamp: new Date().toISOString(),
    terminal_status: input.terminalStatus,
    failure_reason: input.failureReason ?? "none",
    action: input.action,
    approval_request_source: input.requestSource ?? "main_turn",
    ownership: input.ownership,
    session_kind: input.sessionKind,
    had_prior_review_context: input.hadPriorReviewContext,
    risk_level: input.riskLevel ?? "none",
    user_authorization: input.userAuthorization ?? "none",
    outcome: input.outcome ?? "none",
    guardian_model: sanitizeMetricTag(input.guardianModel),
    guardian_reasoning_effort: sanitizeMetricTag(input.guardianReasoningEffort),
    static_risk: sanitizeMetricTag(input.staticRisk ?? "none"),
    review_source: sanitizeMetricTag(input.reviewSource ?? "unknown"),
    ...(residualSignals.length > 0 ? { residual_signals: Object.freeze(residualSignals) } : {}),
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    token_usage: Object.freeze({
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cache_read: usage.cacheRead ?? 0,
      cache_write: usage.cacheWrite ?? 0,
      reasoning: usage.reasoning ?? 0,
      total: usage.total ?? 0,
    }),
  });
}
