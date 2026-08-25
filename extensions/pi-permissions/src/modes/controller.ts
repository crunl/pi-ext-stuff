import type { PermissionMode } from "../state.ts";

const cycleOrder: PermissionMode[] = ["auto", "yolo"];

export class ModeController {
  private activeMode: PermissionMode;

  constructor(initialMode: PermissionMode) {
    this.activeMode = initialMode;
  }

  get active(): PermissionMode {
    return this.activeMode;
  }

  request(mode: PermissionMode): PermissionMode {
    this.activeMode = mode;
    return this.activeMode;
  }

  cycle(): PermissionMode {
    const currentIndex = cycleOrder.indexOf(this.activeMode);
    const nextMode = cycleOrder[(currentIndex + 1) % cycleOrder.length] as PermissionMode;
    return this.request(nextMode);
  }
}
