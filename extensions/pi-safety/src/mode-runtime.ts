import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SafetyConfig } from "./config.ts";
import { permissionModeLabel } from "./permission-copy.ts";
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
  private state: PermissionSessionState;

  constructor(
    config: SafetyConfig,
    private readonly appendEntry: ExtensionAPI["appendEntry"],
  ) {
    this.state = functionalState(createPermissionSessionState(config));
  }

  get mode(): PermissionMode {
    return this.state.mode;
  }

  get autoState(): AutoState {
    return structuredClone(this.state.auto);
  }

  get statusLabel(): "Approve for me" | "Bypass permissions" {
    return permissionModeLabel(this.mode);
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
    this.state.mode = mode;
    if (!preserveAutoTransientState && mode === "auto") this.state.auto = freshAutoState();
    this.persist();
    return mode;
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

  restore(entries: readonly unknown[], config: SafetyConfig): void {
    this.state = functionalState(restorePermissionState(entries, config));
  }

  snapshot(): PermissionSessionState {
    return structuredClone(this.state);
  }

  private persist(): void {
    this.appendEntry("pi-safety-state", this.snapshot());
  }
}
