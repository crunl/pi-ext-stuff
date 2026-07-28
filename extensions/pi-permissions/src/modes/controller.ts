import type { PermissionMode } from "../state.ts";

export interface ModeTransitionContext {
  idle: boolean;
  approvalActive?: boolean;
}

export interface ModeTransition {
  active: PermissionMode;
  pending?: PermissionMode;
}

const cycleOrder: PermissionMode[] = ["default", "plan", "auto"];

export class ModeController {
  private activeMode: PermissionMode;
  private pendingMode: PermissionMode | undefined;

  constructor(initialMode: PermissionMode) {
    this.activeMode = initialMode;
  }

  get active(): PermissionMode {
    return this.activeMode;
  }

  get pending(): PermissionMode | undefined {
    return this.pendingMode;
  }

  request(mode: PermissionMode, context: ModeTransitionContext): PermissionMode | ModeTransition {
    if (context.approvalActive) throw new Error("Cannot change permission mode during approval");
    if (!context.idle) {
      this.pendingMode = mode;
      return { active: this.activeMode, pending: mode };
    }
    this.activeMode = mode;
    this.pendingMode = undefined;
    return this.activeMode;
  }

  cycle(context: ModeTransitionContext): PermissionMode | ModeTransition {
    const currentIndex = cycleOrder.indexOf(this.activeMode);
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
