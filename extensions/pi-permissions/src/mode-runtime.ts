import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import {
  type AutoState,
  recordAutoApproval,
  recordAutoDenial,
  resetAutoState,
} from "./modes/auto.ts";
import {
  ModeController,
  type ModeTransition,
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
  if (normalized.pendingMode === "plan") normalized.pendingMode = undefined;
  return normalized;
}

export class PermissionModeRuntime {
  private controller: ModeController;
  private state: PermissionSessionState;
  private readonly activeReviewIds = new Set<string>();
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

  activate(
    mode: PermissionMode,
    context: { idle: boolean },
  ): PermissionMode | ModeTransition {
    if (mode === "plan") throw new Error("Plan mode is not implemented");
    const result = this.controller.request(mode, {
      ...context,
      approvalActive: this.approvalActive,
    });
    if (typeof result === "string") {
      this.state.mode = result;
      this.state.pendingMode = undefined;
      if (result === "auto") this.state.auto = resetAutoState();
    } else {
      this.state.pendingMode = result.pending;
    }
    this.persist();
    return result;
  }

  cycle(context: { idle: boolean }): PermissionMode | ModeTransition {
    const result = this.controller.cycle({
      ...context,
      approvalActive: this.approvalActive,
    });
    if (typeof result === "string") {
      this.state.mode = result;
      this.state.pendingMode = undefined;
      if (result === "auto") this.state.auto = resetAutoState();
    } else {
      this.state.pendingMode = result.pending;
    }
    this.persist();
    return result;
  }

  flushPending(context: { idle: boolean }): PermissionMode {
    const previous = this.controller.active;
    const active = this.controller.flushPending({
      ...context,
      approvalActive: this.approvalActive,
    });
    if (active !== previous && active === "auto") this.state.auto = resetAutoState();
    this.state.mode = active;
    this.state.pendingMode = this.controller.pending;
    this.persist();
    return active;
  }

  applyAutoState(state: AutoState): void {
    this.state.auto = structuredClone(state);
    this.persist();
  }

  recordAutoReview(
    decision: "approve" | "deny",
    denialLimit: number,
  ): AutoState {
    this.state.auto = decision === "approve"
      ? recordAutoApproval(this.state.auto)
      : recordAutoDenial(this.state.auto, denialLimit);
    this.persist();
    return this.autoState;
  }

  restore(entries: readonly unknown[], config: PermissionsConfig): void {
    this.state = functionalState(restorePermissionState(entries, config));
    this.controller = new ModeController(this.state.mode, this.state.pendingMode);
    this.activeReviewIds.clear();
    this.humanApprovalActive = false;
  }

  snapshot(): PermissionSessionState {
    return structuredClone(this.state);
  }

  private persist(): void {
    this.appendEntry("pi-permissions-state", this.snapshot());
  }
}
