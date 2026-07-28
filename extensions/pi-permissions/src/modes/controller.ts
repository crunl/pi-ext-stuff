import type { PermissionMode } from "../state.ts";

export interface ModeTransitionContext {
  idle: boolean;
  approvalActive?: boolean;
}

export interface ModeTransition {
  active: PermissionMode;
  pending?: PermissionMode;
}

const cycleOrder: PermissionMode[] = ["default", "auto"];

export class ModeController {
  private activeMode: PermissionMode;
  private pendingMode: PermissionMode | undefined;

  constructor(initialMode: PermissionMode, pendingMode?: PermissionMode) {
    this.activeMode = initialMode;
    this.pendingMode = pendingMode === initialMode ? undefined : pendingMode;
  }

  get active(): PermissionMode {
    return this.activeMode;
  }

  get pending(): PermissionMode | undefined {
    return this.pendingMode;
  }

  request(mode: PermissionMode, context: ModeTransitionContext): PermissionMode | ModeTransition {
    if (!context.idle) {
      this.pendingMode = mode === this.activeMode ? undefined : mode;
      return { active: this.activeMode, pending: this.pendingMode };
    }
    if (context.approvalActive) throw new Error("Cannot change permission mode during approval");
    this.activeMode = mode;
    this.pendingMode = undefined;
    return this.activeMode;
  }

  cycle(context: ModeTransitionContext): PermissionMode | ModeTransition {
    const effectiveMode = this.pendingMode ?? this.activeMode;
    const currentIndex = cycleOrder.indexOf(effectiveMode);
    const nextMode = cycleOrder[(currentIndex + 1) % cycleOrder.length] as PermissionMode;
    return this.request(nextMode, context);
  }

  flushPending(context: ModeTransitionContext): PermissionMode {
    if (!context.idle || context.approvalActive) return this.activeMode;
    if (this.pendingMode !== undefined) {
      this.activeMode = this.pendingMode;
      this.pendingMode = undefined;
    }
    return this.activeMode;
  }
}
