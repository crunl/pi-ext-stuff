import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import {
  GUARDIAN_DENIAL_WINDOW_SIZE,
  MAX_CONSECUTIVE_GUARDIAN_DENIALS,
  MAX_RECENT_GUARDIAN_DENIALS,
} from "./guardian-policy.ts";
import {
  type AutoState,
  recordAutoApproval,
  recordAutoDenial,
  resetAutoState,
} from "./modes/auto.ts";
import {
  ModeController,
} from "./modes/controller.ts";
import {
  createPermissionSessionState,
  type PermissionMode,
  type PermissionSessionState,
  restorePermissionState,
} from "./state.ts";

function functionalState(state: PermissionSessionState): PermissionSessionState {
  const normalized = structuredClone(state);
  if (normalized.mode === "plan") normalized.mode = "default";
  delete (normalized as PermissionSessionState & { pendingMode?: PermissionMode }).pendingMode;
  return normalized;
}

export class PermissionModeRuntime {
  private controller: ModeController;
  private state: PermissionSessionState;
  private readonly activeReviewIds = new Set<string>();
  private readonly autoReviewWindow: boolean[] = [];
  private humanApprovalActive = false;

  constructor(
    config: PermissionsConfig,
    private readonly appendEntry: ExtensionAPI["appendEntry"],
  ) {
    this.state = functionalState(createPermissionSessionState(config));
    this.controller = new ModeController(this.state.mode);
  }

  get mode(): PermissionMode {
    return this.controller.active;
  }

  get autoState(): AutoState {
    return structuredClone(this.state.auto);
  }

  get approvalActive(): boolean {
    return this.humanApprovalActive || this.activeReviewIds.size > 0;
  }

  get statusLabel(): "Default" | "Auto" {
    if (this.mode === "default") return "Default";
    if (this.mode === "auto") return "Auto";
    throw new Error("Plan mode is not implemented");
  }

  beginReview(toolCallId: string): boolean {
    if (this.activeReviewIds.has(toolCallId)) return false;
    this.activeReviewIds.add(toolCallId);
    return true;
  }

  endReview(toolCallId: string): void {
    this.activeReviewIds.delete(toolCallId);
  }

  cancelReviews(): void {
    this.activeReviewIds.clear();
  }

  beginHumanApproval(): boolean {
    if (this.humanApprovalActive) return false;
    this.humanApprovalActive = true;
    return true;
  }

  endHumanApproval(): void {
    this.humanApprovalActive = false;
  }

  activate(mode: PermissionMode): PermissionMode {
    if (mode === "plan") throw new Error("Plan mode is not implemented");
    const result = this.controller.request(mode);
    this.state.mode = result;
    this.autoReviewWindow.length = 0;
    if (result === "auto") this.state.auto = resetAutoState();
    this.persist();
    return result;
  }

  cycle(): PermissionMode {
    const result = this.controller.cycle();
    this.state.mode = result;
    this.autoReviewWindow.length = 0;
    if (result === "auto") this.state.auto = resetAutoState();
    this.persist();
    return result;
  }

  applyAutoState(state: AutoState): void {
    this.state.auto = structuredClone(state);
    this.persist();
  }

  beginAgentTurn(): void {
    this.autoReviewWindow.length = 0;
    if (this.mode !== "auto") return;
    if (
      this.state.auto.consecutiveDenials === 0
      && !this.state.auto.paused
    ) {
      return;
    }
    this.state.auto = resetAutoState();
    this.persist();
  }

  recordAutoNonDenial(): void {
    this.recordAutoReviewOutcome(false);
    if (this.state.auto.consecutiveDenials === 0) return;
    this.state.auto.consecutiveDenials = 0;
    this.persist();
  }

  recordAutoReview(decision: "approve" | "deny"): AutoState {
    this.recordAutoReviewOutcome(decision === "deny");
    this.state.auto = decision === "approve"
      ? recordAutoApproval(this.state.auto)
      : recordAutoDenial(this.state.auto, MAX_CONSECUTIVE_GUARDIAN_DENIALS);
    if (
      decision === "deny"
      && this.autoReviewWindow.filter(Boolean).length >= MAX_RECENT_GUARDIAN_DENIALS
    ) {
      this.state.auto.paused = true;
    }
    this.persist();
    return this.autoState;
  }

  restore(entries: readonly unknown[], config: PermissionsConfig): void {
    this.state = functionalState(restorePermissionState(entries, config));
    this.controller = new ModeController(this.state.mode);
    this.activeReviewIds.clear();
    this.autoReviewWindow.length = 0;
    this.humanApprovalActive = false;
  }

  snapshot(): PermissionSessionState {
    return structuredClone(this.state);
  }

  private persist(): void {
    this.appendEntry("pi-permissions-state", this.snapshot());
  }

  private recordAutoReviewOutcome(denied: boolean): void {
    this.autoReviewWindow.push(denied);
    if (this.autoReviewWindow.length > GUARDIAN_DENIAL_WINDOW_SIZE) {
      this.autoReviewWindow.splice(0, this.autoReviewWindow.length - GUARDIAN_DENIAL_WINDOW_SIZE);
    }
  }
}
