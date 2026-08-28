import type { PermissionError } from "./approve-for-me-engine.ts";
import type { PermissionMode } from "./state.ts";

export type ReviewPresentationEvent =
  | { status: "reviewing" }
  | { status: "approved" | "denied"; rationale: string }
  | { status: "aborted" | "timed-out" }
  | { status: "failed"; reason: string };

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

export function permissionModeLabel(mode: PermissionMode): "Approve for me" | "Full access" {
  return mode === "auto" ? "Approve for me" : "Full access";
}

function renderFailureReason(reason: string): string {
  const timeout = /^timeout:(\d+(?:\.\d+)?)$/.exec(reason);
  if (timeout?.[1]) return `Timed out after ${timeout[1]} seconds.`;
  if (reason === "aborted") return "The operation was aborted.";
  return reason;
}

export function renderPermissionErrorForAgent(error: PermissionError): string {
  const reason = renderFailureReason(error.reason);
  switch (error.code) {
    case "review-denied":
      return [
        "This action was rejected due to unacceptable risk.",
        `Reason: ${reason}`,
        "The agent must not attempt to achieve the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and ask the user.",
      ].join("\n");
    case "review-timeout":
      return "The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe based on the timeout alone. You may retry once, or ask the user for guidance or explicit approval.";
    case "review-unavailable":
      return [
        "Automatic approval review could not produce a decision. The action was not run.",
        `Reason: ${reason}`,
        "Retry only if the failure appears transient; otherwise ask the user for guidance.",
      ].join("\n");
    case "policy-denied":
      return [
        "This action is blocked by the active permission policy.",
        `Reason: ${reason}`,
        "This restriction cannot be overridden through Auto-review.",
      ].join("\n");
    case "policy-error":
      return `The active permission policy could not evaluate this action. The action was not run.\nReason: ${reason}`;
    case "enforcement-unavailable":
      return `Sandbox enforcement could not verify that the requested action stayed within the approved scope. The action was not run.\nReason: ${reason}`;
    case "runtime-denied":
      return `Sandbox enforcement denied the requested capability. The action was not run.\nReason: ${reason}`;
    case "retry-denied":
      return `The exact retry authorization is no longer valid. The action was not run.\nReason: ${reason}`;
    case "retry-uncertain":
      return `The exact retry could not be verified safely. The action was not run.\nReason: ${reason}`;
    case "circuit-open":
      return "Automatic approval review is unavailable for this turn because too many approval requests were denied. Stop and ask the user before attempting another boundary-crossing action.";
    case "aborted":
      return "Permission handling was aborted before the action could run.";
    case "no-active-turn":
      return "No active permission turn is available. Retry in the active task.";
    case "stale-invocation":
      return "The permission context changed before this action could run. Retry in the current task context.";
    case "concurrent-invocation":
      return "Another permission-controlled action is already in progress. Retry after it finishes.";
    case "execution-failed":
      return `The permitted action failed during execution.\nReason: ${reason}`;
  }
}

export function renderReviewEvent(event: ReviewPresentationEvent): string {
  switch (event.status) {
    case "reviewing":
      return "Reviewing";
    case "approved":
      return `Automatic approval review approved: ${event.rationale}`;
    case "denied":
      return `Automatic approval review denied: ${event.rationale}`;
    case "aborted":
      return "Automatic approval review was aborted.";
    case "timed-out":
      return "Automatic approval review timed out while evaluating the requested approval.";
    case "failed":
      return `Automatic approval review failed: ${event.reason}`;
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
  if (summary.mode === "yolo") return "Full access · sandbox off · approvals off";
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
