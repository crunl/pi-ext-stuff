import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionsConfig } from "./config.ts";
import { ModeController } from "./modes/controller.ts";
import {
  createPermissionSessionState,
  type PermissionMode,
  type PermissionSessionState,
  restorePermissionState,
} from "./state.ts";

type AutoState = PermissionSessionState["auto"];

function functionalState(state: PermissionSessionState): PermissionSessionState {
  const normalized = structuredClone(state);
  delete (normalized as PermissionSessionState & { pendingMode?: PermissionMode }).pendingMode;
  return normalized;
}

export interface PermissionModeActivationOptions {
  preserveAutoTransientState?: boolean;
}

/** Engine-owned breaker state accepted at the persistence seam. */
export interface AutoStateInput {
  consecutiveDenials: number;
  paused: boolean;
  recentDenials?: number;
}

function freshAutoState(): AutoState {
  return { consecutiveDenials: 0, paused: false };
}

export class PermissionModeRuntime {
  private controller: ModeController;
  private state: PermissionSessionState;

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

  get statusLabel(): "Approve for me" | "Full bypass" {
    return this.mode === "auto" ? "Approve for me" : "Full bypass";
  }

  /**
   * Badge severity for status consumers (e.g. statusline): "warning" marks
   * guardian-reviewed execution, "error" marks unreviewed execution. Consumers
   * must key behavior off this field, not off the human-readable label.
   */
  get statusSeverity(): "warning" | "error" {
    return this.mode === "auto" ? "warning" : "error";
  }

  activate(
    mode: PermissionMode,
    { preserveAutoTransientState = false }: PermissionModeActivationOptions = {},
  ): PermissionMode {
    const result = this.controller.request(mode);
    this.state.mode = result;
    if (!preserveAutoTransientState && result === "auto") this.state.auto = freshAutoState();
    this.persist();
    return result;
  }

  cycle(): PermissionMode {
    const result = this.controller.cycle();
    this.state.mode = result;
    if (result === "auto") this.state.auto = freshAutoState();
    this.persist();
    return result;
  }

  applyAutoState(state: AutoStateInput): void {
    this.state.auto = {
      consecutiveDenials: state.consecutiveDenials,
      paused: state.paused,
    };
    this.persist();
  }

  beginAgentTurn(): void {
    if (this.state.auto.consecutiveDenials === 0 && !this.state.auto.paused) {
      return;
    }
    this.state.auto = freshAutoState();
    this.persist();
  }

  restore(entries: readonly unknown[], config: PermissionsConfig): void {
    this.state = functionalState(restorePermissionState(entries, config));
    this.controller = new ModeController(this.state.mode);
  }

  snapshot(): PermissionSessionState {
    return structuredClone(this.state);
  }

  private persist(): void {
    this.appendEntry("pi-permissions-state", this.snapshot());
  }
}
