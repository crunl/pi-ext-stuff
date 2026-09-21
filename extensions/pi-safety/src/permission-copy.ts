import type { PermissionError } from "./approve-for-me-engine.ts";
import type { PermissionMode } from "./state.ts";

export type ReviewStatus = "reviewing" | "approved" | "denied" | "aborted" | "timed-out" | "failed";

/**
 * The copy layer deliberately ignores review identity.  Identity is owned by
 * the lifecycle presenter, while this function only maps an outcome to copy.
 * `reviewId` stays optional so pure copy callers do not need to manufacture a
 * lifecycle record.
 */
export interface ReviewPresentationEvent {
  readonly reviewId?: string;
  readonly status: ReviewStatus;
  readonly rationale?: string;
  readonly reason?: string;
}

export type ReviewPresentation =
  | { kind: "silent" }
  | {
      kind: "notify";
      label: "Permission denied" | "Review timed out" | "Review failed";
      severity: "warning";
    };

export type PermissionNotice =
  | {
      kind: "review-circuit-interrupted";
      consecutiveDenials: number;
      recentDenials: number;
      windowSize: number;
    }
  | {
      kind: "reviewer-fallback";
      preferredProvider: string;
      preferredModel: string;
      activeProvider: string;
      activeModel: string;
    }
  | { kind: "approve-requires-mode" }
  | { kind: "approve-requires-ui" }
  | { kind: "approve-empty" }
  | { kind: "approve-stale" }
  | { kind: "shortcut-conflict" }
  | { kind: "configuration-invalid"; reason: string }
  | {
      kind: "sandbox-activation-failed";
      reason: string;
      recovery: "restored" | "unavailable";
    }
  | { kind: "mode-change-failed"; reason: string };

export interface PermissionSummary {
  mode: PermissionMode;
  sandbox: string;
  reviewer?: {
    kind: "preference" | "active";
    provider: string;
    model: string;
  };
  autoReviewAvailable: boolean;
  ruleCount: number;
  writeRoots: readonly string[];
}

export function permissionModeLabel(mode: PermissionMode): "Approve for me" | "Bypass permissions" {
  return mode === "auto" ? "Approve for me" : "Bypass permissions";
}

function renderFailureReason(reason: string): string {
  const timeout = /^timeout:(\d+(?:\.\d+)?)$/.exec(reason);
  if (timeout?.[1]) return `Timed out after ${timeout[1]} seconds.`;
  if (reason === "aborted") return "The operation was aborted.";
  return reason;
}

export function renderPermissionErrorForAgent(error: PermissionError): string {
  const reason = renderFailureReason(error.reason);
  const effectsMayHaveOccurred = error.effectsMayHaveOccurred === true;
  switch (error.code) {
    case "review-denied":
      return [
        "This action was rejected due to unacceptable risk.",
        `Reason: ${reason}`,
        ...(effectsMayHaveOccurred
          ? [
              "Execution had already started; earlier effects may have occurred. Do not replay it blindly.",
            ]
          : []),
        "The agent must not attempt to achieve the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and ask the user.",
      ].join("\n");
    case "review-timeout":
      if (effectsMayHaveOccurred) {
        return [
          "The automatic permission approval review timed out after execution had started.",
          `Reason: ${reason}`,
          "The execution was stopped, but earlier effects may have occurred. Inspect the result before considering any retry. Do not replay it blindly.",
        ].join("\n");
      }
      return "The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe based on the timeout alone. You may retry once, or ask the user for guidance or explicit approval.";
    case "review-unavailable":
      if (effectsMayHaveOccurred) {
        return [
          "Automatic approval review could not produce a decision after execution had started.",
          `Reason: ${reason}`,
          "The execution was stopped, but earlier effects may have occurred. Inspect the result before considering any retry. Do not replay it blindly.",
        ].join("\n");
      }
      return [
        "Automatic approval review could not produce a decision. The action was not run.",
        `Reason: ${reason}`,
        "Retry only if the failure appears transient; otherwise ask the user for guidance.",
      ].join("\n");
    case "policy-denied":
      return [
        "This action is blocked by the active permission policy.",
        `Reason: ${reason}`,
        ...(effectsMayHaveOccurred
          ? [
              "Execution had already started; earlier effects may have occurred. Do not replay it blindly.",
            ]
          : []),
        "This restriction cannot be overridden through Auto-review.",
      ].join("\n");
    case "policy-error":
      if (effectsMayHaveOccurred) {
        return `The active permission policy failed while execution was in progress. Earlier effects may have occurred; inspect the result before considering a retry.\nReason: ${reason}`;
      }
      return `The active permission policy could not evaluate this action. The action was not run.\nReason: ${reason}`;
    case "enforcement-unavailable":
      if (effectsMayHaveOccurred) {
        return `Sandbox enforcement could not verify the requested action after execution started. Earlier effects may have occurred; inspect the result before considering a retry.\nReason: ${reason}`;
      }
      return `Sandbox enforcement could not verify that the requested action stayed within the approved scope. The action was not run.\nReason: ${reason}`;
    case "permission-required":
      return [
        "Network permission is required for a later new invocation.",
        `Reason: ${reason}`,
        "Use request_permissions to request host authority. This execution is not expanded or automatically replayed; earlier effects may have occurred.",
      ].join("\n");
    case "runtime-denied":
      if (effectsMayHaveOccurred) {
        return [
          "Sandbox enforcement denied a capability during execution.",
          ...(error.retryAttempted === true
            ? [
                "One reviewed retry already ran and was also denied; no further automatic replay is available. Earlier effects may have occurred; inspect the result before considering any retry.",
              ]
            : [
                "Earlier effects may have occurred; inspect the result before considering any retry. Do not replay it blindly.",
              ]),
          `Reason: ${reason}`,
        ].join("\n");
      }
      return `Sandbox enforcement denied the requested capability. The action was not run.\nReason: ${reason}`;
    case "circuit-open":
      return "Automatic approval review is unavailable for this turn because too many approval requests were denied. Stop and ask the user before attempting another boundary-crossing action.";
    case "aborted":
      if (effectsMayHaveOccurred) {
        return "Permission handling was aborted after execution started. Earlier effects may have occurred; inspect the result before considering a retry.";
      }
      return "Permission handling was aborted before the action could run.";
    case "no-active-turn":
      return "No active permission turn is available. Retry in the active task.";
    case "stale-invocation":
      if (effectsMayHaveOccurred) {
        return "The permission context changed after execution started. Earlier effects may have occurred; inspect the result before considering a retry.";
      }
      return "The permission context changed before this action could run. Retry in the current task context.";
    case "concurrent-invocation":
      return "Another permission-controlled action is already in progress. Retry after it finishes.";
    case "execution-failed":
      return effectsMayHaveOccurred
        ? `The permitted action failed during execution. Earlier effects may have occurred; inspect the result before considering any retry.\nReason: ${reason}`
        : `The permitted action failed during execution.\nReason: ${reason}`;
  }
}

export function projectReviewEvent(event: ReviewPresentationEvent): ReviewPresentation {
  switch (event.status) {
    case "reviewing":
      return { kind: "silent" };
    case "approved":
      return { kind: "silent" };
    case "denied":
      return { kind: "notify", label: "Permission denied", severity: "warning" };
    case "aborted":
      return { kind: "silent" };
    case "timed-out":
      return { kind: "notify", label: "Review timed out", severity: "warning" };
    case "failed":
      return { kind: "notify", label: "Review failed", severity: "warning" };
  }
}

export function renderPermissionNotice(notice: PermissionNotice): string {
  switch (notice.kind) {
    case "review-circuit-interrupted":
      return `Automatic approval review rejected too many approval requests for this turn (${notice.consecutiveDenials} consecutive, ${notice.recentDenials} in the last ${notice.windowSize} reviews); interrupting the turn.`;
    case "reviewer-fallback":
      return `Configured reviewer ${notice.preferredProvider}/${notice.preferredModel} is unavailable. Auto-review will use ${notice.activeProvider}/${notice.activeModel}.`;
    case "approve-requires-mode":
      return "/approve is available only with Approve for me.";
    case "approve-requires-ui":
      return "/approve requires an interactive UI.";
    case "approve-empty":
      return "No recent Auto-review denials in this task.";
    case "approve-stale":
      return "That Auto-review denial is no longer available.";
    case "shortcut-conflict":
      return "Shift+Tab is still assigned to app.thinking.cycle. Update ~/.pi/agent/keybindings.json, then run /reload.";
    case "configuration-invalid":
      return `Permission configuration is invalid: ${notice.reason}`;
    case "sandbox-activation-failed":
      return notice.recovery === "restored"
        ? `Sandbox activation failed. The previous sandbox remains active.\nReason: ${renderFailureReason(notice.reason)}`
        : `Sandbox activation failed, and the previous sandbox could not be restored. Sandboxed execution is unavailable.\nReason: ${renderFailureReason(notice.reason)}`;
    case "mode-change-failed":
      return `Permission mode change failed. The previous mode remains active.\nReason: ${renderFailureReason(notice.reason)}`;
  }
}

export function renderPermissionSummary(summary: PermissionSummary): string {
  if (summary.mode === "yolo") return "Bypass permissions · sandbox off · approvals off";
  const reviewer = summary.reviewer
    ? `${summary.reviewer.kind === "active" ? "active reviewer" : "reviewer preference"}: ${summary.reviewer.provider}/${summary.reviewer.model}`
    : "reviewer preference: current session model";
  const autoReview = summary.autoReviewAvailable
    ? "Auto-review available"
    : "Auto-review unavailable for this turn";
  const writeRoots = summary.writeRoots.length > 0 ? summary.writeRoots.join(", ") : "none";
  return `${permissionModeLabel(summary.mode)} · ${summary.sandbox} · ${autoReview} · ${reviewer} · ${summary.ruleCount} rules · write roots: ${writeRoots}`;
}

export function renderExactRetryInstruction(input: {
  tool: string;
  serializedInput: string;
  cwd: string;
  previousDenial: string;
}): string {
  return [
    "The user authorized one exact retry of the action below. Retry it exactly once without broadening or altering it. The retry still requires Auto-review and may be denied again.",
    `Tool: ${input.tool}`,
    `Input: ${input.serializedInput}`,
    `Working directory: ${input.cwd}`,
    `Previous denial: ${input.previousDenial}`,
  ].join("\n");
}
